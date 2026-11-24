#!/usr/bin/env node
/* interop-ask.mjs — ask the CI interop question on the gnostr topic and
 * print the responder's answer verbatim.
 *
 * Exists so CI model legs (copilot / opencode) run ONE command instead of
 * hand-writing a libp2p node per leg (observed: beam-free spent 9 minutes
 * editing a hand-rolled ask script and never published before the witness's
 * window closed). The witness still verifies the real transport — this
 * script only removes the agent's coding roulette from the critical path.
 *
 * Behavior (matches the witness's pass criteria):
 *   1. joins the "gnostr" topic as a chat participant
 *   2. listens on GNOSTR_LISTEN (legs use /ip4/127.0.0.1/tcp/4017)
 *   3. waits 20s on the topic before sending (gossipsub mesh graft)
 *   4. publishes { type: 'chat', name: $CHAT_FROM, text: "<marker> <question>" }
 *   5. stays alive 120s printing every responder-* answer; the FIRST
 *   answer's full text goes to stdout verbatim; exit 0 on answer, 1 on timeout
 *
 * Env: INTEROP_QUESTION_MARKER (required), CHAT_FROM (default 'opencode'),
 *      QUESTION_TEXT (default asks platform/hostname), GNOSTR_LISTEN,
 *      ASK_SETTLE_MS (default 20000), ASK_KEEPALIVE_MS (default 120000)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'

const topic = process.env.INTEROP_TOPIC || 'gnostr'
const marker = process.env.INTEROP_QUESTION_MARKER || ''
const from = process.env.CHAT_FROM || 'opencode'
const questionText = process.env.QUESTION_TEXT ||
  'what platform/architecture and hostname are you running on? Answer with your real OS, arch and hostname.'
const SETTLE_MS = Number(process.env.ASK_SETTLE_MS || 20000)
const KEEPALIVE_MS = Number(process.env.ASK_KEEPALIVE_MS || 120000)
if (!marker) { process.stderr.write('ask: INTEROP_QUESTION_MARKER not set\n'); process.exit(1) }

const log = (m) => process.stderr.write('ask: ' + m + '\n')
const enc = new TextEncoder()
const dec = new TextDecoder()

const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'interop-ask-')), log })
ctx.node.services.pubsub.subscribe(topic)
log(from + ' on "' + topic + '" — settling ' + SETTLE_MS / 1000 + 's before asking (mesh graft)')

let answered = false
ctx.node.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic) return
  let msg
  try { msg = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
  if (msg.type !== 'chat' || typeof msg.text !== 'string') return
  if (!String(msg.name).startsWith('responder-')) return
  if (!msg.text.includes(marker.split('-').slice(0, 3).join('-'))) return
  const fromPeer = evt.detail.from?.toString() || 'unknown'
  log('ANSWER from ' + msg.name + ' (peer ' + fromPeer.slice(0, 12) + '…)')
  if (!answered) {
    answered = true
    /* the verdict artifact: full answer text verbatim on stdout */
    process.stdout.write(msg.text + '\n')
  }
})

await new Promise((r) => setTimeout(r, SETTLE_MS))
const envelope = { type: 'chat', name: from, at: Date.now(), text: marker + ' ' + questionText }
await ctx.node.services.pubsub.publish(topic, enc.encode(JSON.stringify(envelope)))
log('QUESTION published: ' + envelope.text.slice(0, 120))
/* republish every 15s while waiting — a publish can land in a pruned mesh */
const republish = setInterval(() => {
  if (answered) return
  envelope.at = Date.now()
  ctx.node.services.pubsub.publish(topic, enc.encode(JSON.stringify(envelope))).then(
    () => log('question republished'),
    () => {})
}, 15000)
republish.unref?.()

log('listening ' + KEEPALIVE_MS / 1000 + 's for responder-* answers…')
await new Promise((r) => setTimeout(r, KEEPALIVE_MS))
clearInterval(republish)
await ctx.helia.stop()
if (!answered) { log('no responder answer within the window'); process.exit(1) }
log('done — answer captured')
