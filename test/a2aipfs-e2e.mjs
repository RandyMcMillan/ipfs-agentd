#!/usr/bin/env node
/* a2aipfs-e2e — three-node protocol conformance run (SPEC §2/§3/§5/§7/§8/§9).
 *
 *   witness (4120)  observes the exchange, verifies signatures, attests
 *   responder (4121) answers queries with signed answer envelopes
 *   asker (4122)     publishes the query, captures the first valid answer
 *   injector         (in-process) fires a garbage-sig answer and a
 *                    pre-standard {type:"chat"} envelope at the witness —
 *                    both MUST be ignored (§2.1, §9)
 *
 * The attest's id and signature are re-verified here with an independent
 * reimplementation of §2.2/§9 (dag-json CID + peer-key verify) so a bug in
 * the node's own verify path can't attest to itself.
 * Run: node test/a2aipfs-e2e.mjs
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
import { createAgentNode } from '../src/node.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = process.execPath
const script = join(root, 'scripts', 'a2aipfs-node.mjs')
const topic = 'a2aipfs/v1/interop-' + process.pid
const step = (s) => process.stderr.write('a2aipfs-e2e: ' + s + '\n')
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}
const enc = new TextEncoder()
const dec = new TextDecoder()

/* independent §2.2/§9 re-implementation for cross-checking the attest */
function canonicalBytes (env) {
  const body = { a2aipfs: env.a2aipfs, type: env.type, from: env.from, ts: env.ts }
  if (env.topic !== undefined) body.topic = env.topic
  if (env.ref !== undefined) body.ref = env.ref
  body.payload = env.payload
  return dagJson.encode(body)
}
const envId = (env) => CID.create(1, dagJson.code, sha256.digest(canonicalBytes(env))).toString()

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
  p.peerId = null
  p.queryId = null
  return p
}

const W = 4120; const R = 4121; const A = 4122
const attestFile = join(mkdtempSync(join(tmpdir(), 'a2aipfs-attest-')), 'attest.json')

const witness = start('witness', W, { A2AIPFS_ATTEST_FILE: attestFile })
const responder = start('responder', R, { A2AIPFS_DIAL: `/ip4/127.0.0.1/tcp/${W},/ip4/127.0.0.1/tcp/${A}` })
const asker = start('asker', A, { A2AIPFS_DIAL: `/ip4/127.0.0.1/tcp/${W},/ip4/127.0.0.1/tcp/${R}` })
/* negative-path witness: only the forged answer + pre-standard chat envelope
 * ever land on its topic — it MUST reject/ignore both and never attest.
 * The injector is in-process on loopback 4144; the neg witness dials it. */
const negTopic = topic + '-neg'
process.env.GNOSTR_LISTEN = '/ip4/127.0.0.1/tcp/4144'
const injector = await createAgentNode({ repoPath: mkdtempSync(join(tmpdir(), 'a2aipfs-inj-')), log: () => {} })
const negWitness = start('witness', 4123, { A2AIPFS_TOPIC: negTopic, A2AIPFS_TIMEOUT_MS: '30000', A2AIPFS_NAME: 'e2e-negwitness', A2AIPFS_DIAL: '/ip4/127.0.0.1/tcp/4144' })

const waitFor = (fn, ms) => new Promise((resolve) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    const v = fn()
    if (v || Date.now() - t0 > ms) { clearInterval(iv); resolve(v) }
  }, 250)
})

try {
  /* mesh settle */
  await new Promise((r) => setTimeout(r, 8000))
  check('witness reported ready', /witness up on/.test(witness.stderr_), witness.stderr_.split('\n').pop().slice(0, 80))
  check('responder reported ready', /responder up on/.test(responder.stderr_))
  check('asker published its query', /query published/.test(asker.stderr_))
  const qm = asker.stderr_.match(/query id: (\S+)/)
  const queryId = qm ? qm[1] : null
  check('query id is a CIDv1 dag-json CID', !!queryId && /^b[0-9a-z]{20,}/.test(queryId), queryId?.slice(0, 24))

  /* injector: garbage-sig answer + pre-standard chat envelope on the
   * negative topic — the negative witness MUST reject/ignore both */
  await injector.node.services.pubsub.subscribe(negTopic)
  await new Promise((r) => setTimeout(r, 3000))
  const fake = { a2aipfs: '1.0', type: 'answer', id: 'bafybeef', from: injector.node.peerId.toString(), ts: Date.now(), topic: negTopic, ref: queryId || 'bafyunknown', sig: base64urlpad.encode(new Uint8Array(64)), payload: { text: 'forged answer' } }
  await injector.node.services.pubsub.publish(negTopic, enc.encode(JSON.stringify(fake)))
  await injector.node.services.pubsub.publish(negTopic, enc.encode(JSON.stringify({ type: 'chat', name: 'legacy', at: Date.now(), text: 'pre-standard envelope' })))
  step('injector fired forged answer + pre-standard chat envelope on ' + negTopic)

  /* the exchange itself */
  const askerDone = await waitFor(() => asker.exitCode !== null, 80000)
  check('asker exited', askerDone !== null, 'exitCode=' + asker.exitCode)
  check('asker exit 0 (answer captured)', asker.exitCode === 0, asker.stdout_.slice(0, 100))
  check('answer text on stdout', /I run on/.test(asker.stdout_), asker.stdout_.split('\n')[0]?.slice(0, 90))
  check('answer came from the responder peer', responder.stderr_.includes('answer 1/'), responder.stderr_.match(/answer 1\/3 published, ref (\S+)/)?.[1]?.slice(0, 16))

  const witnessDone = await waitFor(() => witness.exitCode !== null, 45000)
  check('witness exited', witnessDone !== null, 'exitCode=' + witness.exitCode)
  check('witness printed WITNESS PASS', /WITNESS PASS/.test(witness.stdout_), witness.stdout_.split('\n').find((l) => l.includes('WITNESS'))?.slice(0, 90) || witness.stdout_.slice(0, 90))
  if (!/WITNESS PASS/.test(witness.stdout_)) step('witness stderr tail: ' + witness.stderr_.split('\n').filter((l) => !/peer:(dis)?connect/.test(l)).slice(-6).join(' | '))
  /* negative path: deterministic — nothing valid ever reaches negWitness */
  const negDone = await waitFor(() => negWitness.exitCode !== null, 40000)
  check('neg witness exited', negDone !== null, 'exitCode=' + negWitness.exitCode)
  check('neg witness never attested (WITNESS FAIL)', negWitness.exitCode === 1 && /WITNESS FAIL/.test(negWitness.stdout_))
  check('forged answer was rejected (§2.2/§9)', /answer not admissible: (invalid envelope signature|id does not recompute)/.test(negWitness.stderr_), negWitness.stderr_.match(/answer not admissible[^\n]*/)?.[0]?.slice(0, 80))
  check('pre-standard chat ignored (§2.1)', !/(QUERY|ANSWER) observed/.test(negWitness.stderr_))

  /* attest: structural + independent crypto cross-check */
  check('attest file written', existsSync(attestFile))
  if (existsSync(attestFile)) {
    const attest = JSON.parse(readFileSync(attestFile, 'utf8'))
    check('attest type/payload shape (§3.9)', attest.type === 'attest' && !!attest.payload.exchange?.requestId && !!attest.payload.exchange?.responseId)
    check('attest distinct peers (§8)', attest.payload.askerPeer !== attest.payload.responderPeer)
    check('attest requestId matches observed query', attest.payload.exchange.requestId === queryId)
    check('attest topic recorded', attest.payload.topic === topic)
    const idOk = envId(attest) === attest.id
    check('attest id recomputes (§2.2, independent)', idOk)
    let sigOk = false
    try { sigOk = await peerIdFromString(attest.from).publicKey.verify(canonicalBytes(attest), base64urlpad.decode(attest.sig)) } catch { sigOk = false }
    check('attest signature verifies against witness peer (§9, independent)', sigOk)
  }
} catch (e) {
  failed++
  step('EXCEPTION ' + (e?.stack || e))
} finally {
  for (const p of [witness, responder, asker, negWitness]) { try { p.kill('SIGKILL') } catch {} }
}

console.log(failed === 0 ? 'a2aipfs-e2e: all green' : 'a2aipfs-e2e: ' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
