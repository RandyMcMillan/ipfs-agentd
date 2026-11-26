# a2aipfs — Implementation Notes (M0 reference)

This document describes the protocol as actually implemented in this repo
today — the reference implementation the formal spec (`SPEC.md`, planned in
`A2A-IPFS-PLAN.md`) will normativize. Where practice and future spec
disagree, this file records practice.

## 1. Roles

Three node roles, all built on the same daemon core (`src/node.js` — a
Helia/libp2p node with gossipsub, rendezvous client, relay support):

- **Asker** (`scripts/interop-ask.mjs`) — the agent's entry point. One
  command an AI agent runs with zero repo knowledge. Publishes the
  question, captures the first `responder-*` answer, prints it verbatim to
  stdout, exit 0/1.
- **Responder** (`scripts/chat-responder.mjs`) — answers any chat envelope
  whose text contains the run marker. Carries facts only its machine knows
  (platform/arch/hostname/peer id) so answers are unforgeable by the asker.
- **Witness** (`scripts/listen-chat.mjs`) — verifies. Must see the question
  AND a `responder-*` answer from a **different libp2p peer** than the
  question's. Prints `WITNESS PASS`/`WITNESS FAIL` — the machine-readable
  verdict CI gates on.

## 2. Envelope (current, not yet spec-shaped)

```json
{ "type": "chat", "name": "<agent-name>", "at": 1795631455702, "text": "..." }
```

- `type`: only `chat` exists on the wire today. a2aipfs message types
  (`announce`, `task`, `attest`, …) are planned; the pubsub listener
  switches on this field already (`msg.type !== 'chat'` → drop).
- `name`: self-claimed display name. NOT trusted — identity is
  `evt.detail.from`, the gossipsub publisher's peer id, which is
  signature-verified by libp2p.
- `at`: ms epoch. Refreshed on republish so relays aren't deduped away.
- `text`: free-form payload. Marker matching is substring
  (`text.includes(marker)`).

Direct-stream payloads (not pubsub) use a parallel shape:
`{ "kind": "question" | "answer", "name": "...", "text": "..." }` on
protocol id `/ipfs-agentd/interop/1.0.0`.

## 3. Topic and marker conventions

- Single public topic: `gnostr` (env `INTEROP_TOPIC`).
- Run-scoped markers: `gnostr-interop-question-<run_id>[-opencode-<slug>]`.
  The responder matches the BASE marker (`…-<run_id>`), so every suffixed
  leg marker matches one responder. The asker matches answers by marker
  prefix (`marker.split('-').slice(0,3).join('-')`).
- Every envelope is republished on a timer (asker 15s, witness relays
  10×10s then 30s sustain) — gossipsub can drop a single publish into a
  pruned mesh, so persistence is part of the protocol, not an optimization.

## 4. Delivery machinery (the part gossipsub can't guarantee)

The public mesh does NOT reliably deliver between arbitrary runners. Four
mechanisms stacked, each compensating for the last:

1. **Two-sided co-located link.** Witness ↔ asker on the same CI runner:
   witness dials asker's loopback (4012 copilot / 4017 opencode) every 5s;
   asker reads the witness's relay addrs from `CHAT_ADDRS_FILE`, dials them,
   re-reads every 10s; failed dials are retried, never blacklisted.
2. **Relay-addr bridge (artifact channel).** Each witness uploads its relay
   multiaddrs as a `chat-bridge-<run>[-suffix]` artifact; a bridge writer in
   the matrix leg polls the artifact API and keeps the responder's bootstrap
   file fresh; the responder re-reads it every 30s and dials.
3. **Direct-push streams (`/ipfs-agentd/interop/1.0.0`).** The witness
   pushes the question over **every** connection (not just relayed ones —
   run 45673142201 failed with zero pushes because a direct-tcp filter
   excluded exactly the connection that existed). The responder pushes its
   answer back over every connection it has. Negotiation failures on public
   peers are ignored by design.
4. **Rendezvous.** The witness runs the rendezvous server
   (`/ipfs-agentd/rendezvous/1.0.0`); responders register, the witness
   discovers and dials them.

## 5. Witness verdict rules

- PASS requires: question envelope matching the marker from the expected
  `CHAT_FROM` name, AND an answer envelope with name prefix `responder-`
  containing the marker, AND `question.fromPeer !== answer.fromPeer`.
  (`fromPeer` is the pubsub `from` peer id, or the stream connection's
  remote peer for direct pushes — the different-peer proof survives both
  paths.)
- A late question extends the deadline by a grace period so an answer still
  has time.
- Verdict strings go to BOTH stdout and stderr (`WITNESS PASS` / `WITNESS
  FAIL`) — the CI verdict loop greps the captured stdout.

## 6. What the interop matrix proves

Each CI run puts a zero-context AI agent (copilot / opencode free models)
through the full path: discover nothing, run one command, get a real answer
from a different machine on the public mesh, verified by a witness. The
browser-deployed peer leg and cross-OS matrix legs extend the surface.
Passing on a cold mesh = the delivery machinery works without warm-mesh
luck.

## 7. Known gaps vs the planned spec

- Envelope has no `id`/correlation, no `sig` field (relies on pubsub
  publisher signing; direct streams have no envelope signature yet).
- No `announce`/presence, no Agent Card, no `task`/`task-state`, no
  `stream-chunk`, no `ack`, no `attest` type (witness proof is internal to
  CI, not a wire type).
- Topics are not namespaced; single shared topic per mesh.
- Responder throttling (`replyEveryMs`) and `maxReplies` are env-tuned, not
  specified.

## 8. a2aipfs reference implementation (M3.5 crypto — landed)

`scripts/a2aipfs-node.mjs` is the conformance reference for SPEC.md. Role
CLI (`A2AIPFS_ROLE=asker|responder|witness`):

- **§2 envelopes for real**: `id` is a CIDv1 (dag-json codec, sha2-256)
  over the canonical body (id/sig stripped, dag-json encoding), `sig` is a
  base64urlpad multibase signature over the same canonical bytes with the
  node's libp2p private key (libp2p 3.5.1 keeps it at
  `node.components.components.privateKey` — the PeerId object is
  public-key-only). Receivers recompute `id` and verify `sig` against the
  public key recovered from `from` — no shared state needed.
- **§3 types**: all nine implemented; the asker/responder/witness exercise
  query/answer/announce/ack/error on the wire.
- **§4 topics**: exchange on `a2aipfs/v1/<name>`, inboxes on
  `a2aipfs/v1/agent/<peer>`, attestations on `a2aipfs/v1/witness/<id>`.
- **§5 repetition**: queries republish every 15s (10s floor); asker does
  two grace republishes after capture so late-joining witnesses still see
  the query; responder republishes answers at +3s/+8s. Dedup by `id`.
- **§7 direct streams**: `/a2aipfs/1.0.0`, NDJSON envelopes; asker falls
  back after two republish cycles; unknown types get an `error` envelope.
- **§8/§9 witness**: admissible = signature-valid query AND answer, `ref`
  correlation, distinct `from` peers; then it builds, signs, publishes and
  files the `attest` envelope.
- **Tests**: `test/a2aipfs-e2e.mjs` — three co-located nodes + an injector
  firing a forged answer (rejected: id/signature) and a pre-standard
  `{type:"chat"}` envelope (ignored per §2.1); the attest's id and
  signature are re-verified by an independent reimplementation. CI leg
  `a2aipfs-mesh` runs the same exchange over the cold public mesh and
  uploads the signed attest as the run artifact.

## 9. Task lifecycle (§3.4–§3.7) — landed

`A2AIPFS_ROLE=worker` executes tasks: on a signature-valid `task`
(state `submitted`) it publishes `task-state accepted`, dials the task's
`replyTo` address, delivers the result as an ordered **hash-chained**
`stream-chunk` sequence over the `/a2aipfs/1.0.0` direct stream
(`chain_i = sha256(chain_{i-1} ‖ data_i)`, chain carried inside the signed
payload), collects `ack`s, then publishes `task-state done` with the chunk
count, ack count and final chain. `A2AIPFS_TASK=1` switches the asker into
task mode: it verifies every chunk's signature AND chain before acking,
requires the `done` state before declaring completion, and prints a
single-line verdict. The witness files a task attest (verbatim signed
envelopes) to `A2AIPFS_TASK_FILE` once it has observed task + `done` from
distinct peers. `test/a2aipfs-task-e2e.mjs` (forged `task-state` rejected
on a negative topic) and `test/a2aipfs-task-verify.mjs` (independent
re-verify of every embedded envelope + chain recompute) cover it locally;
CI leg `a2aipfs-task` runs it on the cold public mesh.

### libp2p 3.5.x stream API (hard-won — twice)

`dialProtocol`/`handle` return **evented message streams**, NOT
`{source, sink}` Duplexes: write with `stream.send(bytes)`, read with
`for await (const chunk of stream)`, half-close with
`await stream.closeWrite()`. Code assuming `.sink`/`.source` fails with
`stream.sink is not a function` — and because those failures sat inside
`.catch(() => {})` handlers, the §7 direct-stream paths **silently
never worked** until the task leg exercised them for real. Also:
`dialProtocol` wants a **PeerId** (or multiaddr object), not a string.

Remaining gaps: M4 spec freeze (needs two independent implementations green).

## 10. Verification ON IPFS — landed

The witness now refuses to attest until the exchange verifies **on IPFS**:
each envelope's canonical body is handed to the node's own helia DAG store
(`@helia/dag-json`): `dag.add` makes IPFS compute the content id and it must
equal the envelope's claimed `id` (§2.2), then `dag.get(id)` must resolve
through the blockstore. Only then does the attest go out, now carrying
`payload.ipfs.verified` + the verified CIDs (query/answer attest) or
`record.ipfs.verified` (task attest). The CI legs (mesh, copilot, task)
require the witness's `IPFS VERIFIED` log lines AND the payload flag in
their verdicts; `test/a2aipfs-task-verify.mjs` and the e2es independently
re-run the helia add+get round-trip on every embedded envelope. No extra
daemon — every protocol node already is an IPFS node (helia), so
verification happens on the IPFS stack the network actually runs.


## 11. Agent Card over IPNS (§6) — landed

Every role announces a content-addressed Agent Card: the card is a dag-json
object stored in the node's own helia DAG store (`cardCid = dag.add(card)`),
the announce envelope carries both `payload.card` (signed) and
`payload.cardCid`, and the same record is published to **IPNS under the
node's own libp2p peer key** — so the IPNS name *is* the peer identity and
resolving it proves the card came from that key. Resolution is
`@helia/ipns` with the **pubsub router only** (`ipns(helia, { routers:
[pubsub(helia)] })`): the factory's default DHT router throws
`this.routing.put is not a function` in client mode, and every node here
runs DHT client mode.

Hard-won behavior, in the order it bit:

1. **`PublishError.NoPeersSubscribedToTopic`** — a pubsub IPNS put reaches
   only peers that were subscribed to `/ipns/<key>` *before* the put. The
   announce envelope is what makes peers subscribe, so early puts fail
   harmlessly and later puts land. Nodes republish on a schedule
   (record republishes at +3/6/10/16/24/36/50 s, all with an
   `AbortSignal.timeout(6000)` so a dead mesh can't hang a role).
2. **Seen-dedup silently drops republishes of the same envelope id.**
   Gossipsub receivers cache envelope ids; re-sending the identical
   announce does nothing. Republishes must build a FRESH envelope
   (`announce(card, true)` — new `ts` → new `id` → new sig) or peers that
   missed the first announce never learn the IPNS name exists.
3. **Role exits kill republish timers.** An asker that got its answer
   would `process.exit` while late joiners still needed its record; card
   resolution is awaited (`awaitCards`) before exit.
4. **Content compare must use dag-json bytes,** not `JSON.stringify` —
   key order differs across encode paths and produced false MISMATCHes
   on identical cards.

The asker resolves each announced peer's name and checks the resolved CID
equals the announced `cardCid` and the dag-json bytes match the signed
`payload.card` (`CARD RESOLVED via IPNS <peer>… → <cid> (content matches
signed card)` on stderr). The CI legs (mesh, copilot, task) require a
`CARD RESOLVED via IPNS` line in the asker log as part of the verdict,
alongside the IPNS verification. The e2es assert the asker resolved the
*answering* peer's name specifically — matching by 12-char peer prefix —
not just any card.
