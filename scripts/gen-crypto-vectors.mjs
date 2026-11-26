#!/usr/bin/env node
/* generate TESTVECTORS/crypto-*.vector.json — DETERMINISTIC signed test
 * vectors for the §9/§11 crypto MUSTs. Run once (node scripts/gen-crypto-vectors.mjs);
 * the JSON files are committed and checked by test/a2aipfs-crypto-vectors.mjs
 * with a FULLY INDEPENDENT verifier (@noble/curves only, peer ids hand-decoded).
 *
 * Keys come from fixed 32-byte seeds so the vectors reproduce bit-for-bit.
 * Peer id = base58btc( identity-multihash( protobuf PublicKey{Type:Ed25519, Data:pub} ) ),
 * matching libp2p's peer-id derivation. Signature is pure ed25519 over the
 * canonical dag-json body — the same construction the reference node uses
 * and that verify-attest-noble.mjs verifies independently. */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as dagJson from '@ipld/dag-json'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { base64urlpad } from 'multiformats/bases/base64'
import { base58btc } from 'multiformats/bases/base58'
import { varint } from 'multiformats'
import { ed25519 } from '@noble/curves/ed25519.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'docs', 'spec', 'TESTVECTORS')
mkdirSync(dir, { recursive: true })

function keyFromSeed (label) {
  const seed = sha256.digest(new TextEncoder().encode('a2aipfs-vector-seed/' + label)).digest
  const pub = ed25519.getPublicKey(seed)
  const protobuf = new Uint8Array([0x08, 0x01, 0x12, 0x20, ...pub])
  const mh = new Uint8Array([0x00, 0x24, ...protobuf]) /* identity multihash, 36-byte digest */
  /* libp2p's peerId.toString() is base58btc WITHOUT the multibase prefix */
  return { seed, pub, peerId: base58btc.encode(mh).slice(1) }
}

function canonicalBytes (env) {
  const body = { a2aipfs: env.a2aipfs, type: env.type, from: env.from, ts: env.ts }
  if (env.topic !== undefined) body.topic = env.topic
  if (env.ref !== undefined) body.ref = env.ref
  body.payload = env.payload
  return dagJson.encode(body)
}

function computeId (env) {
  return CID.create(1, dagJson.code, sha256.digest(canonicalBytes(env))).toString()
}

function sign (seed, env) {
  return base64urlpad.encode(ed25519.sign(canonicalBytes(env), seed))
}

const asker = keyFromSeed('asker')
const responder = keyFromSeed('responder')
const witness = keyFromSeed('witness')
const TOPIC = 'a2aipfs/v1/vectors'

/* base envelope: valid in every respect */
function baseEnv (key, type, payload, opts = {}) {
  const env = { a2aipfs: '1.0', type, from: key.peerId, ts: 1730000000000, payload }
  if (opts.topic !== null) env.topic = opts.topic ?? TOPIC
  if (opts.ref) env.ref = opts.ref
  env.id = computeId(env)
  env.sig = sign(key.seed, env)
  return env
}

const vectors = []
function emit (name, data) {
  writeFileSync(join(dir, name + '.vector.json'), JSON.stringify(data, null, 2) + '\n')
  vectors.push(name)
}

/* 1. positive: signed query must fully verify (id recompute + sig) */
const q = baseEnv(asker, 'query', { question: 'what is interop?', tags: ['vectors'] })
emit('crypto-query-valid', { vector: 'crypto-query-valid', expect: 'accept', envelope: q })

/* 2. positive: correlated signed answer */
const a = baseEnv(responder, 'answer', { text: 'interop is two independent implementations talking.', facts: { name: 'vector-responder' } }, { ref: q.id })
emit('crypto-answer-valid', { vector: 'crypto-answer-valid', expect: 'accept', envelope: a })

/* 3. negative: payload altered AFTER signing; id recomputed over the
 * tampered body so the id check passes and the SIG check is what fails */
const tampered = JSON.parse(JSON.stringify(a))
tampered.payload.text = tampered.payload.text + ' TAMPERED'
tampered.id = computeId(tampered) /* attacker fixes the id… */
/* …but cannot re-sign without the key: keep a's signature */
tampered.sig = a.sig
emit('crypto-sig-tampered', { vector: 'crypto-sig-tampered', expect: 'reject', rejectRule: 'sig', envelope: tampered })

/* 4. negative: id swapped for a DIFFERENT envelope's id; sig is valid over
 * the true body — the id check must catch it */
const swapped = JSON.parse(JSON.stringify(q))
swapped.id = a.id
emit('crypto-id-mismatch', { vector: 'crypto-id-mismatch', expect: 'reject', rejectRule: 'id', envelope: swapped })

/* 5. negative: all-zero 64-byte signature over a well-formed envelope */
const forged = baseEnv(witness, 'task-state', { task: { state: 'working' } }, { ref: q.id })
forged.sig = base64urlpad.encode(new Uint8Array(64))
emit('crypto-forged-zero-sig', { vector: 'crypto-forged-zero-sig', expect: 'reject', rejectRule: 'sig', envelope: forged })

/* 6. negative: canonical body over the 1 MiB gossipsub limit (§2.4).
 * id+sig are valid over the oversize body — the SIZE rule must fire. */
const big = baseEnv(responder, 'answer', { text: 'x'.repeat(1048576 + 128) }, { ref: q.id })
emit('crypto-oversize', { vector: 'crypto-oversize', expect: 'reject', rejectRule: 'size', envelope: big })

/* 7. dedup: the same envelope id presented twice — the second must drop
 * (§11: deduplicate by id). Sequence vectors are checked by the crypto
 * checker; the shape checker skips files with a "sequence" key. */
const once = baseEnv(asker, 'announce', { card: { name: 'vector-agent', peerId: asker.peerId, protocolVersion: '1.0', supportedTypes: ['query', 'answer'], maxEnvelopeSize: 1048576, relayAddrs: [] } })
emit('crypto-dedup-sequence', { vector: 'crypto-dedup-sequence', expect: 'dedup-drop', sequence: [once, JSON.parse(JSON.stringify(once))] })

/* 8. positive: witness attest over the query/answer pair (§3.9/§8) */
const att = baseEnv(witness, 'attest', {
  exchange: { requestId: q.id, responseId: a.id },
  askerPeer: asker.peerId,
  responderPeer: responder.peerId,
  witnessPeer: witness.peerId,
  topic: TOPIC,
  observedAt: 1730000001000,
  requestText: q.payload.question,
  answerText: a.payload.text,
  ipfs: { verified: true, cids: { request: q.id, response: a.id }, via: 'helia dag-json add+get' }
})
emit('crypto-attest-valid', { vector: 'crypto-attest-valid', expect: 'accept', envelope: att })

console.log('wrote ' + vectors.length + ' crypto vectors: ' + vectors.join(', '))
console.log('peer ids: asker=' + asker.peerId + ' responder=' + responder.peerId + ' witness=' + witness.peerId)
