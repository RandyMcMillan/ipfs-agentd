#!/usr/bin/env node
/* listen-chat.mjs — witness node for the Copilot chat interop leg (PoC).
 *
 * Subscribes to CHAT_TOPIC and waits for one chat envelope from CHAT_FROM
 * whose text contains CHAT_NEEDLE. Exits 0 the moment it arrives (printing
 * the envelope), 1 on timeout. CHAT_DIAL (optional multiaddr, repeated every
 * 5s) lets the witness reach a publisher on a deterministic address — public-
 * swarm mesh formation alone is probabilistic (see the fetch-by-name retry in
 * test/interop-fetch.mjs), so an explicit dial makes the witness reliable.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { multiaddr } from '@multiformats/multiaddr'
import { createAgentNode } from '../src/node.js'

const topic = process.env.CHAT_TOPIC || 'gnostr'
const from = process.env.CHAT_FROM || 'copilot'
const needle = process.env.CHAT_NEEDLE || 'interop-ok'
const dial = process.env.CHAT_DIAL || ''
const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS || 300000)
const log = (m) => process.stderr.write('witness: ' + m + '\n')

let done = false
const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'witness-')), log })
ctx.node.services.pubsub.subscribe(topic)
ctx.node.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic || done) return
  let msg
  try { msg = JSON.parse(new TextDecoder().decode(evt.detail.data)) } catch { return }
  if (msg.type !== 'chat' || msg.name !== from) return
  log('chat from ' + msg.name + ': ' + msg.text)
  if (!String(msg.text).includes(needle)) return
  done = true
  console.log('WITNESS PASS: envelope from "' + from + '" on "' + topic + '" contains "' + needle + '"')
})

if (dial) {
  ctx.node.dial(multiaddr(dial)).catch(() => { /* publisher not up yet — retried below */ })
  const dialer = setInterval(() => {
    if (done) return
    ctx.node.dial(multiaddr(dial)).catch(() => {})
  }, 5000)
  dialer.unref()
}

const deadline = Date.now() + timeoutMs
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000))
await ctx.helia.stop().catch(() => {})
if (!done) {
  console.log('WITNESS FAIL: no envelope from "' + from + '" containing "' + needle + '" within ' + timeoutMs + 'ms')
  process.exit(1)
}
