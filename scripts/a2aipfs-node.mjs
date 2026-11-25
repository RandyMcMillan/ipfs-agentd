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
 *             greps witness.out); exit 0/1.
 *
 * Env: A2AIPFS_TOPIC (default a2aipfs/v1/global), A2AIPFS_NAME,
 *   A2AIPFS_QUESTION, A2AIPFS_TIMEOUT_MS (default 300000),
 *   A2AIPFS_DIAL (comma multiaddrs), A2AIPFS_DELEGATE,
 *   A2AIPFS_ATTEST_FILE, A2AIPFS_REPUBLISH_MS (default 15000, §5 floor 10s),
 *   plus the node factory env (GNOSTR_LISTEN, GNOSTR_RENDEZVOUS_SERVER, …).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
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

if (!['asker', 'responder', 'witness'].includes(ROLE)) {
  process.stderr.write('a2aipfs-node: A2AIPFS_ROLE must be asker|responder|witness\n')
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
  switch (e.type) {
    case 'query': if (typeof e.payload.question !== 'string' || !e.payload.question) return 'query without payload.question (§3.2)'; break
    case 'answer':
      if (typeof e.payload.text !== 'string' || !e.payload.text) return 'answer without payload.text (§3.3)'
      if (e.ref === undefined) return 'answer without correlation ref (§2.3)'
      break
    case 'task': if (e.payload.task?.state !== 'submitted') return 'task initial state must be submitted (§3.4)'; break
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

/* ---------- §7 direct stream (NDJSON) ---------- */

async function writeNdjson (stream, obj) {
  const bytes = enc.encode(JSON.stringify(obj) + '\n')
  await stream.sink((async function * () { yield bytes })())
}

async function readNdjson (stream, onObj) {
  let buf = ''
  try {
    for await (const chunk of stream.source) {
      buf += dec.decode(chunk.subarray(), { stream: true })
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

/* ---------- pubsub plumbing ---------- */
const seen = new Set() /* §5: dedup by id */
const subs = [TOPIC, INBOX(peerId)]

async function publish (env) {
  const topic = env.topic || TOPIC
  await node.services.pubsub.publish(topic, enc.encode(JSON.stringify(env)))
}

async function announce (card) {
  const env = await buildEnvelope('announce', { card: card ?? defaultCard() })
  await publish(env)
  log('announce published on ' + (env.topic || TOPIC))
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
  const connected = (a) => {
    const m = a.match(/\/p2p\/([^/]+)$/)
    return m && node.getConnections().some((c) => c.remotePeer.toString() === m[1])
  }
  for (let i = 0; i < 30 && pending.size > 0; i++) {
    for (const a of [...pending]) {
      if (connected(a)) { pending.delete(a); log('connected ' + a); continue }
      try { await node.dial(multiaddr(a)); pending.delete(a); log('dialed ' + a) } catch { /* retry next tick */ }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 1000))
  }
  for (const a of pending) log('dial gave up on ' + a)
}

/* ---------- responder ---------- */
async function runResponder () {
  let answers = 0
  const ANSWER_TIMES = Number(process.env.A2AIPFS_ANSWER_TIMES || 3)

  async function answerText (question) {
    if (process.env.A2AIPFS_DELEGATE === 'copilot') {
      const delegated = await askCopilot(question)
      if (delegated === null) return null
      return delegated
    }
    return 'I am ' + NAME + ' (peer ' + peerId.slice(0, 12) + '…, host ' + os.hostname() +
      '): ' + question.slice(0, 80) + ' — I run on ' + os.platform() + '/' + os.arch()
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
      await writeNdjson(replyStream, ans)
      const ack = await buildEnvelope('ack', { received: env.id }, { ref: ans.id })
      await writeNdjson(replyStream, ack)
      log('answer + ack written to direct stream, ref ' + env.id.slice(0, 16) + '…')
    }
    await publish(ans)
    log('answer ' + answers + '/' + ANSWER_TIMES + ' published, ref ' + env.id.slice(0, 16) + '…')
    /* §5: republish the answer a couple of times — witnesses subscribe at
     * different times and gossipsub MAY drop a single publish. */
    for (const d of [3000, 8000]) {
      setTimeout(() => { publish(ans).then(() => log('answer republished (' + d + 'ms)'), () => {}) }, d).unref()
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
    })().catch(() => {})
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
    for (const d of [1000, 3000]) {
      setTimeout(() => { publish(query).then(() => log('query grace-republished (' + d + 'ms)'), () => {}) }, d).unref()
    }
    setTimeout(() => process.exit(0), 4500).unref()
  }

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
      if (env.type !== 'answer' || env.ref !== query.id) return
      if (env.from === peerId) return /* §8: no self-answers */
      const why = await verifyEnvelope(env)
      if (why) { log('answer rejected: ' + why); return }
      capture(env)
    })().catch(() => {})
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
        await writeNdjson(stream, query)
        log('query pushed over direct stream to ' + conn.remotePeer.toString().slice(0, 12) + '…')
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

/* ---------- witness ---------- */
async function runWitness () {
  const queries = new Map() /* id -> env */
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
        answerFacts: a.payload.facts || null
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
      setTimeout(() => process.exit(0), 800).unref()
      return
    }
  }

  done.answers = new Map() /* queryId -> answer env */

  node.services.pubsub.addEventListener('message', (evt) => {
    (async () => {
      let env
      try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
      if (!env || env.a2aipfs !== VERSION || seen.has(env.id)) return
      seen.add(env.id)
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
    })().catch(() => {})
  })

  await Promise.all(subs.map((t) => node.services.pubsub.subscribe(t)))
  await dialCoLocated()
  await announce({ name: NAME, witness: true, peerId, protocolVersion: VERSION, supportedTypes: TYPES })
  log('witness up on ' + TOPIC)
  setTimeout(() => {
    if (!done.v) {
      console.log('WITNESS FAIL: no admissible query+answer pair from distinct peers within the window')
      console.error('WITNESS FAIL: no admissible query+answer pair from distinct peers within the window')
      process.exit(1)
    }
  }, TIMEOUT_MS).unref()
}

/* ---------- go ---------- */
if (ROLE === 'asker') await runAsker()
else if (ROLE === 'responder') await runResponder()
else await runWitness()
