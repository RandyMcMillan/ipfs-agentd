# a2aipfs ↔ A2A v1.0.0 Mapping

Non-normative field-by-field mapping between A2A (HTTP) and a2aipfs
(libp2p). For agents that speak A2A over URLs and want to reach mesh
agents without knowing a2aipfs — and vice versa.

## 1. Identity and addressing

| A2A | a2aipfs |
|---|---|
| Agent URL (`https://host/...`) | peer id + inbox topic `a2aipfs/v1/agent/<peer-id>` |
| Agent Card at `/.well-known/agent-card.json` | Card as IPLD dag-json, CID in `announce`, IPNS for updatability |
| OAuth / API-key auth | libp2p peer-id signatures; envelope `sig` |

## 2. Message model

A2A Message: `{ role, parts[], messageId, taskId, referenceTaskIds,
metadata }`.

| A2A field | a2aipfs |
|---|---|
| `messageId` | envelope `id` (CID) |
| `taskId` | envelope `ref` on task-scoped traffic; `task` payloads carry the A2A Task object verbatim |
| `role: "user"` | message `from` = asker peer (any peer may ask) |
| `role: "agent"` | message `from` = responder peer |
| `parts[]` (TextPart) | `query.payload.question` / `answer.payload.text` |
| `parts[]` (FilePart/DataPart) | `stream-chunk` with `artifact` CID, or inline `data` base64 |
| `referenceTaskIds` | `ref` chain |
| `metadata` | passed through in `payload` extension points |

## 3. Task lifecycle

A2A Task states map 1:1 onto `task-state.payload.state` — the state
machine is A2A's, unmodified. What changes is transport:

| A2A mechanism | a2aipfs |
|---|---|
| `tasks/send` (request-response) | `task` envelope on `a2aipfs/v1/agent/<responder>` + terminal `task-state` back on the asker's inbox topic |
| `tasks/sendSubscribe` (SSE stream) | `stream-chunk` sequence on `a2aipfs/v1/task/<task-id>` |
| `tasks/resubscribe` (resume) | re-read missed `stream-chunk`s from content-addressed archive, or direct-stream resync |
| `tasks/cancel` | `task-state` with `state: canceled` |
| push notifications (webhook) | inbox-topic subscription |

## 4. Artifacts

A2A Artifact: `{ artifactId, name, parts[] }`. In a2aipfs: content-addressed
by default — artifact bytes go to the local node's blockstore, the Task
carries CIDs; `stream-chunk.payload.artifact` references them. The gateway
MUST resolve CIDs to bytes for HTTP clients.

## 5. Capabilities and discovery

A2A `AgentCapabilities` (streaming, pushNotifications, stateTransitionHistory)
maps to Card fields `supportsStreaming`, `supportsPush`, `keepsHistory`.
a2aipfs adds: `maxEnvelopeSize`, `supportedTypes`, `relayAddrs`.

## 6. What the gateway must do

An A2A↔a2aipfs gateway terminates HTTP A2A on one side and speaks a2aipfs
on the other. Requirements:

1. Serve its own Card at `/.well-known/agent-card.json` describing the
   bridged mesh agent(s).
2. `POST /v1/message:send` → translate A2A Message to a2aipfs envelope(s),
   publish to the target agent's inbox topic; block (or SSE-stream) for the
   correlated response; translate back.
3. Run an IPFS/libp2p node continuously, announce on behalf of bridged
   agents, collect inbox traffic.
4. Translate errors: A2A JSON-RPC errors ↔ `error` envelopes by code table
   (`ref-not-found` → A2A task-not-found, `insufficient-trust` → A2A
   auth-required, etc.).
5. Attestation passthrough: expose `attest` envelopes as an A2A extension
   method `attestations/get` so HTTP clients can fetch witness proofs.

## 7. Deliberate divergences

- **No SSE.** Streaming is chunked pubsub or direct streams; an HTTP-facing
  gateway MAY re-chunk as SSE for A2A clients, but the wire format is
  never SSE-native.
- **No global registry.** A2A discovery via URL assumes DNS; a2aipfs
  discovery is presence + IPNS. A gateway that wants DNS names for mesh
  agents SHOULD use its own Card as the bridge description.
- **Attestation has no A2A equivalent** — it is exposed as an extension
  method (§6.5), not mapped onto core A2A fields.
