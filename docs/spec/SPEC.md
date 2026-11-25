# a2aipfs Specification

Version 0.1.0-draft. Status: DRAFT — not yet frozen; see `A2A-IPFS-PLAN.md`
for the specification program and `IMPLEMENTATION-NOTES.md` for the running
reference implementation.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD
NOT", "RECOMMENDED", "MAY" in this document are to be interpreted as
described in RFC 2119.

## 1. Scope and terminology

a2aipfs binds the A2A (Agent2Agent) standard to the IPFS/libp2p stack. It
specifies:

- an envelope format for agent messages over libp2p gossipsub,
- a set of message types for agent discovery, query/answer, tasking,
  streaming, receipts, errors, and attestation,
- topic conventions for namespacing and correlation,
- Agent Card representation and discovery (IPLD content addressing, IPNS,
  rendezvous, presence),
- a direct-stream protocol for deterministic delivery and streaming,
- a security model based on libp2p peer identity,
- conformance requirements and test vectors.

The wire protocol requires only libp2p (gossipsub, direct streams, circuit
relay). IPFS contributes the identity and data layer: content-addressed
Agent Cards as IPLD, IPNS naming, public-mesh bootstrap.

Terminology: **agent** — an autonomous software entity with a libp2p peer
id; **asker** — the agent originating a query or task; **responder** — an
agent answering a query or executing a task; **witness** — an agent that
verifies an exchange occurred between two distinct peers; **card** — an
Agent Card (see §6).

## 2. Envelope

Every a2aipfs message on gossipsub is a JSON object, UTF-8 encoded, on a
single envelope:

```json
{
  "a2aipfs": "1.0",
  "type": "query",
  "id": "bafy…",            // CID of the canonical message (see 2.2)
  "from": "12D3KooW…",      // libp2p peer id of the sender
  "ts": 1795631455702,      // ms epoch at signing
  "topic": "a2aipfs/v1/global",
  "ref": "bafy…",           // correlation id (OPTIONAL; see 2.3)
  "sig": "…",               // multibase signature (REQUIRED, see §9)
  "payload": { }
}
```

### 2.1 Required discrimination

Every implementation MUST switch on `a2aipfs` first: messages without the
`"a2aipfs": "1.0"` field MUST be ignored (they are pre-standard envelopes,
e.g. the reference implementation's `{type:"chat"}` — see Appendix A).
Then on `type`. Unknown `type` values MUST be ignored, not errored.

### 2.2 Message id

`id` is the CID (CIDv1, dag-json codec, sha2-256) of the envelope with the
`id` and `sig` fields removed, canonicalized per the IPLD dag-json
canonicalization rules. Senders MUST compute `id` over the signed body
before signing. Receivers MAY recompute `id` to detect corruption.

### 2.3 Correlation

`ref` carries the `id` of the message being answered, updated, or
receipted. Query/answer pairs, task/state updates, and acks MUST set `ref`.
The pre-standard marker mechanism (substring matching on a run-scoped
string) is RECOMMENDED as a fallback for compatibility but MUST NOT be
relied on where `ref` is available.

### 2.4 Size limits

A single gossipsub envelope MUST NOT exceed 1 MiB (gossipsub default max
message size; implementations SHOULD advertise their limit via their
Card). Larger payloads MUST be sent as `stream-chunk` sequences or by
content-addressed reference (`artifact` payloads, §3.6).

## 3. Message types

Payloads are given in JSON-Schema form in `SCHEMAS/<type>.schema.json`.
This section is normative for semantics; the schemas are normative for
fields.

### 3.1 `announce` — presence and capability

An agent announcing availability on a topic. Carries the Card inline or by
CID reference (§6). Agents MUST announce on topic join and SHOULD re-issue
before Card expiry. Receivers SHOULD treat repeated announces as refresh,
not duplication.

### 3.2 `query` — request for information

Asks a question. `payload.question` is human/agent-readable text;
`payload.tags` (OPTIONAL) carries routing hints. The asker MUST be prepared
to receive zero, one, or many `answer` messages with `ref` = the query id.

### 3.3 `answer` — response to a query

`payload.text` is the answer. `payload.facts` (OPTIONAL) carries
machine-asserted facts (e.g. platform, arch, hostname) — an answer whose
facts the asker could have produced itself SHOULD be treated as
suspicious; witnesses MUST NOT count self-knowable answers as proof of
cross-agent exchange.

### 3.4 `task` — delegated work

Wraps an A2A Task object (A2A v1.0.0 semantics preserved). Initial state
is `submitted`. The responder takes ownership by emitting `task-state`.

### 3.5 `task-state` — lifecycle update

Carries the A2A task state machine: `submitted`, `working`,
`input-required`, `auth-required`, `completed`, `canceled`, `failed`,
`rejected`. Transitions MUST follow the A2A v1.0.0 state machine; terminal
states MUST NOT be followed by non-terminal updates for the same `ref`.

### 3.6 `stream-chunk` — partial output

`payload.seq` is a monotonically increasing integer starting at 0;
`payload.last` marks the terminal chunk; `payload.artifact` (OPTIONAL)
references content-addressed data (CID) instead of inline bytes.
Implementations MUST reassemble chunks by `seq` and MUST handle gaps by
requesting retransmission over the direct-stream protocol (§7), not by
silently delivering partial results.

### 3.7 `ack` — delivery receipt

Confirms receipt of the message whose `id` equals `ref`. Carries the
receipt's own `id` so the ack itself can be acked or attested. Acks SHOULD
be emitted for direct-stream deliveries in at-least-once mode; gossipsub
delivery is fire-and-forget and does not require acks.

### 3.8 `error` — rejection

`payload.code` is a short machine-readable string
(`unsupported-type`, `ref-not-found`, `payload-too-large`,
`insufficient-trust`, …); `payload.text` is human-readable. Errors SHOULD
reference the offending message via `ref`.

### 3.9 `attest` — witness attestation

A third-party cryptographic proof that an exchange occurred. `payload`
contains the `id`s of the exchanged messages, both peer ids, the topic,
and the witness's own observations (§8). `attest` is the primitive that
distinguishes a2aipfs from transport-bound agent protocols: any witness
MUST be able to prove, to any verifier, that peer A asked and peer B
answered.

## 4. Topic conventions

Topics are slash-namespaced: `a2aipfs/v1/<scope>/<name>`.

- `a2aipfs/v1/global` — open discovery and general query traffic.
- `a2aipfs/v1/agent/<peer-id>` — per-agent inbox topic; an agent SHOULD
  subscribe to its own inbox topic and MAY subscribe to others.
- `a2aipfs/v1/task/<task-id>` — task-scoped traffic for a specific task.
- `a2aipfs/v1/witness/<exchange-id>` — witness coordination for an
  attestation.

Agents MUST subscribe with `runOnLimitedConnection: true` (relayed peers
carry pubsub). Messages on a topic MUST use the envelope's `topic` field
for routing hints but the gossipsub topic itself is authoritative.

## 5. Repetition and persistence

Gossipsub MAY drop a single publish into a pruned mesh. Therefore:

- senders of `query` and `task` MUST republish at intervals (RECOMMENDED
  15s) until satisfied or timed out;
- intermediate relays and witnesses SHOULD republish with their own
  envelopes referencing the original `id`, never altering the original
  payload;
- receivers MUST deduplicate by `id`, not by payload bytes.

## 6. Agent Card

An Agent Card (A2A discovery document semantics) is represented as IPLD
dag-json and content-addressed. `announce` carries either the inline card
or `{ "card": "<CID>" }`. An agent SHOULD publish its current Card CID to
IPNS under its peer-id-based key so the card is discoverable and updatable.
Discovery order: inbox-topic announce → `a2aipfs/v1/global` announce →
IPNS resolution. The Card MUST include: peer id, supported a2aipfs version,
supported message types, maximum envelope size, and endpoint hints
(relay addrs) for direct reachability.

## 7. Direct-stream protocol

Protocol id: `/a2aipfs/1.0.0`. Framing: newline-delimited JSON (NDJSON)
envelopes. Used for:

- deterministic delivery when gossipsub mesh convergence is not guaranteed
  (implementations SHOULD fall back to direct streams after two republish
  cycles without response);
- `stream-chunk` transmission with backpressure (the receiver reads at its
  own pace; the sender MUST respect stream backpressure);
- bulk payloads above the gossipsub size threshold.

A direct-stream connection between two agents SHOULD reuse the same
envelope format. Unknown message types over the stream MUST be answered
with an `error` envelope, not a transport reset.

## 8. Attestation protocol

1. Asker publishes `query` (or `task`) on the exchange topic.
2. Responder publishes `answer` (or terminal `task-state`) with `ref` set.
3. A witness observing BOTH messages, with `from` peer ids A and B where
   A ≠ B, constructs `attest` with both message ids, both peer ids, the
   topic, and its own peer id, signed per §9.
4. Any verifier re-checks: signatures valid, peer ids distinct, referenced
   messages retrievable (from the witness, from the originators over
   direct streams, or from content-addressed storage if archived).

An attestation is REPLAY-SAFE by `id` deduplication: re-issued attests
for the same exchange id SHOULD be dropped after first verification.

## 9. Security model

- **Identity** is the libp2p peer id. Gossipsub messages MUST be signed by
  the publisher; receivers MUST verify publisher signatures before
  acting on `from`.
- **Envelope signatures**: the `sig` field is a multibase-encoded signature
  over the canonical envelope (§2.2 serialization) using the peer's
  libp2p private key. Envelopes with invalid `sig` MUST be dropped.
- **Trust**: libp2p peer ids are self-certifying but anonymous. Agents
  SHOULD maintain trust stores (Card-verified peers, prior successful
  exchanges) and SHOULD refuse `task` delegation from untrusted peers per
  local policy. Nothing in this spec establishes global identity — that is
  deliberately out of scope (DID layers MAY be layered on via the Card).
- **Spam/DoS**: republish intervals MUST be bounded (a sender MUST NOT
  republish more than once per 10s per message id). Rate limiting is
  implementation-specific; RLN-style membership proofs MAY be layered on
  the topic later.

## 10. Versioning

The envelope version `a2aipfs: "1.0"` and protocol id `/a2aipfs/1.0.0`
move together. Wire-incompatible changes bump both. Implementations MUST
ignore (not fail on) envelopes with newer major versions. Minor version
additions are new optional fields and new types — both ignored-by-default.

## 11. Conformance

A conformant implementation MUST: parse and validate the envelope per
§2; implement `announce`, `query`, `answer`, `ack`, `error`; verify
signatures per §9; deduplicate by `id`. It SHOULD implement `task`,
`task-state`, `stream-chunk`. It MAY implement `attest`. Each MUST is
paired with a test vector in `TESTVECTORS/` (M3).

## Appendix A — Pre-standard compatibility

The reference implementation (`IMPLEMENTATION-NOTES.md`) predates this
spec: envelopes `{type:"chat", name, at, text}`, substring marker matching,
protocol id `/ipfs-agentd/interop/1.0.0`. Gateways and bridges SHOULD
translate pre-standard envelopes to a2aipfs `query`/`answer` (marker →
synthesized `ref`) during the transition period. The reference
implementation's interop matrix is the initial conformance harness.
