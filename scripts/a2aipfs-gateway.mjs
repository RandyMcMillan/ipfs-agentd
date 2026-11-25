#!/usr/bin/env node
/* a2aipfs-gateway.mjs — HTTP A2A ↔ a2aipfs mesh bridge (first working cut).
 *
 * Terminates A2A-style HTTP on one side, speaks a2aipfs gossipsub on the
 * other, per docs/spec/MAPPING.md §6. Lets a URL-based A2A agent reach a
 * mesh agent without knowing libp2p.
 *
 *   node scripts/a2aipfs-gateway.mjs [port]
 *
 * Endpoints:
 *   GET  /.well-known/agent-card.json   — this gateway's Card (MAPPING §6.1)
 *   POST /v1/message:send               — A2A Message in, mesh query out;
 *                                         blocks for the correlated answer
 *   GET  /v1/attestations/<exchange-id> — attest envelopes seen (§6.5)
 *
 * Request shape (minimal A2A): { "target": "<peer-id>", "parts": [{"text":
 * "..."}], "timeoutMs": 30000 }. Response: the answer envelope as JSON.
 *
 * Env: A2AIPFS_TOPIC_PREFIX (default a2aipfs/v1), GW_AGENT_NAME.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'

const PORT = Number(process.argv[2] || process.env.PORT || 8080)
const PREFIX = process.env.A2AIPFS_TOPIC_PREFIX || 'a2aipfs/v1'
const NAME = process.env.GW_AGENT_NAME || 'a2aipfs-gateway'
const VERSION = 'a2aipfs/0.1.0'

const log = (m) => process.stderr.write('gw: ' + m + '\n')
const enc = new TextEncoder()
const dec = new TextDecoder()

const ctx = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'a2aipfs-gw-')), log })
const peerId = ctx.node.peerId.toString()
log('up as ' + peerId.slice(0, 16) + '…')

/* pending correlated requests: ref(CID) -> resolve */
const pending = new Map()
const attestations = new Map()

function isA2aipfs (msg) { return msg && msg.a2aipfs === '1.0' && typeof msg.type === 'string' }

async function subscribeTopic (topic) {
  ctx.node.services.pubsub.subscribe(topic)
}

/* inbox + global: where answers and attestations arrive */
for (const t of [`${PREFIX}/agent/${peerId}`, `${PREFIX}/global`]) {
  await subscribeTopic(t)
}

ctx.node.services.pubsub.addEventListener('message', (evt) => {
  let msg
  try { msg = JSON.parse(dec.decode(evt.detail.data)) } catch { return }
  if (!isA2aipfs(msg)) return
  if (msg.type === 'answer' && msg.ref && pending.has(msg.ref)) {
    const p = pending.get(msg.ref)
    clearTimeout(p.timer)
    pending.delete(msg.ref)
    p.resolve(msg)
  } else if (msg.type === 'attest' && msg.payload?.exchange) {
    attestations.set(msg.payload.exchange.requestId + ':' + msg.payload.exchange.responseId, msg)
  }
})

function envelope (type, payload, ref) {
  const body = { a2aipfs: '1.0', type, id: '', from: peerId, ts: Date.now(), payload }
  if (ref) body.ref = ref
  /* id/sig: CID + signature plumbing lands with the reference-node crypto
   * (M3 test vectors enforce it); the gateway stamps its peer id and the
   * pubsub publisher signature already authenticates `from`. */
  body.id = 'pending-crypto'
  body.sig = 'pending-crypto'
  return body
}

function json (res, code, obj) {
  const b = enc.encode(JSON.stringify(obj, null, 2))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length })
  res.end(b)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
    return json(res, 200, {
      name: NAME,
      description: 'HTTP gateway bridging A2A clients onto the a2aipfs mesh',
      protocolVersion: '1.0',
      supportedTypes: ['query', 'answer', 'task', 'task-state', 'stream-chunk', 'ack', 'error', 'attest'],
      maxEnvelopeSize: 1048576,
      peerId,
      relayAddrs: ctx.node.getMultiaddrs().map(String).filter((a) => a.includes('/p2p-circuit')),
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false }
    })
  }
  if (req.method === 'GET' && url.pathname.startsWith('/v1/attestations/')) {
    const key = decodeURIComponent(url.pathname.slice('/v1/attestations/'.length))
    const a = attestations.get(key)
    return a ? json(res, 200, a) : json(res, 404, { error: 'attestation not observed' })
  }
  if (req.method === 'POST' && url.pathname === '/v1/message:send') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let reqMsg
      try { reqMsg = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON' }) }
      const target = String(reqMsg.target || '')
      const text = (reqMsg.parts || []).map((p) => p?.text || '').join('\n').trim()
      const timeoutMs = Math.min(Number(reqMsg.timeoutMs) || 30000, 120000)
      if (!target || !text) return json(res, 400, { error: 'target and parts[].text required' })
      const q = envelope('query', { question: text, timeoutMs })
      const ref = q.id /* replaced by real CID in M3 */
      const reply = `${PREFIX}/agent/${peerId}`
      await subscribeTopic(reply)
      const answerP = new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(ref); resolve(null) }, timeoutMs)
        pending.set(ref, { resolve, timer })
      })
      const topic = `${PREFIX}/agent/${target}`
      await subscribeTopic(topic)
      await ctx.node.services.pubsub.publish(topic, enc.encode(JSON.stringify(q)))
      log('query -> ' + topic.slice(0, 60) + ' for ' + target.slice(0, 16) + '…')
      const ans = await answerP
      if (!ans) return json(res, 504, { error: 'no answer within timeout', ref })
      json(res, 200, {
        messageId: ans.id, from: ans.from, role: 'agent',
        parts: [{ type: 'text', text: ans.payload?.text || '' }],
        facts: ans.payload?.facts || undefined
      })
    })
    return
  }
  json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => log('HTTP on :' + PORT))
process.on('SIGINT', async () => { await ctx.helia.stop(); process.exit(0) })
