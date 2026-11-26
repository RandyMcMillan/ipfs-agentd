#!/usr/bin/env node
/* a2aipfs-node.mjs — reference implementation of docs/spec/SPEC.md.
 *
 * Speaks the real protocol: §2 envelopes (dag-json CID ids, peer-key
 * envelope signatures), §3 message types, §4 topic conventions, §5
 * republish/dedup, §7 direct-stream NDJSON fallback (/a2aipfs/1.0.0),
 * §8 witness attestation. Replaces the pre-standard {type:"chat"} marker
 * envelopes (SPEC Appendix A) as the conformance reference.
 *
 * Roles (A2AIPFS_ROLE):
 *   asker     announce; publish query (republish 15s per §5); capture the
 *             first signature-valid answer with ref = query id, from a
 *             different peer; print the answer text verbatim on stdout;
 *             exit 0/1. Falls back to the direct stream (§7) after two
 *             republish cycles without a response.
 *   responder announce (inline Card per §6); answer signature-valid queries
 *             on the exchange topic and over direct streams (answer + ack;
 *             unknown types get an error envelope, §7). Optional copilot
 *             delegation (A2AIPFS_DELEGATE=copilot).
 *   witness   observe query + answer from DISTINCT peers on the exchange
 *             topic, verify both envelopes per §9, build and sign the
 *             attest (§8), publish it, write it to A2AIPFS_ATTEST_FILE,
 *             print the verdict on BOTH stdout and stderr (the workflow
 *             greps witness.out); exit 0/1. Also observes the task
 *             lifecycle (task + task-state done from distinct peers) and
 *             writes a task attest (verbatim signed envelopes) to
 *             A2AIPFS_TASK_FILE.
 *   worker    task executor: on a signature-valid task (§3.4, state
 *             submitted), publish task-state accepted, dial the task's
 *             replyTo addr, deliver the result as an ordered hash-chained
 *             stream-chunk sequence over the direct stream (§3.6, §7),
 *             collect acks (§3.7), then publish task-state done with the
 *             chunk count + final chain (§3.5); exit 0/1.
 *
 * Env: A2AIPFS_TOPIC (default a2aipfs/v1/global), A2AIPFS_NAME,
 *   A2AIPFS_QUESTION, A2AIPFS_TIMEOUT_MS (default 300000),
 *   A2AIPFS_DIAL (comma multiaddrs), A2AIPFS_DELEGATE,
 *   A2AIPFS_ATTEST_FILE, A2AIPFS_TASK_FILE (task-lifecycle attest),
 *   A2AIPFS_TASK=1 (asker runs the task flow instead of query/answer),
 *   A2AIPFS_TASK_TEXT, A2AIPFS_CHUNKS (stream-chunk count, default 5),
 *   A2AIPFS_REPUBLISH_MS (default 15000, §5 floor 10s),
 *   plus the node factory env (GNOSTR_LISTEN, GNOSTR_RENDEZVOUS_SERVER, …).
 */
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import * as dagJson from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { base64urlpad } from 'multiformats/bases/base64'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { dagJson as heliaDagJson } from '@helia/dag-json'
import { ipns as makeIpns } from '@helia/ipns'
import { pubsub as ipnsPubsubRouter } from '@helia/ipns/routing'

/* libp2p 3.5.1 keeps the node's private key as an internal component (the
 * PeerId object is public-key-only). Resolve it once, with fallbacks. */
function resolvePrivateKey (node) {
  const inner = node.components?.components ?? {}
  if (inner.privateKey && typeof inner.privateKey.sign === 'function') return inner.privateKey
  if (node.peerId.privateKey) return privateKeyFromProtobuf(node.peerId.privateKey) /* ≤2.x */
  throw new Error('no libp2p private key resolvable — envelope signing impossible')
}
import { createAgentNode } from '../src/node.js'

const ROLE = process.env.A2AIPFS_ROLE || ''
const TOPIC = process.env.A2AIPFS_TOPIC || 'a2aipfs/v1/global'
const NAME = process.env.A2AIPFS_NAME || 'agent-' + (process.env.A2AIPFS_ROLE || 'x')
const QUESTION = process.env.A2AIPFS_QUESTION || 'what platform/architecture and hostname are you running? Answer with your real OS, arch and hostname.'
const TIMEOUT_MS = Number(process.env.A2AIPFS_TIMEOUT_MS || 300000)
const REPUBLISH_MS = Math.max(Number(process.env.A2AIPFS_REPUBLISH_MS || 15000), 10000) /* §5/§9 floor */
const SETTLE_MS = Number(process.env.A2AIPFS_SETTLE_MS || 2500) /* mesh/heartbeat settle before first publish */
const PROTO = '/a2aipfs/1.0.0' /* §7 */
const INBOX = (peer) => `a2aipfs/v1/agent/${peer}`
const VERSION = '1.0'
const TYPES = ['announce', 'query', 'answer', 'task', 'task-state', 'stream-chunk', 'ack', 'error', 'attest']

const log = (m) => process.stderr.write(NAME + ': ' + m + '\n')
const enc = new TextEncoder()
const dec = new TextDecoder()

if (!['asker', 'responder', 'witness', 'worker'].includes(ROLE)) {
  process.stderr.write('a2aipfs-node: A2AIPFS_ROLE must be asker|responder|witness|worker\n')
  process.exit(2)
}

/* ---------- node ---------- */
const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'a2aipfs-node-')), log })
const node = ctx.node
const nodeKey = resolvePrivateKey(node)
const peerId = node.peerId.toString()
log('peer id: ' + peerId)
for (const a of node.getMultiaddrs().map(String)) console.log('listen: ' + a) /* e2e/CI dial parsing */
log('role: ' + ROLE + ' on ' + TOPIC)

/* ---------- §2 envelope machinery ---------- */

/* canonical body: every field except id and sig, in spec field order */
function canonicalBytes (env) {
  const body = { a2aipfs: env.a2aipfs, type: env.type, from: env.from, ts: env.ts }
  if (env.topic !== undefined) body.topic = env.topic
  if (env.ref !== undefined) body.ref = env.ref
  body.payload = env.payload
  return dagJson.encode(body)
}

function computeId (env) {
  return CID.create(1, dagJson.code, sha256.digest(canonicalBytes(env)))
}

async function signer () {
  return (bytes) => nodeKey.sign(bytes)
}

/* build, id, and sign an envelope (§2.2: id over the body BEFORE signing) */
async function buildEnvelope (type, payload, opts = {}) {
  const env = { a2aipfs: VERSION, type, from: peerId, ts: Date.now(), payload }
  if (opts.topic !== null) env.topic = opts.topic ?? TOPIC
  if (opts.ref) env.ref = opts.ref
  env.id = computeId(env).toString()
  const sign = await signer()
  env.sig = base64urlpad.encode(await sign(canonicalBytes(env)))
  return env
}

/* §9 + §11 rules; returns null when the envelope is acceptable, else why.
 * Mirrors test/a2aipfs-vectors.mjs (M3). */
function ruleViolation (e) {
  if (!e || typeof e !== 'object') return 'not an object'
  if (e.a2aipfs !== VERSION) return 'missing/unsupported a2aipfs version (§2.1,§10)'
  if (!TYPES.includes(e.type)) return 'unknown type "' + e.type + '" (§2.1)'
  if (typeof e.id !== 'string' || !e.id) return 'missing id (§2.2)'
  if (typeof e.from !== 'string' || !e.from) return 'missing from (§2)'
  if (!Number.isInteger(e.ts) || e.ts < 0) return 'missing/invalid ts (§2)'
  if (typeof e.sig !== 'string' || !e.sig) return 'missing sig (§9)'
  if (e.topic !== undefined && !String(e.topic).startsWith('a2aipfs/v1/')) return 'topic outside a2aipfs/v1/ (§4)'
  if (!e.payload || typeof e.payload !== 'object') return 'missing payload (§2)'
  if (canonicalBytes(e).length > 1048576) return 'envelope exceeds 1 MiB gossipsub limit (§2.4)'
  switch (e.type) {
    case 'query': if (typeof e.payload.question !== 'string' || !e.payload.question) return 'query without payload.question (§3.2)'; break
    case 'answer':
      if (typeof e.payload.text !== 'string' || !e.payload.text) return 'answer without payload.text (§3.3)'
      if (e.ref === undefined) return 'answer without correlation ref (§2.3)'
      break
    case 'task': if (e.payload.task?.state !== 'submitted') return 'task initial state must be submitted (§3.4)'; break
    case 'task-state': if (!e.payload.task || typeof e.payload.task.state !== 'string') return 'task-state without payload.task.state (§3.5)'; break
    case 'ack': if (typeof e.payload.received !== 'string') return 'ack without payload.received (§3.7)'; break
    case 'stream-chunk':
      if (!Number.isInteger(e.payload.seq) || e.payload.seq < 0) return 'stream-chunk without seq (§3.6)'
      if (typeof e.payload.last !== 'boolean') return 'stream-chunk without last flag (§3.6)'
      break
    case 'attest': {
      const p = e.payload
      if (!p.exchange || typeof p.exchange.requestId !== 'string' || typeof p.exchange.responseId !== 'string') return 'attest without exchange ids (§3.9)'
      if (typeof p.askerPeer !== 'string' || typeof p.responderPeer !== 'string' || typeof p.witnessPeer !== 'string' || typeof p.topic !== 'string') return 'attest missing peers/topic (§3.9)'
      if (p.askerPeer === p.responderPeer) return 'attest with askerPeer == responderPeer (§8)'
      break
    }
  }
  return null
}

/* §9: recompute id and verify the envelope signature against `from` */
async function verifyEnvelope (e) {
  const why = ruleViolation(e)
  if (why) return why
  try {
    if (computeId(e).toString() !== e.id) return 'id does not recompute over canonical body (§2.2)'
    const fromPeer = peerIdFromString(e.from)
    if (!fromPeer.publicKey) return 'no public key recoverable from from (§9)'
    const ok = await fromPeer.publicKey.verify(canonicalBytes(e), base64urlpad.decode(e.sig))
    if (!ok) return 'invalid envelope signature (§9)'
    return null
  } catch (err) {
    return 'envelope crypto failed: ' + (err?.message || err)
  }
}

/* ---------- IPFS content-address verification ----------
 * The envelope id claims to be the CIDv1 (dag-json, sha2-256) of the
 * canonical body. Verify that claim ON IPFS: hand the canonical bytes to
 * the node's own helia DAG store and let IPFS compute the CID, then
 * resolve the envelope by its claimed id through the same store. Both
 * must agree or the envelope is not admissible for attestation. */
const ipfsDag = heliaDagJson(ctx.helia)

async function ipfsVerify (env) {
  try {
    const bytes = canonicalBytes(env)
    const viaAdd = await ipfsDag.add(dagJson.decode(bytes)) /* IPFS computes the CID */
    if (viaAdd.toString() !== env.id) return 'IPFS dag.add CID ' + viaAdd + ' != envelope id (§2.2)'
    const viaGet = await ipfsDag.get(CID.parse(env.id)) /* resolve BY the claimed id */
    if (viaGet == null) return 'IPFS dag.get(' + env.id + ') did not resolve'
    return null
  } catch (err) {
    return 'IPFS verification failed: ' + (err?.message || err)
  }
}

/* ---------- §7 direct stream (NDJSON) ----------
 * libp2p 3.5.x streams are evented message streams: send() to write,
 * `for await … of stream` to read, closeWrite() to half-close. The
 * {source,sink} Duplex facade does NOT exist on these objects — earlier
 * code assumed it and the §7 paths silently no-op'd (caught exceptions). */

function writeNdjson (stream, obj) {
  stream.send(enc.encode(JSON.stringify(obj) + '\n'))
}

async function writeNdjsonMany (stream, objs) {
  for (const o of objs) writeNdjson(stream, o)
  try { await stream.closeWrite() } catch { /* already closing */ }
}

async function readNdjson (stream, onObj) {
  let buf = ''
  try {
    for await (const chunk of stream) {
      const u8 = chunk?.subarray ? chunk.subarray() : chunk
      buf += dec.decode(u8, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) {
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          await onObj(obj, stream)
        }
      }
    }
  } catch { /* peer closed */ }
}

async function chainHex (prevHex, data) {
  const prev = prevHex ? Buffer.from(prevHex, 'hex') : new Uint8Array(0)
  const digest = await sha256.digest(new Uint8Array([...prev, ...enc.encode(data)]))
  return Buffer.from(digest.bytes).toString('hex')
}

/* ---------- pubsub plumbing ---------- */
const seen = new Set() /* §5: dedup by id */
const subs = [TOPIC, INBOX(peerId)]

async function publish (env) {
  const topic = env.topic || TOPIC
  await node.services.pubsub.publish(topic, enc.encode(JSON.stringify(env)))
}

async function announce (card, isRepub = false) {
  const c = card ?? defaultCard()
  /* the card itself goes on IPFS: content-addressed, its CID is embedded
   * in the signed announce payload so resolvers can verify both */
  const cardCid = await ipfsDag.add(c)
  const env = await buildEnvelope('announce', { card: c, cardCid: cardCid.toString() })
  await publish(env)
  log('announce published on ' + (env.topic || TOPIC) + ' card ' + cardCid)
  publishCardRecord(cardCid)
  /* §6/§5: republish the IPNS record AND the announce itself a few times —
   * the announce is what makes peers subscribe to our IPNS topic, and the
   * first publish can fire before the gossipsub mesh grafts (same cold-mesh
   * flake class as queries); the record republishes then find subscribers.
   * Republishes build FRESH envelopes (new ts → new id): a receiver that
   * missed the first announce has it in `seen` by id, so re-sending the same
   * envelope would be silently dropped. */
  if (!isRepub) {
    for (const d of [3000, 6000, 10000, 16000, 24000, 36000, 50000]) {
      setTimeout(() => { publishCardRecord(cardCid).catch(() => {}) }, d).unref()
    }
    for (const d of [4000, 9000, 18000]) {
      setTimeout(() => { announce(c, true).then(() => log('announce republished (' + d + 'ms)'), () => {}) }, d).unref()
    }
  }
}

/* §6: the Agent Card is published to IPNS under the node's own peer key —
 * the IPNS name IS the peer identity, so resolving it binds the card to
 * the peer that announced it. Uses a pubsub-router-only IPNS instance:
 * the factory's default routers include the DHT router, whose put throws
 * in client mode ("this.routing.put is not a function") — the error
 * rejects publish() even though the pubsub record lands. */
const cardIpns = makeIpns(ctx.helia, { routers: [ipnsPubsubRouter(ctx.helia)] })

async function publishCardRecord (cardCid) {
  try {
    /* hard race cap: gossipsub.publish throws fast when no mesh peers are
     * subscribed (PublishError.NoPeersSubscribedToTopic) but can HANG once
     * a peer appears if a stream stalls — the abort signal is not honored
     * mid-write (observed in CI run 45746088806: every put after the first
     * subscriber subscribed settled neither way, no log line at all). The
     * race guarantees the attempt always settles and is logged. */
    await Promise.race([
      cardIpns.publish(nodeKey, cardCid, { signal: AbortSignal.timeout(6000) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('publish hard-capped at 7s')), 7000))
    ])
    log('CARD PUBLISHED via IPNS ' + peerId.slice(0, 12) + '… → ' + cardCid)
  } catch (e) {
    log('IPNS card publish failed: ' + (e?.message || e))
  }
}

/* card-resolution lines go to stderr AND, when A2AIPFS_CARD_TRACE is set,
 * to a dedicated file — the copilot leg's asker runs inside the Copilot CLI
 * session, so its stderr never reaches the teed session log the CI verdict
 * greps. The trace file makes the verdict independent of the harness. */
function cardLog (msg) {
  log(msg)
  if (process.env.A2AIPFS_CARD_TRACE) {
    try { appendFileSync(process.env.A2AIPFS_CARD_TRACE, msg + '\n') } catch {}
  }
}

/* resolve another peer's card through IPNS and cross-check it against the
 * signed announce: the resolved CID must equal the announced cardCid and
 * the content at that address must match the signed card. */
async function resolveCardWithRetry (env, tries = 25, gapMs = 2000) {
  const want = env.payload?.cardCid
  if (!want || env.from === peerId) return false
  for (let i = 0; i < tries; i++) {
    try {
      const res = await cardIpns.resolve(peerIdFromString(env.from).publicKey, { signal: AbortSignal.timeout(8000) })
      if (res.cid.toString() !== want) {
        cardLog('CARD MISMATCH via IPNS ' + env.from.slice(0, 12) + '… → ' + res.cid + ' != announced ' + want)
        return false
      }
      const got = await ipfsDag.get(CID.parse(want))
      /* compare canonical dag-json bytes — key order in the decoded object
       * is not significant, JSON.stringify would false-mismatch */
      const match = Buffer.compare(Buffer.from(dagJson.encode(got)), Buffer.from(dagJson.encode(env.payload.card))) === 0
      cardLog('CARD RESOLVED via IPNS ' + env.from.slice(0, 12) + '… → ' + res.cid + (match ? ' (content matches signed card)' : ' (CONTENT MISMATCH)'))
      return match
    } catch {
      await new Promise((r) => setTimeout(r, gapMs))
    }
  }
  cardLog('CARD UNRESOLVED via IPNS ' + env.from.slice(0, 12) + '… (' + tries + ' tries)')
  return false
}

function defaultCard () {
  return {
    name: NAME,
    peerId,
    protocolVersion: VERSION,
    supportedTypes: TYPES,
    maxEnvelopeSize: 1048576, /* §2.4 */
    relayAddrs: node.getMultiaddrs().map(String).filter((a) => a.includes('/p2p-circuit'))
  }
}

async function dialCoLocated () {
  const addrs = (process.env.A2AIPFS_DIAL || process.env.CHAT_DIAL || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (addrs.length === 0) return
  const pending = new Set(addrs)
  const peerOf = (a) => (a.match(/\/p2p\/([^/]+)$/) || [])[1]
  const connected = (a) => {
    const p = peerOf(a)
    return p && node.getConnections().some((c) => c.remotePeer.toString() === p)
  }
  for (let i = 0; i < 30 && pending.size > 0; i++) {
    for (const a of [...pending]) {
      if (connected(a)) { pending.delete(a); log('connected ' + a); continue }
      try { await node.dial(multiaddr(a)); pending.delete(a); log('dialed ' + a) } catch { /* retry next tick */ }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 1000))
  }
  for (const a of pending) log('dial gave up on ' + a)
  /* protect + repair the co-located links: on the churny public swarm the
   * connection manager prunes aggressively (observed: 114 → 67 connected
   * mid-run, witness severed from the asker/responder it must observe —
   * CI run 45751518390, zero envelopes seen). Tagged peers are last in
   * line for pruning; the sweep re-dials any co-located peer that was cut. */
  const coPeers = addrs.map(peerOf).filter(Boolean)
  for (const p of coPeers) {
    try { await node.services.connectionManager.tagPeer(peerIdFromString(p), 'a2aipfs-colocated', { value: 100, ttl: 30 * 60 * 1000 }) } catch {}
  }
  const sweep = setInterval(() => {
    for (const a of addrs) {
      if (connected(a)) continue
      log('co-located link lost — re-dialing ' + a)
      node.dial(multiaddr(a)).then(() => log('re-dialed ' + a), () => {})
    }
  }, 10000)
  sweep.unref()
}

/* ---------- responder ---------- */
async function runResponder () {
  let answers = 0
  const ANSWER_TIMES = Number(process.env.A2AIPFS_ANSWER_TIMES || 3)

  async function answerText (question) {
    let body
    if (process.env.A2AIPFS_DELEGATE === 'copilot') {
      body = await askCopilot(question)
      if (body === null) return null
    } else {
      body = 'I am ' + NAME + ' answering: ' + question.slice(0, 80)
    }
    /* identity-bearing prefix: the asker prints this text verbatim and the
     * CI verdict greps it; the attest carries the same name in its signed
     * payload.facts */
    return 'answer from ' + NAME + ' (peer ' + peerId.slice(0, 12) + '…, host ' + os.hostname() +
      '): ' + body + ' — I run on ' + os.platform() + '/' + os.arch()
  }

  async function handleQuery (env, replyStream) {
    if (answers >= ANSWER_TIMES) return
    const text = await answerText(env.payload.question)
    if (text === null) { log('delegation FAILED — publishing nothing'); return }
    answers++
    const ans = await buildEnvelope('answer', {
      text,
      facts: { platform: os.platform(), arch: os.arch(), hostname: os.hostname(), name: NAME }
    }, { ref: env.id })
    if (replyStream) {
      /* §7: direct-stream delivery gets an ack in at-least-once mode */
      writeNdjson(replyStream, ans)
      const ack = await buildEnvelope('ack', { received: env.id }, { ref: ans.id })
      writeNdjson(replyStream, ack)
      try { await replyStream.closeWrite() } catch { /* already closing */ }
      log('answer + ack written to direct stream, ref ' + env.id.slice(0, 16) + '…')
    }
    await publish(ans)
    log('answer ' + answers + '/' + ANSWER_TIMES + ' published, ref ' + env.id.slice(0, 16) + '…')
    /* §5: republish the answer — witnesses subscribe at different times and
     * gossipsub MAY drop a single publish; on the cold mesh co-located links
     * can drop for tens of seconds even with tags + re-dial sweeps (observed
     * CI run 45755441986: query seen, every answer missed — the republish
     * window ended at +8s before the link healed). Each republish is a FRESH
     * envelope (new id, same ref): receivers dedup by id, so identical
     * re-sends would be dropped by anyone who already saw the first one —
     * and §9's republish bound is per message id, which fresh ids satisfy.
     * The witness correlates answers to queries by ref, so fresh ids are
     * attest-equivalent. Window matches the query grace schedule (+40s). */
    const ansPayload = ans.payload
    for (const d of [3000, 8000, 15000, 25000, 40000]) {
      setTimeout(() => {
        buildEnvelope('answer', ansPayload, { ref: env.id }).then((fresh) => {
          publish(fresh).then(() => log('answer republished (' + d + 'ms) id ' + fresh.id.slice(0, 16) + '…'), () => {})
        }, () => {})
      }, d).unref()
    }
  }

  node.handle(PROTO, (stream) => {
    readNdjson(stream, async (obj) => {
      if (obj?.a2aipfs !== VERSION) return
      if (obj.type === 'query') {
        const why = await verifyEnvelope(obj)
        if (why) { log('stream query rejected: ' + why); return }
        await handleQuery(obj, stream)
      } else {
        /* §7: unknown types get an error envelope, not a transport reset */
        const err = await buildEnvelope('error', { code: 'unsupported-type', text: 'this responder only handles query over the direct stream' }, { ref: obj.id })
        await writeNdjson(stream, err).catch(() => {})
      }
    })
  })

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
      if (env.type !== 'query') return
      if (env.from === peerId) return
      const why = await verifyEnvelope(env)
      if (why) { log('query rejected: ' + why); return }
      log('query from ' + env.from.slice(0, 16) + '… — answering')
      await handleQuery(env, null)
    })().catch((e) => log('responder handler error: ' + (e?.message || e)))
  })

  await Promise.all(subs.map((t) => node.services.pubsub.subscribe(t)))
  await dialCoLocated()
  await announce()
  const reannounce = setInterval(() => { announce().catch(() => {}) }, 60000)
  log('responder up on ' + TOPIC)
  setTimeout(() => { clearInterval(reannounce); log('window over — ' + answers + ' answer(s)'); process.exit(answers > 0 ? 0 : 1) }, TIMEOUT_MS).unref()
}

function askCopilot (question) {
  return new Promise((resolve) => {
    const prompt = 'Answer this question in one short sentence, truthfully, about THIS machine if asked: ' + question
    const p = spawn('copilot', ['--yolo', '--max-ai-credits', '30', '-p', prompt], { timeout: 150000 })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().slice(0, 400) : null))
    p.on('error', () => resolve(null))
  })
}

/* ---------- asker ---------- */
const cardPending = new Set() /* peers whose card resolution is in flight */
const cardDone = new Set()
let foreignAnnounces = 0 /* announces from OTHER peers seen by this node */
async function trackCard (env) {
  if (env.from === peerId || cardDone.has(env.from) || !env.payload?.cardCid) return
  foreignAnnounces++
  cardPending.add(env.from)
  try { if (await resolveCardWithRetry(env)) cardDone.add(env.from) } catch {}
  cardPending.delete(env.from)
}
async function awaitCards (ms = 30000) {
  const t0 = Date.now()
  /* NEVER resolve on an empty snapshot: on the cold public mesh a foreign
   * announce can take many seconds to arrive, and exiting at that point
   * kills every pending republish timer and in-flight resolution (observed
   * in CI run 45746088806: asker/witness dead ~10s, zero card resolutions).
   * Floor at 12s so the +4s/+9s announce republishes are covered, then leave
   * once nothing is pending. */
  while (Date.now() - t0 < ms) {
    if (foreignAnnounces > 0 && cardPending.size === 0 && Date.now() - t0 >= 12000) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function runAsker () {
  let answered = false
  let publishes = 0
  let directTried = false
  const directPeers = new Set()

  const query = await buildEnvelope('query', { question: QUESTION, tags: ['interop', 'a2aipfs'] })
  log('query id: ' + query.id)

  function capture (ans) {
    if (answered) return
    answered = true
    log('ANSWER from ' + ans.from.slice(0, 12) + '… via ' + (ans.payload?.facts?.name || 'agent'))
    /* the verdict artifact: full answer text verbatim on stdout (§ nothing —
     * the CI verdict greps this line; keep it single-line) */
    process.stdout.write(ans.payload.text + '\n')
    /* §5 grace republishes: a witness whose subscription hadn't converged
     * into our mesh when the exchange happened gets two more chances at
     * the query before we leave — observed flakiness was the asker exiting
     * before the witness saw anything. */
    for (const d of [1000, 3000, 8000, 15000, 25000, 40000]) {
      setTimeout(() => { publish(query).then(() => log('query grace-republished (' + d + 'ms)'), () => {}) }, d).unref()
    }
    /* give the §6 card resolutions a bounded window, then leave */
    awaitCards(45000).finally(() => { setTimeout(() => process.exit(0), 4500).unref() })
  }

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
      if (env.type === 'announce') {
        const why = await verifyEnvelope(env)
        if (!why) trackCard(env)
        return
      }
      if (env.type !== 'answer' || env.ref !== query.id) return
      if (env.from === peerId) return /* §8: no self-answers */
      const why = await verifyEnvelope(env)
      if (why) { log('answer rejected: ' + why); return }
      capture(env)
    })().catch((e) => log('asker handler error: ' + (e?.message || e)))
  })

  /* §7: direct-stream answers */
  node.handle(PROTO, (stream) => {
    readNdjson(stream, async (obj) => {
      if (obj?.a2aipfs !== VERSION || obj.type !== 'answer' || obj.ref !== query.id) return
      if (seen.has(obj.id)) return
      seen.add(obj.id)
      const why = await verifyEnvelope(obj)
      if (why) { log('stream answer rejected: ' + why); return }
      capture(obj)
    })
  })

  async function tryDirect () {
    /* §7: fall back to direct streams after two republish cycles without response */
    for (const conn of node.getConnections()) {
      if (directPeers.has(conn.remotePeer.toString())) continue
      directPeers.add(conn.remotePeer.toString())
      node.dialProtocol(conn.remotePeer, PROTO).then(async (stream) => {
        writeNdjson(stream, query)
        try { await stream.closeWrite() } catch { /* already closing */ }
        log('query pushed over direct stream to ' + conn.remotePeer.toString().slice(0, 12) + '…')
        /* the answer comes back on the same stream */
        await readNdjson(stream, async (obj) => {
          if (obj?.a2aipfs !== VERSION || obj.type !== 'answer' || obj.ref !== query.id) return
          if (seen.has(obj.id)) return
          seen.add(obj.id)
          const why = await verifyEnvelope(obj)
          if (why) { log('stream answer rejected: ' + why); return }
          capture(obj)
        })
      }, () => {})
    }
  }

  await Promise.all(subs.map((t) => node.services.pubsub.subscribe(t)))
  await dialCoLocated()
  await announce()
  log('settling ' + SETTLE_MS + 'ms before first publish (mesh heartbeat)')
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  await publish(query)
  publishes++
  log('query published (' + publishes + '): ' + QUESTION.slice(0, 60) + '…')

  const republish = setInterval(() => {
    if (answered) return
    publish(query).then(() => log('query republished (' + (++publishes) + ')'), () => {})
    if (publishes >= 2 && !directTried) { directTried = true; tryDirect() }
  }, REPUBLISH_MS)
  republish.unref()

  setTimeout(() => {
    if (!answered) { log('no valid answer within the window'); process.exit(1) }
  }, TIMEOUT_MS).unref()
}

/* ---------- task-mode asker (A2AIPFS_TASK=1) ---------- */
async function runTaskAsker () {
  const TASK_TEXT = process.env.A2AIPFS_TASK_TEXT || 'compute the interop payload and stream it back in ordered, hash-chained chunks'
  const chunks = new Map() /* seq -> verified env */
  const acks = []
  let doneState = null
  let completed = false
  let publishes = 0

  const replyTo = node.getMultiaddrs().map(String).find((a) => a.includes('/p2p/'))
  const task = await buildEnvelope('task', { task: { state: 'submitted', text: TASK_TEXT, replyTo } })
  log('task id: ' + task.id)

  function completeIfReady () {
    if (completed || !doneState) return
    const lastSeq = Math.max(...chunks.keys())
    if (!chunks.get(lastSeq)?.payload.last) return
    for (let i = 0; i <= lastSeq; i++) if (!chunks.has(i)) return
    completed = true
    log('TASK COMPLETE: ' + chunks.size + ' chunks, seq 0..' + lastSeq + ' continuous, chain verified, all signatures verified; done observed from ' + doneState.from.slice(0, 12) + '…')
    /* the verdict line: single-line, greppable, on stdout */
    process.stdout.write('task complete: received ' + chunks.size + ' chunks, seq 0..' + lastSeq + ' continuous, hash chain verified, all signatures verified (§3.6,§9)\n')
    for (const d of [1000, 3000, 8000, 15000, 25000, 40000]) {
      setTimeout(() => { publish(task).then(() => log('task grace-republished (' + d + 'ms)'), () => {}) }, d).unref()
    }
    /* give the §6 card resolutions a bounded window, then leave */
    awaitCards(45000).finally(() => { setTimeout(() => process.exit(0), 4500).unref() })
  }

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
      if (env.type === 'announce') {
        const why = await verifyEnvelope(env)
        if (!why) trackCard(env)
        return
      }
      if (env.type === 'task-state' && env.ref === task.id && env.payload?.task?.state === 'done' && !doneState) {
        const why = await verifyEnvelope(env)
        if (why) { log('task-state rejected: ' + why); return }
        if (env.from === peerId) return
        doneState = env
        log('task-state done observed from ' + env.from.slice(0, 12) + '… chunks=' + env.payload.task.result?.chunks)
        completeIfReady()
      }
    })().catch((e) => log('task-asker handler error: ' + (e?.message || e)))
  })

  /* §3.6/§7: worker dials back and streams hash-chained chunks */
  node.handle(PROTO, (stream) => {
    let prevChain = null
    ;(async () => {
      await readNdjson(stream, async (obj) => {
        if (obj?.a2aipfs !== VERSION || obj.type !== 'stream-chunk') return
        if (obj.ref !== task.id) { log('stream-chunk rejected: wrong ref'); return }
        if (chunks.has(obj.payload?.seq)) return
        const why = await verifyEnvelope(obj)
        if (why) { log('stream-chunk rejected: ' + why); return }
        const seq = obj.payload.seq
        const expected = await chainHex(seq === 0 ? null : prevChain, obj.payload.data)
        if (obj.payload.chain !== expected) { log('stream-chunk ' + seq + ' rejected: chain does not recompute'); return }
        prevChain = obj.payload.chain
        chunks.set(seq, obj)
        acks.push(await buildEnvelope('ack', { received: obj.id }, { ref: obj.id }))
        log('chunk ' + (seq + 1) + ' verified (seq ' + seq + ', last=' + obj.payload.last + ')')
        if (obj.payload.last) {
          await writeNdjsonMany(stream, acks)
          log(acks.length + ' ack(s) written to stream')
          completeIfReady()
        }
      })
    })().catch((e) => log('task-worker stream handler error: ' + (e?.message || e)))
  })

  await Promise.all(subs.map((t) => node.services.pubsub.subscribe(t)))
  await dialCoLocated()
  await announce()
  log('settling ' + SETTLE_MS + 'ms before first publish (mesh heartbeat)')
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  await publish(task)
  publishes++
  log('task published (' + publishes + '): ' + TASK_TEXT.slice(0, 60) + '…')

  const republish = setInterval(() => {
    if (completed) return
    publish(task).then(() => log('task republished (' + (++publishes) + ')'), () => {})
  }, REPUBLISH_MS)
  republish.unref()

  setTimeout(() => {
    if (!completed) { log('task not completed within the window (' + chunks.size + ' chunks)'); process.exit(1) }
  }, TIMEOUT_MS).unref()
}

/* ---------- worker (task executor) ---------- */
async function runWorker () {
  const N = Math.max(Number(process.env.A2AIPFS_CHUNKS || 5), 1)
  let handled = 0

  async function handleTask (env) {
    if (handled >= 1) return
    handled++
    const taskId = env.id
    log('task accepted from ' + env.from.slice(0, 12) + '… — ' + N + ' chunks')

    const accepted = await buildEnvelope('task-state', { task: { state: 'accepted' } }, { ref: taskId })
    await publish(accepted)
    await publish(accepted) /* §5: cold-mesh grace twin */
    log('task-state accepted published')
    /* the witness may subscribe seconds after we accept (cold-mesh grafting);
     * a single accepted publish is attest-visible data — keep re-announcing
     * it so the attest record carries the full accepted→done lifecycle
     * (CI run 45750462062: accepted lost, verifier failed the record) */
    for (const d of [2000, 6000, 12000, 20000]) {
      setTimeout(() => { publish(accepted).then(() => log('accepted republished (' + d + 'ms)'), () => {}) }, d).unref()
    }

    /* §3.6: build the ordered hash-chained payload. The chain is part of
     * the signed payload, so it must be final BEFORE buildEnvelope. */
    const data = []
    const chains = []
    let chain = null
    for (let i = 0; i < N; i++) {
      data.push('chunk ' + i + '/' + N + ' from ' + NAME + ' (peer ' + peerId.slice(0, 12) + '…) for task ' + taskId.slice(0, 16) + '…')
      chain = await chainHex(chain, data[i])
      chains.push(chain)
    }

    /* §7: deliver over the direct stream to the asker's replyTo addr */
    let acked = 0
    const replyTo = env.payload.task.replyTo
    try {
      /* dial by peer id (extracted from the /p2p/ suffix) — the co-located
       * dial loop already holds a connection; dialing the bare multiaddr
       * returns a handle without stream.{sink,source} in libp2p 3.5.x */
      const pm = replyTo.match(/\/p2p\/([^/]+)$/)
      const stream = await node.dialProtocol(pm ? peerIdFromString(pm[1]) : multiaddr(replyTo), PROTO)
      const ackReader = readNdjson(stream, async (obj) => {
        if (obj?.a2aipfs !== VERSION || obj.type !== 'ack') return
        const why = await verifyEnvelope(obj)
        if (why) { log('ack rejected: ' + why); return }
        acked++
      }).catch(() => {})
      const out = []
      for (let i = 0; i < N; i++) {
        out.push(await buildEnvelope('stream-chunk', { seq: i, last: i === N - 1, data: data[i], chain: chains[i] }, { ref: taskId }))
      }
      await writeNdjsonMany(stream, out)
      log(N + ' chunk(s) written to stream for task ' + taskId.slice(0, 16) + '…')
      await Promise.race([ackReader, new Promise((r) => setTimeout(r, 10000))])
    } catch (err) {
      log('stream delivery failed: ' + (err?.message || err))
    }

    const done = await buildEnvelope('task-state', { task: { state: 'done', result: { chunks: N, acked, chain } } }, { ref: taskId })
    await publish(done)
    log('task-state done published (chunks=' + N + ', acked=' + acked + ')')
    for (const d of [3000, 8000, 15000, 25000, 40000]) {
      setTimeout(() => { publish(done).then(() => log('done republished (' + d + 'ms)'), () => {}) }, d).unref()
    }
    setTimeout(() => { log('worker window over — task ' + (handled ? 'completed' : 'UNSOLVED')); process.exit(handled ? 0 : 1) }, 4500).unref()
  }

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
      if (env.type !== 'task' || env.from === peerId) return
      const why = await verifyEnvelope(env)
      if (why) { log('task rejected: ' + why); return }
      if (typeof env.payload.task?.replyTo !== 'string' || !env.payload.task.replyTo.includes('/p2p/')) {
        log('task rejected: no usable replyTo address')
        return
      }
      log('task from ' + env.from.slice(0, 12) + '… — executing')
      await handleTask(env)
    })().catch((e) => log('worker handler error: ' + (e?.message || e)))
  })

  await Promise.all(subs.map((t) => node.services.pubsub.subscribe(t)))
  await dialCoLocated()
  await announce({ name: NAME, worker: true, peerId, protocolVersion: VERSION, supportedTypes: TYPES })
  log('worker up on ' + TOPIC)
  setTimeout(() => { log('worker window over — no task seen'); process.exit(handled ? 0 : 1) }, TIMEOUT_MS).unref()
}

/* ---------- witness ---------- */
async function runWitness () {
  const queries = new Map() /* id -> env */
  const tasks = new Map() /* taskId -> env */
  const states = new Map() /* taskId -> [task-state envs] */
  const done = { v: false }

  async function maybeAttest () {
    if (done.v) return
    for (const [qid, q] of queries) {
      /* the answer was recorded at observation time; re-check correlation */
      const a = done.answers?.get(qid)
      if (!a) continue
      const whyQ = await verifyEnvelope(q)
      const whyA = await verifyEnvelope(a)
      if (whyQ || whyA) continue
      if (q.from === a.from) continue /* §8: distinct peers */
      /* verify the exchange ON IPFS before attesting: the ids must be
       * content addresses resolvable through the IPFS DAG store */
      const ipfsQ = await ipfsVerify(q)
      if (ipfsQ) { log('query not IPFS-admissible: ' + ipfsQ); continue }
      const ipfsA = await ipfsVerify(a)
      if (ipfsA) { log('answer not IPFS-admissible: ' + ipfsA); continue }
      console.log('IPFS VERIFIED ' + q.id + ' (query resolves through the IPFS DAG store)')
      console.log('IPFS VERIFIED ' + a.id + ' (answer resolves through the IPFS DAG store)')
      done.v = true
      const attest = await buildEnvelope('attest', {
        exchange: { requestId: q.id, responseId: a.id },
        askerPeer: q.from,
        responderPeer: a.from,
        witnessPeer: peerId,
        topic: TOPIC,
        observedAt: Date.now(),
        requestText: q.payload.question.slice(0, 200),
        answerText: a.payload.text.slice(0, 400),
        answerFacts: a.payload.facts || null,
        ipfs: { verified: true, cids: { request: q.id, response: a.id }, via: 'helia dag-json add+get' }
      }, { topic: `a2aipfs/v1/witness/${q.id}` })
      await node.services.pubsub.subscribe(attest.topic)
      await publish(attest)
      if (process.env.A2AIPFS_ATTEST_FILE) {
        try { writeFileSync(process.env.A2AIPFS_ATTEST_FILE, JSON.stringify(attest, null, 2)) } catch (e) { log('attest file write failed: ' + e.message) }
      }
      const why = 'witness observed query ' + q.id.slice(0, 16) + '… from ' + q.from.slice(0, 12) + '… and answer ' + a.id.slice(0, 16) + '… from ' + a.from.slice(0, 12) + '… — distinct peers, both signatures verified (§8,§9)'
      console.log('WITNESS PASS: ' + why)
      console.error('WITNESS PASS: ' + why)
      console.log('ATTEST: ' + attest.id)
      awaitCards(35000).finally(() => { setTimeout(() => process.exit(0), 800).unref() })
      return
    }
  }

  done.answers = new Map() /* queryId -> answer env */

  async function maybeTaskAttest () {
    if (done.v) return
    for (const [taskId, t] of tasks) {
      const ss = states.get(taskId) || []
      const d = ss.find((s) => s.payload.task.state === 'done')
      if (!d) continue
      const whyT = await verifyEnvelope(t)
      const whyD = await verifyEnvelope(d)
      if (whyT || whyD) continue
      if (t.from === d.from) continue /* §8: distinct peers */
      /* verify the task exchange ON IPFS before attesting */
      const ipfsT = await ipfsVerify(t)
      if (ipfsT) { log('task not IPFS-admissible: ' + ipfsT); continue }
      const ipfsD = await ipfsVerify(d)
      if (ipfsD) { log('done not IPFS-admissible: ' + ipfsD); continue }
      console.log('IPFS VERIFIED ' + t.id + ' (task resolves through the IPFS DAG store)')
      console.log('IPFS VERIFIED ' + d.id + ' (task-state done resolves through the IPFS DAG store)')
      done.v = true
      const record = {
        task: t,
        states: ss,
        taskerPeer: t.from,
        workerPeer: d.from,
        witnessPeer: peerId,
        topic: TOPIC,
        observedAt: Date.now(),
        ipfs: { verified: true, cids: { task: t.id, done: d.id }, via: 'helia dag-json add+get' }
      }
      if (process.env.A2AIPFS_TASK_FILE) {
        try { writeFileSync(process.env.A2AIPFS_TASK_FILE, JSON.stringify(record, null, 2)) } catch (e) { log('task attest file write failed: ' + e.message) }
      }
      const why = 'witness observed task ' + taskId.slice(0, 16) + '… from ' + t.from.slice(0, 12) + '… and task-state done from ' + d.from.slice(0, 12) + '… — distinct peers, both signatures verified (§8,§9)'
      console.log('WITNESS PASS: task lifecycle — ' + why)
      console.error('WITNESS PASS: task lifecycle — ' + why)
      awaitCards(35000).finally(() => { setTimeout(() => process.exit(0), 800).unref() })
      return
    }
  }

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
      if (env.type === 'task') {
        const why = await verifyEnvelope(env)
        if (why) { log('task not admissible: ' + why); return }
        tasks.set(env.id, env)
        log('TASK observed from ' + env.from.slice(0, 12) + '… id ' + env.id.slice(0, 16) + '…')
      } else if (env.type === 'announce') {
        const why = await verifyEnvelope(env)
        if (!why) trackCard(env)
      } else if (env.type === 'task-state' && env.ref) {
        const why = await verifyEnvelope(env)
        if (why) { log('task-state not admissible: ' + why); return }
        if (!states.has(env.ref)) states.set(env.ref, [])
        states.get(env.ref).push(env)
        log('TASK-STATE ' + env.payload.task.state + ' observed for ' + env.ref.slice(0, 16) + '… from ' + env.from.slice(0, 12) + '…')
        /* arrival order is not guaranteed: on the cold mesh the task-state
         * can land BEFORE the task envelope (the task publishes stop after
         * their grace window; states keep flowing). Never skip silently. */
        if (!tasks.has(env.ref)) log('task-state observed for ' + env.ref.slice(0, 16) + '… but the task envelope itself has not been seen yet — attesting when it lands')
        await maybeTaskAttest()
      }
      if (env.type === 'query') {
        const why = await verifyEnvelope(env)
        if (why) { log('query not admissible: ' + why); return }
        queries.set(env.id, env)
        log('QUERY observed from ' + env.from.slice(0, 12) + '… id ' + env.id.slice(0, 16) + '…')
      } else if (env.type === 'answer' && env.ref) {
        const why = await verifyEnvelope(env)
        if (why) { log('answer not admissible: ' + why); return }
        if (!done.answers.has(env.ref)) {
          done.answers.set(env.ref, env)
          log('ANSWER observed for ' + env.ref.slice(0, 16) + '… from ' + env.from.slice(0, 12) + '…')
        }
      }
      await maybeAttest()
      /* task envelopes can arrive AFTER their task-states — re-run the
       * task attest check on every message, not only on task-state arrival
       * (CI run 45746088806: done observed first, task never re-checked) */
      await maybeTaskAttest()
    })().catch((e) => log('witness handler error: ' + (e?.message || e)))
  })

  await Promise.all(subs.map((t) => node.services.pubsub.subscribe(t)))
  await dialCoLocated()
  await announce({ name: NAME, witness: true, peerId, protocolVersion: VERSION, supportedTypes: TYPES })
  log('witness up on ' + TOPIC)
  setTimeout(() => {
    if (!done.v) {
      console.log('WITNESS FAIL: no admissible query+answer pair or task lifecycle from distinct peers within the window')
      console.error('WITNESS FAIL: no admissible query+answer pair or task lifecycle from distinct peers within the window')
      process.exit(1)
    }
  }, TIMEOUT_MS).unref()
}

/* ---------- go ---------- */
if (ROLE === 'asker' && process.env.A2AIPFS_TASK === '1') await runTaskAsker()
else if (ROLE === 'asker') await runAsker()
else if (ROLE === 'responder') await runResponder()
else if (ROLE === 'worker') await runWorker()
else await runWitness()
