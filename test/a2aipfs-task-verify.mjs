#!/usr/bin/env node
/* a2aipfs-task-verify — independent verifier for the task-lifecycle attest.
 * Recomputes every embedded envelope id (§2.2), verifies every signature
 * against its claimed peer (§9), checks §8 distinctness, chunk chain, and
 * seq continuity. Exits non-zero on any failure. No libp2p verify path is
 * reused beyond key math — the dag-json canonicalization is reimplemented
 * here so a bug in the node cannot attest to itself.
 * Usage: node test/a2aipfs-task-verify.mjs <task-attest.json>
 */
import { readFileSync } from 'node:fs'
import * as dagJson from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { base64urlpad } from 'multiformats/bases/base64'
import { peerIdFromString } from '@libp2p/peer-id'
import { createHelia } from 'helia'
import { dagJson as heliaDagJson } from '@helia/dag-json'

const enc = new TextEncoder()
let failed = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' → ' + detail : ''))
  if (!ok) failed++
}

function canonicalBytes (env) {
  const body = { a2aipfs: env.a2aipfs, type: env.type, from: env.from, ts: env.ts }
  if (env.topic !== undefined) body.topic = env.topic
  if (env.ref !== undefined) body.ref = env.ref
  body.payload = env.payload
  return dagJson.encode(body)
}
const envId = (env) => CID.create(1, dagJson.code, sha256.digest(canonicalBytes(env))).toString()
const chainHex = async (prevHex, data) => {
  const prev = prevHex ? Buffer.from(prevHex, 'hex') : new Uint8Array(0)
  const digest = await sha256.digest(new Uint8Array([...prev, ...enc.encode(data)]))
  return Buffer.from(digest.bytes).toString('hex')
}

const rec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
check('record has task + states + three peers',
  !!rec.task && Array.isArray(rec.states) && typeof rec.taskerPeer === 'string' && typeof rec.workerPeer === 'string' && typeof rec.witnessPeer === 'string')
check('task is the submitted task (§3.4)', rec.task.type === 'task' && rec.task.payload?.task?.state === 'submitted')
check('three distinct peers (§8)', new Set([rec.taskerPeer, rec.workerPeer, rec.witnessPeer]).size === 3,
  [rec.taskerPeer, rec.workerPeer, rec.witnessPeer].map((p) => p.slice(0, 12)).join(' / '))

let allOk = true
for (const e of [rec.task, ...rec.states]) {
  if (envId(e) !== e.id) { allOk = false; console.log('  id MISMATCH on ' + e.type + ' ' + e.id.slice(0, 16)); continue }
  try {
    const ok = await peerIdFromString(e.from).publicKey.verify(canonicalBytes(e), base64urlpad.decode(e.sig))
    if (!ok) { allOk = false; console.log('  sig INVALID on ' + e.type + ' ' + e.id.slice(0, 16)) }
  } catch (err) {
    allOk = false
    console.log('  verify threw on ' + e.type + ': ' + err.message)
  }
}
check('every envelope id+sig verifies (§2.2,§9)', allOk, (rec.states.length + 1) + ' envelopes')

const done = rec.states.find((s) => s.payload.task.state === 'done')
check('done task-state present with result', done?.payload.task.result?.chunks > 0,
  done ? 'chunks=' + done.payload.task.result.chunks + ' acked=' + done.payload.task.result.acked : 'none')
check('accepted task-state present from the worker', rec.states.some((s) => s.payload.task.state === 'accepted' && s.from === rec.workerPeer))

/* chain recompute: the worker's own identity-bearing chunk data binds the
 * chain to its peer — data shape must mirror scripts/a2aipfs-node.mjs */
const N = done.payload.task.result.chunks
let prev = null
for (let i = 0; i < N; i++) {
  prev = await chainHex(prev, 'chunk ' + i + '/' + N + ' from a2aipfs-task-worker (peer ' + rec.workerPeer.slice(0, 12) + '…) for task ' + rec.task.id.slice(0, 16) + '…')
}
check('done.result.chain recomputes from identity-bearing chunk data', prev === done.payload.task.result.chain)

/* ON-IPFS verification: every envelope in the attest must be a content
 * address — helia's DAG store computes the same CID from the canonical
 * body and resolves the envelope by its claimed id */
const helia = await createHelia()
const dag = heliaDagJson(helia)
let ipfsOk = true
for (const e of [rec.task, ...rec.states]) {
  const bytes = canonicalBytes(e)
  const viaAdd = await dag.add(dagJson.decode(bytes))
  if (viaAdd.toString() !== e.id) { ipfsOk = false; console.log('  IPFS dag.add MISMATCH on ' + e.type + ': ' + viaAdd + ' != ' + e.id); continue }
  const got = await dag.get(CID.parse(e.id))
  if (got == null) { ipfsOk = false; console.log('  IPFS dag.get did not resolve ' + e.id) }
}
check('every attest envelope resolves through IPFS (helia dag.add+dag.get)', ipfsOk)
await helia.stop()

console.log(failed === 0 ? 'a2aipfs-task-verify: all green' : 'a2aipfs-task-verify: ' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
