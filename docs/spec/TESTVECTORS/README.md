# a2aipfs test vectors

Each vector file is a JSON object:

```json
{
  "vector": "<name>",
  "envelope": { ... },            // the message under test (raw JSON)
  "expect": "accept | ignore",
  "because": "which MUST/SHOULD this enforces (SPEC.md section)"
}
```

Conformance: `test/a2aipfs-vectors.mjs` loads every `*.vector.json` here and
checks the envelope against `SCHEMAS/` plus the discrimination rules in
SPEC.md §2.1. `expect: accept` vectors MUST validate; `expect: ignore`
vectors MUST fail validation or be dropped by discrimination. Vectors are
deterministic — no signatures are verified here (crypto enforcement lands
with the reference-node signing work; see SPEC.md §9 and the M3.5 note in
the plan).

## crypto-*.vector.json (M3.5, signed)

The `crypto-*` files are DETERMINISTIC SIGNED vectors produced by
`scripts/gen-crypto-vectors.mjs` (fixed 32-byte seeds — regenerate
bit-for-bit with `node scripts/gen-crypto-vectors.mjs`). They cover the
§9/§11 crypto MUSTs: valid signed `query`/`answer`/`attest` envelopes
(`expect: accept`), a payload tampered post-signing (`rejectRule: sig`), an
id swapped for another envelope's id (`rejectRule: id`), an all-zero
signature (`rejectRule: sig`), a body over the 1 MiB gossipsub limit
(`rejectRule: size`, §2.4), and a two-element `sequence` proving
dedup-by-id (§11).

`test/a2aipfs-crypto-vectors.mjs` verifies them with a FULLY INDEPENDENT
code path: signatures via `@noble/curves`, peer ids hand-decoded from their
multibase multihash, ids recomputed from `@ipld/dag-json` + sha2-256 — no
libp2p code shared with the reference node. Classification order matches
§10/§2/§2.4/§2.2/§9: version (ignore) → shape → size → id recompute →
signature.
