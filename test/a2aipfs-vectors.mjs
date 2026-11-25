#!/usr/bin/env node
/* a2aipfs-vectors — conformance check: every TESTVECTORS/*.vector.json must
 * behave as its "expect" field says (SPEC.md §11). Dependency-free: the
 * rules checked here are the machine-checkable MUSTs from §2/§3/§8 that do
 * not yet require signature verification (that lands with M3.5 crypto). */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'docs', 'spec', 'TESTVECTORS')
const TYPES = ['announce', 'query', 'answer', 'task', 'task-state', 'stream-chunk', 'ack', 'error', 'attest']
const TASK_STATES = ['submitted', 'working', 'input-required', 'auth-required', 'completed', 'canceled', 'failed', 'rejected']

let pass = 0
let fail = 0
const ok = (v, m) => { if (v) { pass++; console.log('vectors: PASS ' + m) } else { fail++; console.error('vectors: FAIL ' + m) } }
const isStr = (v) => typeof v === 'string' && v.length > 0

/* the acceptance rules, mirroring SPEC.md; returns null if acceptable,
 * otherwise the rule it violates */
function violation (e) {
  if (!e || typeof e !== 'object') return 'not an object'
  if (e.a2aipfs !== '1.0') return 'missing/unsupported a2aipfs version field (§2.1, §10)'
  if (!TYPES.includes(e.type)) return 'unknown type "' + e.type + '" (§2.1)'
  if (!isStr(e.id)) return 'missing id (§2.2)'
  if (!isStr(e.from)) return 'missing from peer id (§2)'
  if (!Number.isInteger(e.ts) || e.ts < 0) return 'missing/invalid ts (§2)'
  if (!isStr(e.sig)) return 'missing sig (§9)'
  if (e.topic !== undefined && !String(e.topic).startsWith('a2aipfs/v1/')) return 'topic outside a2aipfs/v1/ namespace (§4)'
  if (!e.payload || typeof e.payload !== 'object') return 'missing payload (§2)'
  switch (e.type) {
    case 'query':
      if (!isStr(e.payload.question)) return 'query without payload.question (§3.2)'
      break
    case 'answer':
      if (!isStr(e.payload.text)) return 'answer without payload.text (§3.3)'
      if (e.ref === undefined) return 'answer without correlation ref (§2.3)'
      break
    case 'task':
      if (e.payload.task?.state !== 'submitted') return 'task initial state must be submitted (§3.4)'
      break
    case 'task-state':
      if (!TASK_STATES.includes(e.payload.state)) return 'task-state not a valid A2A state (§3.5)'
      if (e.ref === undefined) return 'task-state without correlation ref (§2.3)'
      break
    case 'stream-chunk':
      if (!Number.isInteger(e.payload.seq) || e.payload.seq < 0) return 'stream-chunk without seq (§3.6)'
      if (typeof e.payload.last !== 'boolean') return 'stream-chunk without last flag (§3.6)'
      break
    case 'attest': {
      const p = e.payload
      if (!p.exchange || !isStr(p.exchange.requestId) || !isStr(p.exchange.responseId)) return 'attest without exchange ids (§3.9)'
      if (!isStr(p.askerPeer) || !isStr(p.responderPeer) || !isStr(p.witnessPeer) || !isStr(p.topic)) return 'attest missing peers/topic (§3.9)'
      if (p.askerPeer === p.responderPeer) return 'attest with askerPeer == responderPeer — self-talk proof (§8)'
      break
    }
  }
  return null
}

const files = readdirSync(dir).filter((f) => f.endsWith('.vector.json'))
ok(files.length >= 8, files.length + ' vector files present')

for (const f of files) {
  const v = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const why = violation(v.envelope)
  if (v.expect === 'accept') ok(why === null, v.vector + ' accepted' + (why ? ' — VIOLATION: ' + why : ''))
  else if (v.expect === 'ignore') ok(why !== null, v.vector + ' ignored (' + why + ')')
  else { fail++; console.error('vectors: FAIL ' + v.vector + ' has bad expect: ' + v.expect) }
}

console.log(fail === 0 ? 'a2aipfs-vectors: all green' : 'a2aipfs-vectors: ' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
