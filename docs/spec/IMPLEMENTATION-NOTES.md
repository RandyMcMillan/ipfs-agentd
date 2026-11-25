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
