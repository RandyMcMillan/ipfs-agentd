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
