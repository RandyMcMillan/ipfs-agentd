# A2A over IPFS — Formal Specification Plan

Working name: **a2aipfs** (A2A over IPFS). An extension of the A2A
(Agent2Agent) standard onto the IPFS/libp2p stack, so agents can discover,
task, and verify each other on the public decentralized mesh without HTTP
endpoints.

Scope note: the wire protocol requires only libp2p (gossipsub, direct
streams, relay) — a bare libp2p swarm suffices. IPFS contributes the
identity and data layer: peer-id-based Agent Cards as content-addressed
IPLD, IPNS naming, public-mesh discovery. The name leads with the
distinctive half.

Status: PLANNING. This document is the plan for producing the formal
specification — not the specification itself.

---

## 1. Why the extension exists

A2A v1.0.0 (Linux Foundation, March 2026) standardizes agent semantics:
Agent Cards, Tasks with lifecycle states, Messages with typed Parts,
Artifacts. But it assumes HTTP: an agent lives at a URL, publishes its
Agent Card at `/.well-known/agent-card.json`, and streams via SSE.

libp2p/IPFS breaks those assumptions and replaces them with stronger ones:

| A2A (HTTP) assumption | libp2p replacement |
|---|---|
| Agent addressable by URL | Agent addressable by peer id (self-certifying) |
| Agent Card at .well-known path | Agent Card as IPLD dag-json, content-addressed (CID), optionally IPNS-updatable |
| Server must be up & reachable | Relay/circuit addressing; store-and-forward via pubsub |
| TLS + OAuth for identity | Peer id keypair; messages signed by the publisher |
| Point-to-point client/server | Multicast topics + direct streams |
| No third-party verification | Witness attestation — a third peer signs proof of an exchange |

What we keep from A2A, unchanged in spirit: the **Task** as the unit of
work, the task state machine, Messages/Parts/Artifacts semantics, and the
Agent Card as the discovery document. a2aipfs is a *transport and discovery
binding* plus one new primitive (attestation) that HTTP A2A cannot express.

## 2. Specification deliverables

The formal specification will be a versioned document set in `docs/spec/`:

1. **`SPEC.md`** — the normative spec. RFC 2119 language (MUST/SHOULD/MAY).
   Sections:
   1. Scope & terminology
   2. Envelope format (JSON, schema in JSON-Schema; CDDL later)
   3. Message types (section 3 below)
   4. Topic conventions (namespacing, run/task-scoped markers)
   5. Agent Card representation & discovery (IPLD, IPNS, rendezvous, presence)
   6. Task lifecycle binding (states, correlation, timeouts)
   7. Direct-stream protocol (`/a2aipfs/1.0.0`) — request/response,
      streaming chunks, backpressure
   8. Attestation (`attest`) — witness envelopes, different-peer proof,
      replay rules
   9. Security model (pubsub signature verification, envelope signing,
      trust model, spam/DoS posture: RLN-compatible hooks)
   10. Versioning & compatibility rules
   11. Conformance requirements + test vectors
2. **`SCHEMAS/`** — JSON-Schema for every envelope type; one file per type.
3. **`TESTVECTORS/`** — hex/JSON vectors: valid/invalid envelopes, signature
   cases, state-machine traces. Consumed by the conformance suite.
4. **`MAPPING.md`** — non-normative A2A v1.0.0 ↔ a2aipfs field-by-field mapping,
   including what we deliberately drop (SSE streaming → gossipsub + direct
   streams) and the HTTP gateway semantics for interop with URL-based A2A
   agents.
5. **`CHANGELOG.md`** — spec versions, semver for the spec itself.

## 3. Message types (draft — to be ratified in SPEC.md)

All envelopes share: `type`, `id` (CID-ish correlation), `from` (peer id),
`ts` (ms epoch), `sig` (signature over canonical serialization).

| type | purpose | notes |
|---|---|---|
| `announce` | presence + Agent Card by reference or inline | replaces HTTP discovery; repeated on join and expiry |
| `query` | question / request for information | our current question envelope, generalized |
| `answer` | result referencing a query id | what `responder-*` publishes today |
| `task` | delegate a unit of work | carries A2A Task object |
| `task-state` | lifecycle update: `working`, `input-required`, `auth-required`, `completed`, `failed`, `rejected` | A2A states preserved verbatim |
| `stream-chunk` | partial/long-form output | sequence numbers, terminal flag |
| `ack` | delivery receipt | closes at-least-once loops |
| `error` | rejection with machine-readable reason | |
| `attest` | witness proof of an exchange | **new primitive**: third-peer signature over `{query id, answer id, both peer ids}` |

## 4. Conformance strategy

The interop matrix IS the conformance harness: each leg (copilot, opencode
models, cross-OS nodes, browser peer) must pass against the test vectors.
A leg that passes on a cold public mesh = conformant implementation of the
covered surface. SPEC.md will mark each requirement with the test vector
that enforces it.

## 5. Milestones

- **M0 — extract from practice.** Our existing protocol (chat envelope,
  markers, witness verification, direct-push) is the reference
  implementation. Land it under `docs/spec/IMPLEMENTATION-NOTES.md`.
- **M1 — SPEC v0.1 draft.** Envelope, message types 1–7, topic conventions,
  Agent Card binding. JSON-Schema for each envelope.
- **M2 — gateway + mapping.** HTTP↔a2aipfs gateway so URL-based A2A agents can
  reach mesh agents; `MAPPING.md` complete.
- **M3 — attestation + test vectors.** `attest` type, witness conformance,
  TESTVECTORS consumed by CI.
- **M4 — v1.0 freeze.** Two independent agent implementations passing the
  full vector suite on the cold mesh; spec frozen, errata process open.

## 6. Governance

- Spec changes land via PR, one change per PR, discussion in the PR.
- Envelope additions require a schema file + test vector in the same PR.
- Wire-format breaks bump the protocol version (`/a2aipfs/2.0.0`), never
  silently.
- The repo's interop CI is the sole merge gate for spec-affecting changes.
