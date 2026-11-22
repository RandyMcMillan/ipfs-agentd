/* ipfs-agentd — tool implementations, transport-agnostic.
 *
 * Every function takes the started node context ({ helia, node, ufs, ipns })
 * plus plain JSON args and returns plain JSON. The MCP server in
 * mcp-server.js is a thin schema wrapper over these.
 *
 * Base64 is used for all binary payloads (MCP transports are JSON).
 */
import { CID } from 'multiformats/cid'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPublicKey } from '@libp2p/peer-id'

const MAX_CAT_BYTES = 32 * 1024 * 1024   // refuse to stream >32 MiB into one JSON response

function parseCid (str) {
  try { return CID.parse(str) } catch { throw new Error('invalid CID: ' + str) }
}

function toB64 (u8) { return Buffer.from(u8).toString('base64') }
function fromB64 (s) { return new Uint8Array(Buffer.from(s, 'base64')) }

/* pins.add / pins.rm are ASYNC GENERATORS — they only execute when consumed.
 * drive them to completion with one shared drain. */
async function drainPin (gen) {
  for await (const _ of gen) { /* exhaust */ }
}

/* ---------------- identity / status ---------------- */

export async function ipfsId (ctx) {
  return {
    peerId: ctx.node.peerId.toString(),
    agent: 'ipfs-agentd/0.1.0',
    listenAddrs: ctx.node.getMultiaddrs().map((a) => a.toString()),
    connections: ctx.node.getConnections().length,
    peers: ctx.node.getPeers().length,
    repoPath: ctx.repoPath
  }
}

/* ---------------- files (unixfs) ---------------- */

export async function ipfsAdd (ctx, { contentBase64, name }) {
  const bytes = fromB64(contentBase64)
  const cid = await ctx.ufs.addBytes(bytes)
  /* pin everything an agent adds — a daemon that forgets by default is useless */
  await drainPin(ctx.helia.pins.add(parseCid(cid.toString())))
  return { cid: cid.toString(), size: bytes.length, name: name ?? null, pinned: true }
}

export async function ipfsAddAll (ctx, { files }) {
  /* files: [{ path: 'dir/sub/file.txt', contentBase64 }] → UnixFS directory CID.
   * strings, not CID objects: several multiformats copies coexist in the dep
   * tree, so instanceof checks across packages fail — every helia API accepts
   * CID strings and parses them with its own copy. */
  const entries = files.map((f) => ({
    path: f.path,
    content: fromB64(f.contentBase64)
  }))
  let root = null
  for await (const result of ctx.ufs.addAll(entries)) root = result
  if (!root) throw new Error('no files given')
  await drainPin(ctx.helia.pins.add(parseCid(root.cid.toString())))
  return { cid: root.cid.toString(), pinned: true, count: files.length }
}

export async function ipfsCat (ctx, { cid, offset = 0, length }) {
  parseCid(cid)   /* validate early, then hand the string to unixfs */
  const chunks = []
  let total = 0
  const limit = length ?? MAX_CAT_BYTES
  for await (const chunk of ctx.ufs.cat(cid, { offset, length: limit })) {
    chunks.push(chunk)
    total += chunk.length
    if (total >= MAX_CAT_BYTES) throw new Error('content exceeds 32 MiB single-response cap — use offset/length')
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { base64: buf.toString('base64'), size: buf.length, cid }
}

export async function ipfsStat (ctx, { cid }) {
  parseCid(cid)
  /* extended: true traverses the DAG — needed for dagSize/blocks (network ops possible) */
  const st = await ctx.ufs.stat(cid, { extended: true })
  return {
    cid,
    type: st.type,
    size: st.size?.toString() ?? null,
    dagSize: st.dagSize?.toString() ?? null,
    cumulativeSize: st.cumulativeSize?.toString() ?? null,
    blocks: st.blocks != null ? st.blocks.toString() : null
  }
}

/* ---------------- pins ---------------- */

export async function ipfsPinAdd (ctx, { cid }) {
  parseCid(cid)
  await drainPin(ctx.helia.pins.add(parseCid(cid)))
  return { cid, pinned: true }
}

export async function ipfsPinRm (ctx, { cid }) {
  parseCid(cid)
  await drainPin(ctx.helia.pins.rm(parseCid(cid)))
  return { cid, pinned: false }
}

export async function ipfsPinLs (ctx) {
  const pins = []
  for await (const pin of ctx.helia.pins.ls()) pins.push(pin.cid.toString())
  return { pins, count: pins.length }
}

/* ---------------- resolution ---------------- */

export async function ipfsResolve (ctx, { path }) {
  /* try CID first (ipfs://, /ipfs/, or bare), then IPNS name */
  const cleaned = path.replace(/^(ipfs|ipns):\/\//, '').replace(/^\/(ipfs|ipns)\//, '')
  try {
    return { path, value: CID.parse(cleaned).toString() }
  } catch {
    /* not a CID → treat as an IPNS name (PeerId or base36 key) */
    const result = await ctx.ipns.resolve(cleaned)
    return { path, value: result.cid ? result.cid.toString() : result.toString() }
  }
}

/* ---------------- pubsub (gnostr-compatible) ---------------- */

/* pull-based subscription: messages queue in memory per topic; agents poll.
 * subscribe-on-first-pull keeps MCP request/response semantics. */
const topicQueues = new Map()
const topicHandlers = new Map()

function ensureSubscribed (ctx, topic) {
  if (topicHandlers.has(topic)) return
  ctx.node.services.pubsub.subscribe(topic)
  const handler = (evt) => {
    if (evt.detail.topic !== topic) return
    if (!topicQueues.has(topic)) topicQueues.set(topic, [])
    const q = topicQueues.get(topic)
    if (q.length >= 1000) q.shift()   /* bounded; an agent that never pulls shouldn't OOM the daemon */
    q.push({ from: evt.detail.from.toString(), dataBase64: toB64(evt.detail.data), at: Date.now() })
  }
  ctx.node.services.pubsub.addEventListener('message', handler)
  topicHandlers.set(topic, handler)
}

export async function ipfsPubsubPublish (ctx, { topic = 'gnostr', dataBase64 }) {
  await ctx.node.services.pubsub.publish(topic, fromB64(dataBase64))
  return { topic, published: true, peers: ctx.node.services.pubsub.getPeers().length }
}

export async function ipfsPubsubPull (ctx, { topic = 'gnostr', max = 100 }) {
  ensureSubscribed(ctx, topic)
  const q = topicQueues.get(topic) ?? []
  const drained = q.splice(0, Math.min(max, q.length))
  return { topic, messages: drained, remaining: q.length, subscribed: true }
}

/* ---------------- IPNS publishing ---------------- */

/* publish a CID under a fresh Ed25519 IPNS key; returns the key's PeerId,
 * which is also the IPNS name. one-shot for phase 1 — named key reuse lands
 * with key management. */
export async function ipfsNamePublish (ctx, { cid }) {
  parseCid(cid)
  const key = await generateKeyPair('Ed25519')
  await ctx.ipns.publish(key, parseCid(cid))
  /* the IPNS name is the key's PeerId (Ed25519 → identity multihash) */
  const peerId = peerIdFromPublicKey(key.publicKey)
  return { name: peerId.toString(), value: cid, note: 'one-shot key — save the name; the private key is not persisted yet' }
}
