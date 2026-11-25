#!/usr/bin/env node
/* chat-responder.mjs — answer interop questions on the gnostr topic.
 *
 * Watches INTEROP_TOPIC for chat envelopes whose text contains
 * INTEROP_QUESTION_MARKER and answers with facts only this live node knows
 * (platform, arch, hostname, own peer id, the marker it matched) — a REAL
 * answer the asker cannot fabricate.
 *
 * Transport: the responder bootstraps to its own leg's publisher
 * (GNOSTR_BOOTSTRAP / GNOSTR_BOOTSTRAP_FILE, handled by src/node.js), and
 * the interop witness dials the matrix publishers via their git ads —
 * witness↔publisher↔responder chains the topic deterministically instead of
 * relying on probabilistic public-swarm mesh formation. Answers repeat
 * (RESPONDER_MAX_REPLIES × RESPONDER_REPLY_EVERY_MS) as a safety net.
 *
 * "witness-dial <addrs>" in a marker envelope: dial those multiaddrs too
 * (the asker's witness node attached its relay addresses).
 *
 * Exits by itself after INTEROP_LIVE_SECS (default 30 min).
 */
import os from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { multiaddr } from '@multiformats/multiaddr'
import { createAgentNode } from '../src/node.js'

const topic = process.env.INTEROP_TOPIC || 'gnostr'
const marker = process.env.INTEROP_QUESTION_MARKER || ''
const name = process.env.RESPONDER_NAME || ('responder-' + os.platform())
const replyEveryMs = Number(process.env.RESPONDER_REPLY_EVERY_MS || 10000)
const maxReplies = Number(process.env.RESPONDER_MAX_REPLIES || 12)
const liveSecs = Number(process.env.INTEROP_LIVE_SECS || 1800)
if (!marker) { process.stderr.write('responder: INTEROP_QUESTION_MARKER not set — nothing to match\n'); process.exit(1) }

const log = (m) => process.stderr.write('responder: ' + m + '\n')
const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'responder-')), log })
ctx.node.services.pubsub.subscribe(topic)
/* rendezvous: register under the topic's namespace; when a witness-dial
 * envelope reveals a witness running GNOSTR_RENDEZVOUS_SERVER=1 we add it
 * as a rendezvous server (see considerQuestion) so it can discover us and
 * we can discover the asker. */
if (ctx.rendezvous) {
  ctx.rendezvous.join(topic).catch(() => {})
}
log(name + ' on "' + topic + '" — answering questions matching "' + marker + '"')

/* Re-dial the boot bootstrap list every 10s (retry failures after 3s):
 * relay circuits are short-lived (~1 min) and get reset, and the witness
 * bridge addrs may be dialed before its relay reservation is fully usable.
 * Also re-read GNOSTR_BOOTSTRAP_FILE every 30s — the CI step may append
 * fresher witness addrs as it re-downloads the bridge artifact. Tag the
 * bootstrap peers so our connection manager doesn't prune these links. */
const bootFile = process.env.GNOSTR_BOOTSTRAP_FILE || ''
const readBootFile = () => {
  if (!bootFile) return []
  try { return readFileSync(bootFile, 'utf8').split(',').map((s) => s.trim()).filter(Boolean) } catch { return [] }
}
let bootstraps = (process.env.GNOSTR_BOOTSTRAP || '').split(',').map((s) => s.trim()).filter(Boolean)
for (const a of readBootFile()) if (!bootstraps.includes(a)) bootstraps.push(a)
/* multiaddr v13: no getPeerId() — the peer id is the last p2p (421)
 * component's value. */
const peerIdOf = (a) => {
  try {
    const comps = multiaddr(a).getComponents()
    const last = comps[comps.length - 1]
    return last && last.code === 421 ? String(last.value) : null
  } catch { return null }
}
const dialWithRetry = (a, tries = 0) => {
  try {
    ctx.node.dial(multiaddr(a)).then(
      () => log('dialed bootstrap ' + a.slice(0, 60) + (tries ? ' (retry ' + tries + ')' : '')),
      (e) => {
        log('bootstrap dial failed ' + a.slice(0, 60) + ': ' + (e?.message || e).slice(0, 80))
        if (tries < 2) setTimeout(() => dialWithRetry(a, tries + 1), 3000)
      })
  } catch (e) { log('bootstrap dial error ' + a.slice(0, 60) + ': ' + (e?.message || e).slice(0, 80)) }
}
/* ALWAYS schedule the file re-read + re-dial: CI starts the responder with
 * an EMPTY bootstrap file (`: > responder-bootstrap`) and feeds witness
 * addrs through it — guarding on bootstraps.length here left the re-read
 * unregistered and the whole artifact bridge dead (observed: 0 dial lines
 * in a full 10-min live-interop window, every model leg unanswered). */
const dialBoot = () => {
  bootstraps.forEach((a) => dialWithRetry(a))
  bootstraps.forEach((a) => {
    const id = peerIdOf(a)
    if (id) { try { ctx.node.tagPeer(id, 'interop-bootstrap', { value: 1000, ttl: 25000 }) } catch { /* not connected */ } }
  })
}
if (bootstraps.length) dialBoot()
setInterval(dialBoot, 10000).unref()
setInterval(() => {
  let added = 0
  for (const a of readBootFile()) {
    if (!bootstraps.includes(a)) { bootstraps.push(a); added++; dialWithRetry(a) }
  }
  if (added) log('bootstrap file: +' + added + ' addr(s), total ' + bootstraps.length)
}, 30000).unref()

const enc = new TextEncoder()
const dec = new TextDecoder()

/* Direct-push bridge: the witness pushes the question over INTEROP_PROTO on
 * the circuit connection the artifact bridge created, and we push each
 * answer straight back over the same connection — no pubsub mesh luck in
 * either direction. */
const INTEROP_PROTO = '/ipfs-agentd/interop/1.0.0'
/* libp2p v3 stream API: no sink()/source() — write with stream.send(), read
 * by async-iterating the stream itself, close with stream.close(). */
const readStreamJson = async (stream) => {
  const parts = []
  let len = 0
  for await (const chunk of stream) {
    const c = chunk instanceof Uint8Array ? chunk : (chunk.subarray ? chunk.subarray() : new Uint8Array(chunk))
    parts.push(c)
    len += c.length
  }
  const all = new Uint8Array(len)
  let off = 0
  for (const c of parts) { all.set(c, off); off += c.length }
  return JSON.parse(new TextDecoder().decode(all))
}
const writeStreamJson = async (stream, payload) => {
  try {
    stream.send(enc.encode(JSON.stringify(payload)))
    await stream.close()
  } catch { try { stream.abort() } catch { /* gone */ } }
}
/* libp2p 3.5.1 calls handlers as handler(stream, connection) */
ctx.node.handle(INTEROP_PROTO, (stream) => {
  readStreamJson(stream).then((payload) => {
    if (payload?.kind === 'question' && typeof payload.text === 'string' && payload.text.includes(marker)) {
      log('question pushed directly by the witness — answering')
      considerQuestion(payload.text)
    }
  }, () => {})
})

let replies = 0
let lastReply = 0
function considerQuestion (text) {
  /* "witness-dial <addrs>": the asker's witness node (another CI runner)
   * attached its relay multiaddrs — dial them so our answers reach it
   * deterministically instead of by public-swarm luck. */
  const m = text.match(/witness-dial ((?:\/\S+)+)/)
  if (m) {
    for (const a of m[1].split(/\s+/)) {
      /* multiaddrs in the envelope are unauthenticated public-topic data —
       * a bad one must not kill the responder. */
      let ma
      try { ma = multiaddr(a) } catch { continue }
      /* the witness speaks the rendezvous protocol too — register with it
       * so it discovers (and dials) us deterministically */
      ctx.rendezvous?.addServer(a)
      ctx.node.dial(ma).then(
        () => log('dialed witness at ' + a.slice(0, 60) + '…'),
        (e) => log('witness dial failed: ' + (e?.message || e)))
    }
  }
  /* one logical question per run (the marker): answer at most maxReplies
   * times, replyEveryMs apart */
  if (replies >= maxReplies) return
  const now = Date.now()
  if (now - lastReply < replyEveryMs) return
  lastReply = now
  replies++
  const answerText = 'answer from ' + name + ' (peer ' + ctx.node.peerId.toString().slice(0, 12) + '…, host ' + os.hostname() + '): ' +
    'I run on ' + os.platform() + '/' + os.arch() + ' — matched "' + marker + '"'
  const answer = { type: 'chat', name, at: now, text: answerText }
  ctx.node.services.pubsub.publish(topic, enc.encode(JSON.stringify(answer))).then(
    () => log('answer ' + replies + '/' + maxReplies + ' published'),
    (e) => log('answer publish failed: ' + (e?.message || e)))
  /* deterministic return path: the witness (and any other bridge peer) gets
   * the answer over the direct connection, whatever the pubsub mesh does. */
  const payload = { kind: 'answer', name, text: answerText }
  for (const conn of ctx.node.getConnections()) {
    if (!conn.remoteAddr.toString().includes('/p2p-circuit/')) continue
    ctx.node.dialProtocol(conn.remotePeer, INTEROP_PROTO).then(
      (stream) => writeStreamJson(stream, payload),
      () => {})
  }
}

ctx.node.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic) return
  let msg
  try { msg = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
  if (msg.type !== 'chat' || typeof msg.text !== 'string') return
  if (!msg.text.includes(marker)) return
  if (msg.name === name || String(msg.name).startsWith('responder-')) return   /* own echo / other responders */
  considerQuestion(msg.text)
})

setTimeout(async () => {
  log('live window over — stopping')
  await ctx.helia.stop()
  process.exit(0)
}, liveSecs * 1000)
