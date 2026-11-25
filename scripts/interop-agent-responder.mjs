#!/usr/bin/env node
/* interop-agent-responder.mjs — AI-agent responder for the copilot-pair
 * interop leg. Receives the run's question on the gnostr topic, delegates
 * the ANSWER to a LOCAL copilot CLI instance (two Copilot agents talking
 * through the bridge), and publishes the result as a responder-* envelope
 * so the witness's different-peer proof holds.
 *
 * Env: INTEROP_QUESTION_MARKER (required), COPILOT_FROM (default
 *      responder-copilot), INTEROP_TOPIC (default gnostr), GITHUB_TOKEN
 *      (copilot CLI billing), ANSWER_TIMES (default 3), WINDOW_MS (default
 *      540000).
 *
 * Exit: 0 if at least one answer was published, 1 otherwise. If copilot
 * itself fails, this script publishes NOTHING and exits 1 — a fallback
 * canned answer would fake the exchange, and the witness's proof would be
 * worthless.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { multiaddr } from '@multiformats/multiaddr'
import { createAgentNode } from '../src/node.js'

const topic = process.env.INTEROP_TOPIC || 'gnostr'
const marker = process.env.INTEROP_QUESTION_MARKER || ''
const name = process.env.COPILOT_FROM || 'responder-copilot'
const ANSWER_TIMES = Number(process.env.ANSWER_TIMES || 3)
const WINDOW_MS = Number(process.env.WINDOW_MS || 540000)
if (!marker) { process.stderr.write('agent-responder: INTEROP_QUESTION_MARKER not set\n'); process.exit(1) }
if (!process.env.GITHUB_TOKEN) { process.stderr.write('agent-responder: GITHUB_TOKEN not set (copilot billing)\n'); process.exit(1) }

const log = (m) => process.stderr.write('agent-responder: ' + m + '\n')
const enc = new TextEncoder()
const dec = new TextDecoder()

const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'interop-agent-responder-')), log })
ctx.node.services.pubsub.subscribe(topic)
log(name + ' on "' + topic + '" — answering questions matching "' + marker + '" via copilot CLI')

const INTEROP_PROTO = '/ipfs-agentd/interop/1.0.0'
/* questions can arrive over a direct push from the witness, not only via
 * pubsub mesh luck — a pushed question MUST be answered exactly like a
 * pubsub one (the pair leg's witness learns our loopback addr and pushes;
 * the previous drain-only handler silently dropped every push). */
ctx.node.handle(INTEROP_PROTO, (stream) => {
  readStreamJson(stream).then((payload) => {
    if (payload?.kind === 'question' && typeof payload.text === 'string' && payload.text.includes(marker)) {
      log('question pushed directly by the witness — delegating to copilot')
      answer(payload.text)
    }
  }, () => {})
})

const readStreamJson = async (stream) => {
  const dec2 = new TextDecoder()
  const parts = []
  for await (const chunk of stream) {
    const b = chunk instanceof Uint8Array ? chunk : chunk.slice()
    parts.push(b)
    if (parts.reduce((n, c) => n + c.length, 0) > 65536) break
  }
  return JSON.parse(parts.map((c) => dec2.decode(c, { stream: true })).join('') + dec2.decode())
}

const writeStreamJson = async (stream, payload) => {
  try {
    stream.send(enc.encode(JSON.stringify(payload)))
    await stream.close()
  } catch { try { stream.abort() } catch { /* gone */ } }
}

let answers = 0
let answering = false
let lastAnswer = 0

function askCopilot (question) {
  return new Promise((resolve, reject) => {
    const prompt = 'You are an agent answering a question from another agent over a peer-to-peer ' +
      'network. Answer this question in ONE line, plainly, with only facts you actually know: ' + question
    /* 30 is the CLI minimum for --max-ai-credits (10 exits rc=1 with
     * 'Invalid value ... Use at least 30 AI credits' — observed pair run
     * 45689887974: every delegation died at preflight) */
    const args = ['--yolo', '--max-ai-credits', '30', '-p', prompt]
    log('asking copilot: ' + question.slice(0, 80))
    const p = spawn('copilot', args, { env: process.env })
    let out = ''
    let err = ''
    const kill = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('copilot timeout')) }, 150000)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => { clearTimeout(kill); reject(e) })
    p.on('close', (rc) => {
      clearTimeout(kill)
      const text = out.trim().split('\n').filter(Boolean).join(' ').slice(0, 500)
      if (rc === 0 && text) resolve(text)
      else reject(new Error('copilot rc=' + rc + ': ' + (err || out).slice(0, 300)))
    })
  })
}

async function answer (questionText) {
  if (answering) return
  if (answers >= ANSWER_TIMES) return
  if (Date.now() - lastAnswer < 10000) return
  answering = true
  try {
    const copilotSays = await askCopilot(questionText)
    lastAnswer = Date.now()
    answers++
    /* the marker leads the text so the asker's capture filter
     * (first 3 dash segments of ITS marker) matches — observed pair run
     * 45713689397: the asker never captured our answer because the text
     * contained no marker fragment at all. */
    const answerText = marker + ' answer from ' + name + ' (peer ' + ctx.node.peerId.toString().slice(0, 12) + '…, host ' + os.hostname() +
      '): ' + copilotSays + ' — I run on ' + os.platform() + '/' + os.arch()
    await ctx.node.services.pubsub.publish(topic, enc.encode(JSON.stringify({ type: 'chat', name, at: Date.now(), text: answerText })))
    log('answer ' + answers + '/' + ANSWER_TIMES + ' published')
    const payload = { kind: 'answer', name, text: answerText }
    for (const conn of ctx.node.getConnections()) {
      ctx.node.dialProtocol(conn.remotePeer, INTEROP_PROTO).then(
        (stream) => writeStreamJson(stream, payload), () => {})
    }
  } catch (e) {
    log('copilot answer FAILED — publishing nothing: ' + (e?.message || e))
  } finally {
    answering = false
  }
}

ctx.node.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic) return
  let msg
  try { msg = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
  if (msg.type !== 'chat' || typeof msg.text !== 'string') return
  if (!msg.text.includes(marker)) return
  if (msg.name === name || String(msg.name).startsWith('responder-')) return
  if (msg.name === 'witness') {
    /* witness relay: carry dial addrs, not a question */
    const m = msg.text.match(/witness-dial ((?:\/\S+)+)/)
    if (m) for (const a of m[1].split(/\s+/)) {
      try { ctx.node.dial(multiaddr(a)).then(() => log('dialed witness ' + a.slice(0, 50)), () => {}) } catch { /* bad addr */ }
    }
    return
  }
  log('question from ' + msg.name + ' — delegating to copilot')
  answer(msg.text)
})

setTimeout(async () => {
  log('window over — ' + answers + ' answer(s) published')
  await ctx.helia.stop()
  process.exit(answers > 0 ? 0 : 1)
}, WINDOW_MS).unref?.()
