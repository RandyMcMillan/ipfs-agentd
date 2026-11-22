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
 * drive them to completion with one shared drain. Re-pinning an already-pinned
 * CID throws AlreadyPinnedError mid-stream; that state is the goal, so swallow it. */
async function drainPin (gen) {
  try {
    for await (const _ of gen) { /* exhaust */ }
  } catch (err) {
    if (!/already pinned/i.test(String(err?.message || err))) throw err
  }
}

/* ---------------- identity / status ---------------- */

export async function ipfsId (ctx) {
  return {
    peerId: ctx.node.peerId.toString(),
    agent: 'ipfs-agentd/0.3.1',
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

/* ---------------- git bridge (gnostr-compatible) ----------------
 *
 * Wire format shared with helia-ipfs-relay's gnostr tools:
 *   { type:'git', name, at:<epoch ms>, bundle:<CID>, addrs?:[<multiaddr>] }
 * Publishers: git_publish_repo here, gnostr-publish.js, the web app.
 * Consumers:  git_fetch_bundle here, git-remote-gnostr.js.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, accessSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve as resolvePath } from 'node:path'

function runGit (args) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error('git ' + args[0] + ' exited ' + code + (err ? ': ' + err.trim() : ''))))
  })
}

/* publish a local git repo on the gnostr topic: bundle --all → IPFS → pin → ad.
 * KEEP THE DAEMON ALIVE after publishing — like gnostr-publish.js, this node is
 * the bitswap seeder; stop it and the bundle is only fetchable if someone else
 * pinned the CID. */
export async function gitPublishRepo (ctx, { repoPath, name, topic = 'gnostr' }) {
  const dir = resolvePath(repoPath)
  await accessSync(join(dir, '.git'))   /* fail early with a clear message */
  const tmp = mkdtempSync(join(tmpdir(), 'ipfs-agentd-bundle-'))
  const bundlePath = join(tmp, 'repo.bundle')
  try {
    await runGit(['-C', dir, 'bundle', 'create', bundlePath, '--all'])
    const bytes = readFileSync(bundlePath)
    const cid = await ctx.ufs.addBytes(bytes)
    await drainPin(ctx.helia.pins.add(parseCid(cid.toString())))
    const ad = { type: 'git', name, at: Date.now(), bundle: cid.toString() }
    const addrs = ctx.node.getMultiaddrs().map((a) => a.toString())
    if (addrs.length > 0) ad.addrs = addrs
    let published = true
    let note = null
    try {
      await ctx.node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(ad)))
    } catch (err) {
      /* gossipsub refuses to publish with no mesh peers — the bundle is still on
       * IPFS and pinned; the ad can be republished once peers connect (gnostr-publish
       * swallows this same error and relies on its next interval tick) */
      published = false
      note = 'ad not published: ' + (err?.message || err)
    }
    return { name, bundle: cid.toString(), size: bytes.length, topic, published, note, peers: ctx.node.getPeers().length, cloneHint: 'git clone gnostr://cid/' + cid.toString() }
  } finally {
    rmSyncSafe(tmp)
  }
}

function rmSyncSafe (p) { try { rmSync(p, { recursive: true, force: true }) } catch { /* best effort */ } }

/* fetch a git bundle: gnostr://cid/<CID> skips discovery; gnostr://<name> (or a
 * bare name) listens on the topic for the newest matching ad — bundle ads win
 * over url ads, mirroring git-remote-gnostr. url-only ads are rejected with a
 * pointer to plain `git clone`, since the bundle bytes aren't on IPFS. */
export async function gitFetchBundle (ctx, { source, outPath, topic = 'gnostr', timeoutMs = 30000 }) {
  const src = source.replace(/^gnostr:\/\//, '')
  let bundleCid = null
  if (src.startsWith('cid/')) {
    bundleCid = src.slice('cid/'.length)
  } else {
    bundleCid = await new Promise((resolvePromise, reject) => {
      const wanted = src
      let best = null
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('no git ad for "' + wanted + '" on topic "' + topic + '" within ' + timeoutMs + 'ms'))
      }, timeoutMs)
      const onMessage = (evt) => {
        if (evt.detail.topic !== topic) return
        let ad
        try { ad = JSON.parse(new TextDecoder().decode(evt.detail.data)) } catch { return }
        if (ad.type !== 'git' || ad.name !== wanted) return
        if (ad.bundle == null && ad.url == null) return
        if (best == null || ad.at > best.at) best = ad
        if (best.bundle != null) { cleanup(); resolvePromise(best.bundle) }   /* bundle preferred; don't wait out the clock */
      }
      const cleanup = () => {
        clearTimeout(timer)
        ctx.node.services.pubsub.removeEventListener('message', onMessage)
        ctx.node.services.pubsub.unsubscribe(topic)
      }
      ctx.node.services.pubsub.subscribe(topic)
      ctx.node.services.pubsub.addEventListener('message', onMessage)
      /* ads already queued via ipfs_pubsub_pull count too — newest wins */
      const queued = (topicQueues.get(topic) ?? []).map((m) => {
        try { return JSON.parse(Buffer.from(m.dataBase64, 'base64').toString()) } catch { return null }
      }).filter((a) => a?.type === 'git' && a.name === wanted)
      const newest = queued.sort((a, b) => b.at - a.at)[0]
      if (newest?.bundle != null) { cleanup(); resolvePromise(newest.bundle) }
      else if (newest?.url != null) {
        cleanup()
        reject(new Error('newest ad for "' + wanted + '" is a url ad (' + newest.url + ') — clone it with plain git; no bundle on IPFS'))
      }
    })
  }
  /* fetch + save */
  const chunks = []
  for await (const chunk of ctx.ufs.cat(bundleCid)) chunks.push(chunk)
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  if (buf.subarray(0, 16).toString() !== '# v2 git bundle\n') {
    throw new Error('fetched ' + bundleCid + ' but it is not a git bundle (magic bytes mismatch)')
  }
  const dest = resolvePath(outPath)
  writeFileSync(dest, buf)
  return { bundle: bundleCid, outPath: dest, size: buf.length, verifyHint: 'git bundle verify ' + dest }
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
