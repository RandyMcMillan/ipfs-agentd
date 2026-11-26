#!/usr/bin/env node
/* a2aipfs-task-e2e — task lifecycle conformance (SPEC §3.4/§3.5/§3.6/§3.7/§7/§8/§9).
 *
 *   witness (4420)  observes task + task-state, verifies every envelope,
 *                   writes the task attest (verbatim signed envelopes)
 *   worker (4421)   executes the task: accepted → hash-chained stream-chunk
 *                   delivery over the direct stream → acks → done
 *   asker (4422)    submits the task (A2AIPFS_TASK=1), verifies each chunk's
 *                   signature AND hash chain, acks, requires task-state done
 *   injector        (in-process) fires a forged task-state (zero sig) on a
 *                   negative topic — the neg witness MUST reject it (§2.2,§9)
 *
 * Every envelope in the task attest is re-verified here with an independent
 * §2.2/§9 reimplementation, and the chunk chain is recomputed from scratch.
 * Run: node test/a2aipfs-task-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as dagJson from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { base64urlpad } from 'multiformats/bases/base64'
import { peerIdFromString } from '@libp2p/peer-id'
import { dagJson as heliaDagJson } from '@helia/dag-json'
import { createAgentNode } from '../src/node.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = process.execPath
const script = join(root, 'scripts', 'a2aipfs-node.mjs')
const topic = 'a2aipfs/v1/task-' + process.pid
const N = 4
const step = (s) => process.stderr.write('a2aipfs-task-e2e: ' + s + '\n')
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}
const enc = new TextEncoder()
const dec = new TextDecoder()

/* independent §2.2/§9 re-implementation */
function canonicalBytes (env) {
  const body = { a2aipfs: env.a2aipfs, type: env.type, from: env.from, ts: env.ts }
  if (env.topic !== undefined) body.topic = env.topic
  if (env.ref !== undefined) body.ref = env.ref
  body.payload = env.payload
  return dagJson.encode(body)
}
const envId = (env) => CID.create(1, dagJson.code, sha256.digest(canonicalBytes(env))).toString()
async function verifyEnv (env) {
  if (envId(env) !== env.id) return 'id does not recompute'
  try {
    return await peerIdFromString(env.from).publicKey.verify(canonicalBytes(env), base64urlpad.decode(env.sig)) ? null : 'sig invalid'
  } catch (e) { return 'verify threw: ' + e.message }
}
const chainHex = async (prevHex, data) => {
  const prev = prevHex ? Buffer.from(prevHex, 'hex') : new Uint8Array(0)
  const digest = await sha256.digest(new Uint8Array([...prev, ...enc.encode(data)]))
  return Buffer.from(digest.bytes).toString('hex')
}

/* independent ON-IPFS check through the injector's own helia node */
async function ipfsVerifyEnv (helia, env) {
  const dag = heliaDagJson(helia)
  const viaAdd = await dag.add(dagJson.decode(canonicalBytes(env)))
  if (viaAdd.toString() !== env.id) return 'helia dag.add CID ' + viaAdd + ' != ' + env.id
  const got = await dag.get(CID.parse(env.id))
  if (got == null) return 'helia dag.get(' + env.id + ') did not resolve'
  return null
}

function start (role, port, extraEnv) {
  const env = {
    ...process.env,
    A2AIPFS_ROLE: role,
    A2AIPFS_TOPIC: topic,
    A2AIPFS_NAME: 'e2e-' + role,
    A2AIPFS_TIMEOUT_MS: '90000',
    GNOSTR_LISTEN: '/ip4/127.0.0.1/tcp/' + port,
    GNOSTR_RENDEZVOUS_SERVER: role === 'witness' ? '1' : '',
    ...extraEnv
  }
  const p = spawn(nodeBin, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout_ = ''
  p.stderr_ = ''
  p.stdout.on('data', (d) => { p.stdout_ += d.toString() })
  p.stderr.on('data', (d) => { p.stderr_ += d.toString() })
  return p
}

const W = 4420; const K = 4421; const A = 4422
const taskFile = join(mkdtempSync(join(tmpdir(), 'a2aipfs-task-')), 'task-attest.json')

const witness = start('witness', W, { A2AIPFS_TASK_FILE: taskFile })
const worker = start('worker', K, { A2AIPFS_CHUNKS: String(N), A2AIPFS_DIAL: `/ip4/127.0.0.1/tcp/${W},/ip4/127.0.0.1/tcp/${A}` })
const asker = start('asker', A, { A2AIPFS_TASK: '1', A2AIPFS_DIAL: `/ip4/127.0.0.1/tcp/${W},/ip4/127.0.0.1/tcp/${K}` })
/* negative-path witness: only a forged task-state ever lands on its topic */
const negTopic = topic + '-neg'
process.env.GNOSTR_LISTEN = '/ip4/127.0.0.1/tcp/4445'
const injector = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'a2aipfs-tinj-')), log: () => {} })
const negWitness = start('witness', 4423, { A2AIPFS_TOPIC: negTopic, A2AIPFS_TIMEOUT_MS: '30000', A2AIPFS_NAME: 'e2e-negwitness', A2AIPFS_DIAL: '/ip4/127.0.0.1/tcp/4445' })

const waitFor = (fn, ms) => new Promise((resolve) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    const v = fn()
    if (v || Date.now() - t0 > ms) { clearInterval(iv); resolve(v) }
  }, 250)
})

try {
  await new Promise((r) => setTimeout(r, 8000))
  check('witness reported ready', /witness up on/.test(witness.stderr_))
  check('worker reported ready', /worker up on/.test(worker.stderr_))
  check('asker published its task', /task published/.test(asker.stderr_))
  const tm = asker.stderr_.match(/task id: (\S+)/)
  const taskId = tm ? tm[1] : null
  check('task id is a CIDv1 dag-json CID', !!taskId && /^b[0-9a-z]{20,}/.test(taskId), taskId?.slice(0, 24))

  /* injector: forged task-state (zero sig, valid ref) on the neg topic */
  await injector.node.services.pubsub.subscribe(negTopic)
  await new Promise((r) => setTimeout(r, 3000))
  const fake = { a2aipfs: '1.0', type: 'task-state', id: 'bafybeef', from: injector.node.peerId.toString(), ts: Date.now(), topic: negTopic, ref: taskId || 'bafyunknown', sig: base64urlpad.encode(new Uint8Array(64)), payload: { task: { state: 'done' } } }
  await injector.node.services.pubsub.publish(negTopic, enc.encode(JSON.stringify(fake)))
  step('injector fired forged task-state on ' + negTopic)

  /* the lifecycle itself */
  const askerDone = await waitFor(() => asker.exitCode !== null, 80000)
  check('asker exited', askerDone !== null, 'exitCode=' + asker.exitCode)
  check('asker exit 0 (task completed)', asker.exitCode === 0, asker.stdout_.slice(0, 110))
  check('verdict line on stdout', new RegExp('task complete: received ' + N + ' chunks').test(asker.stdout_), asker.stdout_.split('\n')[0]?.slice(0, 100))
  check('all chunks signature+chain verified by asker', (asker.stderr_.match(/verified \(seq /g) || []).length === N, (asker.stderr_.match(/verified \(seq /g) || []).length + '/' + N)
  check('acks written for every chunk', new RegExp(N + ' ack\\(s\\) written').test(asker.stderr_))

  const workerDone = await waitFor(() => worker.exitCode !== null, 30000)
  check('worker exited 0 after done', workerDone !== null && worker.exitCode === 0, 'exitCode=' + worker.exitCode)
  check('worker published done', /task-state done published/.test(worker.stderr_), worker.stderr_.match(/task-state done published[^\n]*/)?.[0]?.slice(0, 80))

  const witnessDone = await waitFor(() => witness.exitCode !== null, 45000)
  check('witness exited', witnessDone !== null, 'exitCode=' + witness.exitCode)
  check('witness printed WITNESS PASS (task lifecycle)', /WITNESS PASS: task lifecycle/.test(witness.stdout_), witness.stdout_.split('\n').find((l) => l.includes('WITNESS'))?.slice(0, 100))
  /* negative path */
  const negDone = await waitFor(() => negWitness.exitCode !== null, 40000)
  check('neg witness exited', negDone !== null, 'exitCode=' + negWitness.exitCode)
  check('neg witness never attested (WITNESS FAIL)', negWitness.exitCode === 1 && /WITNESS FAIL/.test(negWitness.stdout_))
  check('forged task-state rejected (§2.2/§9)', /task-state not admissible: (invalid envelope signature|id does not recompute)/.test(negWitness.stderr_), negWitness.stderr_.match(/task-state not admissible[^\n]*/)?.[0]?.slice(0, 90))

  /* task attest: independent crypto + chain recompute on every envelope */
  check('task attest file written', existsSync(taskFile))
  let rec = null
  if (existsSync(taskFile)) {
    rec = JSON.parse(readFileSync(taskFile, 'utf8'))
    check('task attest has task + states + peers', !!rec.task && Array.isArray(rec.states) && !!rec.taskerPeer && !!rec.workerPeer && !!rec.witnessPeer)
    check('task attest task id matches observed', rec.task.id === taskId)
    check('task attest distinct peers (§8)', new Set([rec.taskerPeer, rec.workerPeer, rec.witnessPeer]).size === 3)
    const all = [rec.task, ...rec.states]
    let allOk = true
    for (const e of all) {
      const why = await verifyEnv(e)
      if (why) { allOk = false; step('  envelope ' + e.type + ' FAIL: ' + why); break }
    }
    check('every attest envelope id+sig verifies (§2.2,§9, independent)', allOk, all.length + ' envelopes')
    check('task attest records IPFS verification', rec.ipfs?.verified === true, JSON.stringify(rec.ipfs?.cids || {}))
    let ipfsAllOk = true
    for (const e of all) {
      const why = await ipfsVerifyEnv(injector.helia, e)
      if (why) { ipfsAllOk = false; step('  envelope ' + e.type + ' IPFS FAIL: ' + why); break }
    }
    check('every attest envelope resolves through IPFS (helia dag.add+dag.get, independent)', ipfsAllOk, all.length + ' envelopes')
  }
  /* §6 Agent Card over IPNS: worker's card published under its peer key,
   * the asker must resolve THE WORKER's name to the announced cardCid */
  {
    const workerPeer = (worker.stderr_.match(/peer id: (\S+)/) || [])[1]
    const shortPeer = workerPeer ? workerPeer.slice(0, 12) : null
    const announcedCid = (worker.stderr_.match(/announce published on \S+ card (\S+)/) || [])[1]
    const resolved = shortPeer ? [...asker.stderr_.matchAll(new RegExp('CARD RESOLVED via IPNS ' + shortPeer + '… → (\\S+) \\(content matches', 'g'))].map((m) => m[1]) : []
    const published = [...worker.stderr_.matchAll(/CARD PUBLISHED via IPNS \S+… → (\S+)/g)].map((m) => m[1])
    check('worker announced a content-addressed Agent Card (§6)', !!announcedCid, announcedCid?.slice(0, 24))
    check('asker resolved the WORKER name via IPNS (§6)', resolved.length >= 1, resolved[0]?.slice(0, 24))
    check('IPNS-resolved CID == announced cardCid (§6)', resolved.includes(announcedCid))
    if (published.length) step('worker IPNS publish trace: ' + published.length + ' record(s) landed')
    check('states cover accepted + done from the worker', ['accepted', 'done'].every((s) => rec.states.some((x) => x.payload.task.state === s && x.from === rec.workerPeer)))
    const done = rec.states.find((x) => x.payload.task.state === 'done')
    check('done result carries chunk count', done?.payload.task.result?.chunks === N)
    /* chunk chain: the worker's done.result.chain must equal a from-scratch
     * recompute over the identity-bearing chunk data it streamed (verified
     * on the asker side; here we recompute from the done envelope itself —
     * the asker already proved the chain end-to-end) */
    if (done) {
      let prev = null
      for (let i = 0; i < N; i++) {
        prev = await chainHex(prev, 'chunk ' + i + '/' + N + ' from e2e-worker (peer ' + rec.workerPeer.slice(0, 12) + '…) for task ' + taskId.slice(0, 16) + '…')
      }
      check('done.result.chain recomputes from chunk data', done.payload.task.result.chain === prev)
    }
  }
} catch (e) {
  failed++
  step('EXCEPTION ' + (e?.stack || e))
} finally {
  for (const p of [witness, worker, asker, negWitness]) { try { p.kill('SIGKILL') } catch {} }
  try { await injector.node.stop() } catch {}
}

console.log(failed === 0 ? 'a2aipfs-task-e2e: all green' : 'a2aipfs-task-e2e: ' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
