#!/usr/bin/env node
/* listen-chat.mjs — witness for the Copilot chat interop leg.
 *
 * Two modes:
 *  - CHAT_NEEDLE set, CHAT_QUESTION_MARKER unset: pass when any chat
 *    envelope from CHAT_FROM whose text contains CHAT_NEEDLE is seen.
 *  - CHAT_QUESTION_MARKER set (Q&A mode): pass when (1) a chat envelope
 *    from CHAT_FROM containing the marker (the question) and (2) an answer
 *    envelope from a name starting with CHAT_ANSWER_PREFIX whose text also
 *    contains the marker are BOTH seen, and they came from DIFFERENT
 *    libp2p peer ids — proving the answer came from another live instance
 *    (a matrix-leg responder), not from the asker itself.
 *
 * Transport:
 *  - CHAT_DIAL is a comma-separated list of multiaddrs dialed up-front (and
 *    retried every 5s) so the witness reliably meshes with both sides.
 *  - CHAT_PUBLISHER_PREFIX makes the witness watch for THIS RUN's git ads
 *    on the topic (ipfs-agentd-ci-<run_id>-<os>, re-published every 15s by
 *    each matrix leg) and dial their advertised multiaddrs — the
 *    deterministic bridge to the matrix runners, which live on other
 *    machines (each leg's responder bootstraps to its local publisher, so
 *    witness↔publisher↔responder chains the topic).
 *  - After seeing the question, the witness also relays it 6× (10s apart)
 *    with its own relay multiaddrs attached ("witness-dial") as a fallback
 *    path for any responder that did not get bootstrapped.
 *  - Direct-push bridge: a publish only reaches peers in OUR pubsub mesh,
 *    and on the churny public swarm that mesh fills with random subscribers
 *    — bridge-dialed responders may never receive the relay at all. Over
 *    every /p2p-circuit connection both sides speak INTEROP_PROTO: the
 *    witness pushes the question, responders push their answers back on
 *    the same connections, so a formed artifact bridge gives a fully
 *    deterministic Q&A path with no mesh luck in either direction.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { multiaddr } from '@multiformats/multiaddr'
import { createAgentNode } from '../src/node.js'

const topic = process.env.CHAT_TOPIC || 'gnostr'
const from = process.env.CHAT_FROM || 'copilot'
const needle = process.env.CHAT_NEEDLE || ''
const marker = process.env.CHAT_QUESTION_MARKER || ''
const answerPrefix = process.env.CHAT_ANSWER_PREFIX || 'responder-'
const publisherPrefix = process.env.CHAT_PUBLISHER_PREFIX || ''
const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS || 10 * 60 * 1000)
const dials = (process.env.CHAT_DIAL || '').split(',').map((s) => s.trim()).filter(Boolean)

const log = (m) => process.stderr.write('witness: ' + m + '\n')
const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'chat-witness-')), log })
ctx.node.services.pubsub.subscribe(topic)
/* with GNOSTR_RENDEZVOUS_SERVER=1 (workflow) we are the topic's directory:
 * responders that learn our addrs register here, and our periodic discover
 * dials them directly — relays and direct pushes reach them over real
 * connections instead of saturated public meshes. */
if (ctx.rendezvous) {
  ctx.rendezvous.join(topic).catch(() => {})
}
/* CHAT_ADDRS_FILE: record our dialable relay addrs (comma-separated) as soon
 * as they exist — the workflow uploads the file as a run artifact so matrix
 * legs on OTHER runners can dial us directly (the public gnostr mesh alone
 * does not reliably deliver between arbitrary runners). */
const addrsFile = process.env.CHAT_ADDRS_FILE || ''
if (addrsFile) {
  const tick = setInterval(() => {
    const addrs = ctx.node.getMultiaddrs().map(String).filter((a) => a.includes('/p2p-circuit'))
    if (addrs.length) {
      try { writeFileSync(addrsFile, addrs.join(',')) } catch { return }
      log('wrote relay addrs for the chat bridge (' + addrs.length + ' addrs)')
      clearInterval(tick)
    }
  }, 2000)
  tick.unref?.()
}
if (dials.length) {
  const dialAll = () => dials.forEach((d) => {
    /* d comes from CHAT_DIAL or unauthenticated git ads on the public
     * topic — multiaddr() throws synchronously on a bad addr, which would
     * kill the witness; dial errors are async and safe to swallow. */
    let ma
    try { ma = multiaddr(d) } catch { return }
    ctx.node.dial(ma).catch(() => {})
  })
  dialAll()
  setInterval(dialAll, 5000).unref()
}

let saw = null       /* single-envelope mode: the envelope */
let question = null  /* Q&A mode: { msg, fromPeer } */
let answer = null    /* Q&A mode: { msg, fromPeer } */

/* The witness swims in a churny public swarm (hundreds of connections); the
 * default connection manager prunes UNTAGGED connections first, and our
 * important relayed links (copilot's node, matrix-leg responders) carry no
 * tags — they get pruned within seconds of forming. Tag every peer that is
 * in our gnostr topic so the bridge connections survive. */
setInterval(() => {
  for (const p of ctx.node.services.pubsub.getPeers()) {
    try { ctx.node.tagPeer(p, 'gnostr-topic', { value: 1000, ttl: 25000 }) } catch { /* peer gone */ }
  }
}, 8000).unref?.()

const enc = new TextDecoder()
const out = new TextEncoder()

/* Direct-push bridge — see the header. The question and answers also travel
 * as plain JSON over INTEROP_PROTO streams on the circuit connections the
 * bridge artifact created (responders dial our relay addrs), bypassing
 * pubsub mesh membership entirely. */
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
    stream.send(out.encode(JSON.stringify(payload)))
    await stream.close()
  } catch { try { stream.abort() } catch { /* gone */ } }
}

let relayed = 0
let pushTimer = null
ctx.node.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic) return
  let msg
  try { msg = JSON.parse(enc.decode(evt.detail.data)) } catch { return }
  /* git ads from THIS RUN's matrix publishers: dial their advertised addrs */
  if (msg.type === 'git') {
    if (publisherPrefix && String(msg.name).startsWith(publisherPrefix) && Array.isArray(msg.addrs)) {
      for (const a of msg.addrs) {
        if (typeof a === 'string' && a.startsWith('/') && !dials.includes(a)) {
          dials.push(a)
          log('git ad from ' + msg.name + ' — added dial target ' + a.slice(0, 70) + '…')
        }
      }
    }
    return
  }
  if (msg.type !== 'chat') return
  const fromPeer = evt.detail.from?.toString() || 'unknown'
  if (marker) {
    if (typeof msg.text !== 'string' || !msg.text.includes(marker)) return
    if (msg.name === from && !question) {
      question = { msg, fromPeer }
      log('QUESTION from ' + from + ' (peer ' + fromPeer.slice(0, 12) + '…): ' + msg.text.slice(0, 120))
      /* relay 10× (10s apart) with OUR dialable relay addrs attached: any
       * responder that catches one can dial back directly. Relay circuits
       * are short-lived (~1 min) and re-dial-prone, so one shot is not
       * enough — the responder re-dials on its side too. */
      const addrs = ctx.node.getMultiaddrs().map(String).filter((a) => a.includes('/p2p-circuit'))
      log('witness relay addrs: ' + (addrs.join(' ') || '(none)'))
      for (const d of [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000]) {
        setTimeout(() => {
          if (done) return
          const relayMsg = { type: 'chat', name: 'witness', at: Date.now(),
            text: marker + ' witness-dial ' + addrs.join(' ') }
          ctx.node.services.pubsub.publish(topic, out.encode(JSON.stringify(relayMsg))).then(
            () => log('relayed the question with dial addrs (' + (++relayed) + '/10)'),
            (e) => log('relay failed: ' + e.message))
        }, d).unref?.()
      }
      /* direct-push bridge: also push the question over every circuit
       * connection (the bridge-dialed responders) right away and every 10s
       * until answered — a responder that connects late still gets it. */
      pushQuestion()
      pushTimer = setInterval(() => { if (!done) pushQuestion() }, 10000)
      pushTimer.unref?.()
    } else if (String(msg.name).startsWith(answerPrefix) && !answer) {
      answer = { msg, fromPeer }
      log('ANSWER from ' + msg.name + ' (peer ' + fromPeer.slice(0, 12) + '…): ' + msg.text.slice(0, 160))
    }
    checkPass('pubsub')
  } else if (!saw && msg.name === from && msg.text && msg.text.includes(needle)) {
    saw = { msg, fromPeer }
    log('heard envelope from ' + from + ' (peer ' + fromPeer.slice(0, 12) + '…): ' + msg.text.slice(0, 120))
    pass('witness received ' + from + '\'s envelope on ' + topic)
  }
})

/* Direct-push bridge: push the question over every circuit connection —
 * the responders bridge-dialed our relay addrs, so those are the peers that
 * matter. Negotiation failures are ignored (public peers don't speak
 * INTEROP_PROTO). */
function pushQuestion () {
  if (done || !marker || !question) return
  const addrs = ctx.node.getMultiaddrs().map(String).filter((a) => a.includes('/p2p-circuit'))
  const payload = { kind: 'question', text: marker + ' witness-dial ' + addrs.join(' ') }
  for (const conn of ctx.node.getConnections()) {
    if (!conn.remoteAddr.toString().includes('/p2p-circuit/')) continue
    const peer = conn.remotePeer
    ctx.node.dialProtocol(peer, INTEROP_PROTO).then(
      (stream) => {
        writeStreamJson(stream, payload)
        log('pushed the question directly to ' + peer.toString().slice(0, 12) + '…')
      },
      () => {})
  }
}

function checkPass (how) {
  if (question && answer && question.fromPeer !== answer.fromPeer) {
    pass('witness heard the question AND a real answer from a different peer (' + answer.msg.name + ', via ' + how + ')')
  }
}

/* Responders push their answers back over the same protocol — accept them
 * here; the connection's remotePeer is the responder's peer id, so the
 * different-peer proof still holds. */
if (marker) {
  /* libp2p 3.5.1 calls handlers as handler(stream, connection) */
  ctx.node.handle(INTEROP_PROTO, (stream, connection) => {
    readStreamJson(stream).then((payload) => {
      if (done || answer) return
      if (payload?.kind !== 'answer' || typeof payload.text !== 'string') return
      const fromPeer = connection.remotePeer.toString()
      answer = { msg: { name: String(payload.name || answerPrefix + 'direct'), text: payload.text }, fromPeer }
      log('ANSWER (direct) from ' + answer.msg.name + ' (peer ' + fromPeer.slice(0, 12) + '…): ' + payload.text.slice(0, 160))
      checkPass('direct stream')
    }, () => {})
  })
}

let done = false
async function pass (why) {
  if (done) return
  done = true
  console.log('WITNESS PASS: ' + why)
  if (marker && question && answer) {
    console.log('QUESTION: ' + question.msg.text)
    console.log('ANSWER:   ' + answer.msg.text + '  [peer ' + answer.fromPeer.slice(0, 16) + '…]')
  }
  await ctx.helia.stop()
  process.exit(0)
}
function fail (why) {
  if (done) return
  done = true
  /* stdout too: the workflow's verdict loop greps witness.out for BOTH
   * strings; stderr-only FAIL made every failure burn the full step
   * timeout instead of exiting at the verdict. */
  console.log('WITNESS FAIL: ' + why)
  console.error('WITNESS FAIL: ' + why)
  if (marker) {
    if (!question) console.error('  never saw a question from ' + from + ' containing "' + marker + '"')
    if (!answer) console.error('  never saw an answer from ' + answerPrefix + '* containing "' + marker + '"')
    if (question && answer && question.fromPeer === answer.fromPeer)
      console.error('  question and answer came from the SAME peer — not a real cross-instance answer')
  } else {
    console.error('  never heard an envelope from ' + from + ' containing "' + needle + '"')
  }
  process.exit(1)
}
setTimeout(() => fail('timed out after ' + timeoutMs + 'ms'), timeoutMs)
