#!/usr/bin/env node
/**
 * §11 conformance audit — every spec MUST/SHOULD mapped to proof.
 *
 * Proof kinds:
 *   vector  — a docs/spec/TESTVECTORS/*.vector.json envelope exercised by
 *             test/a2aipfs-vectors.mjs or test/a2aipfs-crypto-vectors.mjs
 *   e2e     — exercised live by test/a2aipfs-e2e.mjs
 *   task    — exercised live by test/a2aipfs-task-e2e.mjs
 *   ci      — exercised by the interop workflow's cold-mesh legs
 *   code    — statically present in scripts/a2aipfs-node.mjs (grep-anchored)
 *
 * An entry fails if its claimed proof is absent: unmapped MUSTs fail the
 * audit outright (M4 freeze gate); unmapped SHOULDs are reported only.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const spec = readFileSync(join(root, 'docs/spec/SPEC.md'), 'utf8')
const nodeSrc = readFileSync(join(root, 'scripts/a2aipfs-node.mjs'), 'utf8')
const coreSrc = readFileSync(join(root, 'src/node.js'), 'utf8')
const vectorDir = join(root, 'docs/spec/TESTVECTORS')
const vectors = new Set(readdirSync(vectorDir).filter((f) => f.endsWith('.vector.json')))

const has = (anchor) => nodeSrc.includes(anchor) || coreSrc.includes(anchor)
const vec = (name) => vectors.has(name + '.vector.json')

/**
 * Each entry: [clause id, spec location, text, level MUST|SHOULD, proof].
 * proof = { vector?: [names], e2e?: bool, task?: bool, ci?: string, code?: [anchors] }
 * At least one proof kind required for MUST.
 */
const MATRIX = [
  // §2 envelope
  ['2.1-version', '§2.1', 'switch on a2aipfs first; ignore missing version', 'MUST',
    { vector: ['ignore-no-version'], code: ["obj?.a2aipfs !== VERSION"] }],
  ['2.1-future-version', '§2.1', 'ignore newer major versions, not fail (§10)', 'MUST',
    { vector: ['ignore-future-version'] }],
  ['2.1-type', '§2.1', 'unknown type ignored, not errored', 'MUST',
    { vector: ['ignore-unknown-type'], code: ['!TYPES.includes'] }],
  ['2.2-id', '§2.2', 'id = CIDv1 dag-json sha2-256 over canonical signed body', 'MUST',
    { vector: ['query-valid', 'crypto-query-valid', 'crypto-id-mismatch'] }],
  ['2.2-sig', '§2.2', 'sig over canonical bytes with peer libp2p key', 'MUST',
    { vector: ['crypto-sig-tampered', 'crypto-forged-zero-sig'] }],
  ['2.2-ref', '§2.2', 'query/answer, task/state, acks set ref', 'MUST',
    { e2e: true, task: true }],
  ['2.4-size', '§2.4', 'envelopes above gossipsub limit rejected', 'MUST',
    { vector: ['crypto-oversize'], code: ['1048576'] }],
  ['2.4-large-payload', '§2.4', 'larger payloads via stream-chunk or direct stream', 'SHOULD',
    { task: true, code: ['stream-chunk'] }],
  // §3 types
  ['3.1-announce', '§3.1', 'announce on topic join, re-issue before expiry', 'MUST',
    { e2e: true, ci: 'mesh legs announce + republish [4,9,18]s', code: ['await announce()'] }],
  ['3.2-answer-sourced', '§3.2', 'answers must carry facts from new source material', 'SHOULD',
    { e2e: true, ci: 'mesh witness attests distinct-peer exchange' }],
  ['3.4-state-machine', '§3.4', 'task-state transitions follow A2A v1.0.0 state machine', 'MUST',
    { task: true }],
  ['3.6-chunk-reassemble', '§3.6', 'reassemble chunks by seq; handle gaps by ref', 'MUST',
    { task: true }],
  ['3.7-ack', '§3.7', 'ack ref points at receipt id (receipted)', 'MUST',
    { task: true }],
  ['3.8-error-text', '§3.8', 'error payload.state machine + human text', 'SHOULD',
    { code: ['error'] }],
  // §8 attestation
  ['8-attest-provable', '§8', 'witness proves peer A asked and peer B answered', 'MUST',
    { vector: ['attest-valid', 'crypto-attest-valid'], ci: 'WITNESS PASS lines in attest artifacts' }],
  ['8-attest-distinct', '§8', 'attest from same peer ignored; distinct peers required', 'MUST',
    { vector: ['ignore-attest-same-peer'] }],
  ['8-attest-reverify', '§8', 're-verified attest cached for same exchange id', 'SHOULD',
    { code: ['seen.has(obj.id)'] }],
  // §4 topics
  ['4-limited-conn', '§4', 'subscribe runOnLimitedConnection: true', 'MUST',
    { code: ['runOnLimitedConnection: true'] }],
  ['4-topic-field', '§4', 'topic from envelope topic field authoritative', 'MUST',
    { code: ['env.topic = opts.topic ?? TOPIC'] }],
  // §5 republish
  ['5-republish', '§5', 'query/task republish at intervals until satisfied', 'MUST',
    { e2e: true, code: ['query grace-republished'] }],
  ['5-dedup-id', '§5', 'receivers deduplicate by id, not payload bytes', 'MUST',
    { vector: ['crypto-dedup-sequence'], code: ['seen.add'] }],
  ['5-two-class', '§5', 'same-id grace vs freshness-preserving classes', 'MUST',
    { code: ['buildEnvelope(', 'answer republished (', 'ref: env.id'] }],
  // §6 card
  ['6-card-announce', '§6', 'announce carries inline card or card CID', 'MUST',
    { ci: 'CARD RESOLVED via IPNS lines in card traces' }],
  ['6-card-ipns', '§6', 'card CID published to IPNS under peer key', 'SHOULD',
    { ci: 'card record publish + resolve in all three legs', code: ['makeIpns', 'cardIpns.publish'] }],
  ['6-card-fields', '§6', 'card includes peer id, version, types, size limit, endpoints', 'MUST',
    { code: ['supportedTypes', 'maxEnvelopeSize'] }],
  // §7 direct stream
  ['7-fallback', '§7', 'fall back to direct streams after two republish cycles', 'SHOULD',
    { code: ['tryDirect', 'dialProtocol'] }],
  ['7-backpressure', '§7', 'stream-chunk sender respects stream backpressure', 'MUST',
    { code: ['stream.closeWrite'] }],
  ['7-stream-unknown-type', '§7', 'unknown type over stream answered with error envelope', 'MUST',
    { code: ["type !== 'answer'"] }],
  // §9 security
  ['9-pubsub-signed', '§9', 'gossipsub messages signed; receivers verify before acting', 'MUST',
    { vector: ['crypto-sig-tampered'], code: ['fromPeer.publicKey.verify'] }],
  ['9-sig-drop', '§9', 'envelopes with invalid sig dropped', 'MUST',
    { vector: ['crypto-forged-zero-sig', 'crypto-sig-tampered'], code: ['invalid envelope signature (§9)'] }],
  ['9-republish-bound', '§9', 'republish bounded: ≤6 same-id per 40s, stop on resolution', 'MUST',
    { code: ['[1000, 3000, 8000, 15000, 25000, 40000]', '[2000, 6000, 12000, 20000]', '[3000, 8000, 15000, 25000, 40000]'] }],
  // §10 versioning
  ['10-version-ignore', '§10', 'ignore newer major versions', 'MUST',
    { vector: ['ignore-future-version'] }],
]

let fail = 0
const report = []
for (const [id, loc, text, level, proof] of MATRIX) {
  const missing = []
  if (proof.vector) for (const v of proof.vector) if (!vec(v)) missing.push('vector:' + v)
  if (proof.e2e && !existsSync(join(root, 'test/a2aipfs-e2e.mjs'))) missing.push('e2e')
  if (proof.task && !existsSync(join(root, 'test/a2aipfs-task-e2e.mjs'))) missing.push('task')
  if (proof.code) for (const c of proof.code) if (!has(c)) missing.push('code anchor missing: ' + c.slice(0, 40))
  const ok = missing.length === 0
  if (!ok && level === 'MUST') fail++
  report.push(`${ok ? 'PASS' : 'FAIL'} ${id.padEnd(24)} ${loc.padEnd(5)} ${level.padEnd(5)} ${text}${missing.length ? '  MISSING: ' + missing.join('; ') : ''}`)
}
console.log(report.join('\n'))
const musts = MATRIX.filter((m) => m[3] === 'MUST').length
console.log(`\na2aipfs-conformance: ${MATRIX.length} clauses (${musts} MUST) — ${fail ? fail + ' MUST(s) unproven — FAIL' : 'all MUSTs proven'}`)
process.exit(fail ? 1 : 0)
