#!/usr/bin/env node
/* a2aipfs-crypto-vectors — INDEPENDENT conformance check for the signed
 * TESTVECTORS/crypto-*.vector.json (SPEC.md §9/§11 M3.5). The verifier here
 * shares NO crypto code with the reference node: signatures verify via
 * @noble/curves, peer ids are hand-decoded from their multibase multihash,
 * ids recompute from @ipld/dag-json + sha2-256. Expected outcomes live in
 * each vector file; a mismatch fails the run. */
import { readFileSync, readdirSync } from 'node:fs'
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
const LIMIT = 1048576 /* §2.4 gossipsub envelope limit */

let pass = 0
let fail = 0
const ok = (v, m) => { if (v) { pass++; console.log('crypto-vectors: PASS ' + m) } else { fail++; console.error('crypto-vectors: FAIL ' + m) } }

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

/* hand-decode peer id → raw ed25519 public key. Any failure here is itself
 * a vector failure (the from field must be a well-formed peer id). */
function decodePubkey (from) {
  const bytes = base58btc.decode('z' + from)
  const [code, codeLen] = varint.decode(bytes)
  if (code !== 0x00) throw new Error('peer id multihash is not identity: 0x' + code.toString(16))
  const [len, lenLen] = varint.decode(bytes.subarray(codeLen))
  const protobuf = bytes.subarray(codeLen + lenLen)
  if (protobuf.length !== len) throw new Error('peer id multihash length mismatch')
  /* protobuf PublicKey: field1 varint (key type), field2 bytes (pubkey) */
  if (protobuf[0] !== 0x08 || protobuf[1] !== 0x01 || protobuf[2] !== 0x12 || protobuf[3] !== 0x20) {
    throw new Error('peer id is not an Ed25519 PublicKey protobuf')
  }
  return protobuf.subarray(4)
}

/* classify ONE envelope presentation. Returns 'accept' or the first rule
 * that fires — version first (§10 ignore), then shape, size (§2.4), id
 * recompute (§2.2), signature (§9). */
function classify (env) {
  if (!env || typeof env !== 'object') return 'shape:not-an-object'
  if (env.a2aipfs !== '1.0') return 'ignore:version' /* §10: newer/older major — ignore, not fail */
  const bytes = canonicalBytes(env)
  if (bytes.length > LIMIT) return 'size:§2.4'
  try {
    if (computeId(env) !== env.id) return 'id:§2.2'
    const pub = decodePubkey(env.from)
    if (!ed25519.verify(base64urlpad.decode(env.sig), bytes, pub)) return 'sig:§9'
    return 'accept'
  } catch (e) {
    return 'shape:' + (e?.message || e)
  }
}

const files = readdirSync(dir).filter((f) => f.startsWith('crypto-') && f.endsWith('.vector.json'))
ok(files.length >= 6, files.length + ' crypto vector files present')

for (const f of files) {
  const v = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  if (v.sequence) {
    /* dedup-by-id: first presentation accepts, second must drop */
    const seen = new Set()
    let drops = 0
    for (const env of v.sequence) {
      const r = classify(env)
      if (seen.has(env.id)) { drops++; continue }
      seen.add(env.id)
      ok(r === 'accept', v.vector + ' first presentation accepts (got ' + r + ')')
    }
    ok(drops === v.sequence.length - 1, v.vector + ' dedups by id — ' + drops + '/' + (v.sequence.length - 1) + ' re-presentation(s) dropped (§11)')
    continue
  }
  const r = classify(v.envelope)
  if (v.expect === 'accept') ok(r === 'accept', v.vector + ' accepted (id recomputed + noble ed25519 sig verified) — got ' + r)
  else if (v.expect === 'reject') ok(r.startsWith(v.rejectRule + ':'), v.vector + ' rejected on ' + v.rejectRule + ' — got ' + r)
  else { fail++; console.error('crypto-vectors: FAIL ' + v.vector + ' bad expect: ' + v.expect) }
}

console.log(fail === 0 ? 'a2aipfs-crypto-vectors: all green' : 'a2aipfs-crypto-vectors: ' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
