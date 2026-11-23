# AGENTS.md — ipfs-agentd

Guidance for AI agents (and humans) working in this repository.

## What this is

One persistent local IPFS daemon per agent: headless Helia node on a disk
blockstore, exposed through a **standard MCP interface by default** (stdio
transport, 14 tools). Content stays on the agent's disk until explicitly
published (gnostr topic, IPNS, or a pinning service).

## Usage

```sh
npm install
ipfs-agentd                         # bin: MCP over stdio, repo at ~/.ipfs-agentd
ipfs-agentd --repo /path --logging debug
ipfs-agentd chat --topic mymesh --name alice   # human <-> agent topic chat
npm test                            # smoke + mcp-e2e + persist + chat-e2e + git-remote-e2e + web-e2e
```

- **stdout carries the MCP protocol only.** All logging goes to stderr
  (timestamped) — never print to stdout from daemon code.
- Adds are auto-pinned. Pins survive restarts (`test/persist.mjs` proves it).
- Chat envelope (shared by the CLI and agents via `ipfs_pubsub_publish/pull`):
  `{"type":"chat","name","text","at"}` — see README "Chat CLI".
- Non-envelope topic payloads render as `RAW <base64>` in the CLI — binary
  agent protocols stay visible to humans.

### Env

| Var | Default | Purpose |
|---|---|---|
| `IPFS_AGENTD_REPO` | `~/.ipfs-agentd` | Blockstore/datastore dir |
| `GNOSTR_LISTEN` | — | Extra listen multiaddrs (public hosts) |
| `GNOSTR_BOOTSTRAP` | — | Extra peers to dial at boot (e.g. a publisher's addr) |
| `GNOSTR_LISTEN_FILE` / `GNOSTR_BOOTSTRAP_FILE` | — | File holding the multiaddr value (file wins over env). Windows git-bash (MSYS2) rewrites env *values* that look like POSIX paths when spawning native node — no exclude switch covers env vars; a native file path survives. Read at node startup in `src/node.js` |
| `REBOOTSTRAP_SECS` | `60` | Re-dial unconnected bootstrap peers every N s (0 = off) |

### Reachability model

NAT'd by default and still dialable: the node reserves slots on public relay v2
servers (Kubo bootstrap nodes run relays by default; `discoverRelays: 2`),
advertises `/p2p-circuit` addresses, and runs `autonat` + `dcutr` so relayed
connections upgrade to direct ones when possible. `GNOSTR_LISTEN` on a public
host gives direct dialability instead.

## Development

- Node >= 22 (see `.nvmrc`). Layout:
  - `src/node.js` — node factory. **Do not break the recipe**: helia must own
    the libp2p config (`createHelia({ libp2p: ... })`) and be started
    explicitly, or bitswap never registers (same recipe as helia-ipfs-relay's
    `gnostr-publish.js`).
  - `src/tools.js` — all tool logic, transport-agnostic: plain JSON in/out.
    The MCP layer must stay a thin wrapper.
  - `src/daemon.js` — zod schemas + `server.tool()` registrations + argv
    parsing (`--repo`, `--logging`, `--quiet`). Tool-call logging is at
    `debug` level; lifecycle/peer events at `info`.
  - `src/mcp-server.js` — thin entry: `main()` from `src/daemon.js`.
  - `src/bin.js` — CLI dispatcher: `daemon` (default) / `chat` / `serve` / `--help`.
  - `src/cli.js` — gossipsub chat REPL (envelope `{type:'chat',name,text,at}`;
    prints `listen:`/`listen(relayed):` lines so scripts/agents can attach).
  - `src/web.js` — GitHub-like repo browser (`serve`): node:http + git CLI
    only, zero third-party deps; markdown renderer escapes-first (XSS-safe).
    One subdir of `--root` per repo; `.bundle` files materialize to a cache
    dir inside the root (skipped by the scanner — no HEAD/.git at its top).
  - `src/git-remote-helper.js` — shared machinery for the two git remote
    helpers (boot/fetch/materialize/serve protocol).
  - `src/logger.js` — leveled stderr logger shared by daemon and CLI.
- **Dependency rules (hard-won, see commit history):**
  - `blockstore-fs@^4` + `datastore-fs@^12` — the only versions matching helia
    7's interfaces. Older majors install cleanly and silently no-op pins.
  - helia `pins.add/rm` are async generators — drain them (see `drainPin`);
    swallow `AlreadyPinnedError` on re-pin.
  - Several `multiformats` copies coexist: pass CID **strings** to
    `@helia/unixfs`, CID **instances** to `helia.pins`.
  - Keep `@libp2p/*` pins aligned with helia-ipfs-relay's package.json.
- **No silent errors in tests:** a test that spawns a child (CLI, server,
  helper) must surface the child's stderr whenever the child dies or the
  check fails — see `test/web-e2e.mjs` ("child exited early — stderr: …").
  A green-looking run over a dead child process is the worst outcome.
- **Adding a tool:** implement in `src/tools.js` (pure async function, JSON
  args/result, throw on error), register in `src/daemon.js` with a zod
  schema, add a check to `test/smoke.mjs`, bump the tools count assertion in
  `test/mcp-e2e.mjs`.
- Commits: GPG-signed (`user.signingkey 3B696CCB` is set in this repo), topic
  branches, PRs — never push to `master` directly.

## Bridging / platform adaptation

Stdio MCP is the default and only shipped transport. When something else
needs to speak to the daemon:

- **MCP-capable agent clients** (Claude Code, Cline, Kimi Code, …): add as a
  local stdio server, e.g.
  `{"mcpServers": {"ipfs": {"command": "node", "args": ["/abs/path/src/mcp-server.js"]}}}`.
  Use absolute paths; run scripts through an explicit interpreter (`node x.js`)
  — packed/plugin sandboxes often mount files non-executable.
- **Remote/HTTP clients:** bridge stdio↔SSE with any MCP proxy in front of
  `src/mcp-server.js`. Not shipped; keep the daemon local — only revisit if
  the privacy model changes.
- **gnostr git interop:** `git_publish_repo`/`git_fetch_bundle` speak the same
  ad format as helia-ipfs-relay (`{type:'git', name, at, bundle, addrs?}`).
  Adversarial settings: always the `gnostr://cid/<CID>` form — name discovery
  is unauthenticated (newest ad wins).
- **git remote helpers shipped here:** `src/git-remote-gnostr.js` and
  `src/git-remote-ipfs.js` (bins via package.json; shared machinery in
  `src/git-remote-helper.js`). Both reuse `src/node.js` — never fork the
  libp2p stack into them. Helpers share no state with the daemon: own repo
  at `~/.ipfs-agentd-git` (`IPFS_AGENTD_GIT_REPO`), fetch-only, and they
  release the swarm (`stopNode`) before relaying to `git-upload-pack`.
  `test/git-remote-e2e.mjs` covers both URL forms with real `git clone`.
- **Pubsub across NAT:** two NAT'd nodes cannot see each other's topic
  messages without a mutually reachable rendezvous (a public relay subscriber
  or a shared helia-ipfs-relay `server.js` host). Relay reservations make
  nodes *dialable*; they do not bridge gossipsub meshes.
- **Docker:** `Dockerfile` is all-in-one (web service is the default CMD;
  override `command:` for daemon/chat). One container = one instance; repos
  are per-instance volume mounts at `/data/repos`. `ARG BASE`/`RUN_USER`
  exist for offline builds against internal base images. The compose file is
  an example, not a requirement.

## Useful prompts

What an agent (or human driving one) typically asks. Verbatim-ish examples —
adjust topics/paths/CIDs:

**Content**
- "Add this file's bytes to IPFS and pin the result" → `ipfs_add` (b64 in,
  CID out, auto-pinned). Directory trees → `ipfs_add_all`.
- "Fetch bafy… and show the first 4 KiB" → `ipfs_cat` with `offset`/`length`.
- "Is bafy… still pinned? What else is pinned?" → `ipfs_pin_ls` / `ipfs_pin_rm`.

**Naming / addressing**
- "Publish bafy… under an IPNS name and resolve it back" →
  `ipfs_name_publish` then `ipfs_resolve` (`/ipns/<key PeerId>`). One-shot key
  per call — not yet persisted across calls.

**Coordination**
- "Announce this repo on the gnostr topic so others can clone it" →
  `git_publish_repo` (bundle → IPFS → pin → ad `{type:'git',name,at,bundle,addrs?}`).
- "Fetch repo 'xyz' / bundle bafk… and save it for git" → `git_fetch_bundle`
  (`gnostr://cid/<CID>` or `gnostr://<name>`); then `git bundle verify` /
  `git clone` locally, or `git clone gnostr://…` / `ipfs://<cid>` directly —
  this repo ships both remote helpers as bins.
- "Listen on topic X for the next 60s and summarize every message" →
  `ipfs_pubsub_pull` in a poll loop (subscribe-on-first-pull, bounded queue).
- "Tell the humans on topic 'ops' that the build is green" →
  `ipfs_pubsub_publish` with the chat envelope
  `{"type":"chat","name":"agent-1","text":"build green","at":<epoch ms>}` —
  renders in `ipfs-agentd chat`.

**Chat CLI (humans)**
- `ipfs-agentd chat --topic ops --name alice` then plain lines; agents see
  them via `ipfs_pubsub_pull`, agents reply via `ipfs_pubsub_publish`.
- Anything arriving that isn't a chat envelope shows as `RAW <base64>` —
  inspect with `base64 -d` when an agent speaks a binary protocol.

**Gotchas baked into the tools**
- `ipfs_cat` caps single responses at 32 MiB — page with `offset`/`length`.
- Publish with zero pubsub peers → `published:false`; the content is still on
  IPFS/pinned — republish when peers connect.
- **Publishers must subscribe to the topic, not just publish.** gossipsub's
  fanout path (publish without subscribe) samples recipients once and never
  re-samples while you keep publishing — on the public swarm it freezes full of
  other topic subscribers and late-joining fetchers never hear your ads (burned
  a CI interop run: "no git ad within 90000ms" while directly connected).
  `pubsub.subscribe(topic)` puts you on the mesh path, which grafts new topic
  peers every heartbeat.
- `git_publish_repo` **refuses shallow clones** (checkout `fetch-depth 1`) —
  a depth-1 `git bundle --all` misses parents. CI checkouts that publish must
  use `fetch-depth: 0`.
- Name discovery (`gnostr://<name>`) is unauthenticated, newest ad wins;
  adversarial settings → `gnostr://cid/<CID>`.
- `@multiformats/multiaddr` is **v13** — `getPeerId()` is gone. The peer id is
  the last component with code 421: `ma.getComponents().at(-1).value`.
- GitHub Actions background gotcha: `setsid nohup cmd &; echo $!` captures the
  wrong pid — setsid forks when the job is a process-group leader, so `$!` is
  a short-lived parent. Kill by pattern (`ps -eo pid,args | grep …`), not pid
  files.

## CI / gh

Workflows:

- `ci.yml` — reusable `./.github/actions/npm-test` on every push/PR (Node 22).
  Ignores `v*` tags — release.yml owns the tag gate.
- `docker.yml` — owns ALL image pushes to GHCR: `latest`+`:<sha>` on master,
  `:<tag>`+`latest` on `v*`, build-only on PRs (docker/metadata-action for
  tagging). release.yml does not push images.
- `release.yml` — tag trigger (`v*`): test gate via the npm-test action, then
  a GitHub release (softprops/action-gh-release). `resolve-tag` composite
  resolves the dispatch input vs ref.
- `interop.yml` — live interop on the real gnostr topic, `workflow_dispatch`
  only. Inputs: `ref` (branch/tag, default master), `live_seconds` (publisher
  seed window), per-OS selects (`linux` default — also runs the Docker peer leg,
  `windows`, `macos`), and the model-beam inputs `copilot` (PAID, default off),
  `opencode_model`, `opencode_models`, `opencode_free` (below). A publisher daemon seeds and re-announces every 15s; an
  independent fetcher node proves the bundle by CID (bitswap) and by name
  (topic discovery); on linux a Docker container joins as a third independent
  peer (CID/name fetch + container-side `git clone gnostr://<name>` with this
  repo's helper). The publisher subscribes to the topic — see the fanout-freeze
  gotcha above. Watch the live topic with
  `node scripts/listen-gnostr.mjs` (`GNOSTR_TOPIC`, `LISTENER_REPO`); local
  repro: `npm run interop:publisher` / `npm run interop:fetch` (see file
  headers). Docker-leg gotchas: hosted-runner uid (1001) ≠ image `node` uid
  (1000) → `chmod -R 777` the mounted state dir; `$RUNNER_TEMP` is wiped
  between steps → docker legs recreate state dirs and take CID/name via env.
  Extra legs on every dispatch (independent of the OS matrix): **deployed-site**
  (probes the deployed gh-pages app; `scripts/check-deployed-site.mjs` +
  `scripts/check-deployed-peer.mjs`, playwright chromium) and **copilot-chat**
  (non-fatal PoCs — each agent gets only a hint, must figure out the chat,
  ask a run-marked question on gnostr and receive a REAL answer from a matrix
  leg's `scripts/chat-responder.mjs`; the witness `scripts/listen-chat.mjs`
  passes only on question + `responder-*` answer from DIFFERENT libp2p peers).
  The beam: **copilot-chat** (Copilot CLI — PAID, `if: inputs.copilot`,
  default off; seat required, ~50 free premium req/month) and
  **opencode-chat** (OpenCode CLI — a dynamic matrix from the
  **opencode-catalog** job: `opencode_models` list > `opencode_model` single
  > `opencode_free` live `opencode models` query, first 3 — never hardcode;
  the dispatch dropdown can't be populated from a query). Auth: the repo
  `OPENCODE` secret IS AN OPENAI v1 KEY — exposed as `OPENAI_API_KEY` +
  `OPENAI_BASE_URL=https://api.openai.com/v1`; the default query filters
  `^openai/` (free-tagged first, else first 3). Zen/opencode-go free models
  are NOT callable with this key ("This API key can't call models"). The
  secret is ALSO exposed as `OPENROUTER_API_KEY` / `GEMINI_API_KEY` so
  explicit `opencode_models` for those providers work after swapping the
  secret and the catalog grep. Each leg's marker/artifact are
  `-opencode-<model-slug>`-suffixed (slugged because artifact names reject
  `:` — OpenRouter free ids end in `:free`); listen port 4017 is per-runner.
  Cross-runner transport for the answer: each leg's witness uploads its relay
  addrs as a `chat-bridge-<run_id>[-suffix]` artifact; a background writer in
  live-interop polls the run's artifact LIST (dynamic legs) and keeps
  refreshing the responder's bootstrap file (re-read every 30s). Do NOT rely on the public gnostr mesh to deliver
  between arbitrary runners — locally it carried zero envelopes in 90s.
  Relay circuits are short-lived (~1 min) and re-dial-prone: everything
  (witness relays ×10, responder re-dials, answers ×12) runs at 10s cadence,
  and both sides `tagPeer` their topic peers or the connection managers prune
  the bridge links within seconds.
  Local observation: `scripts/local-observe.sh [start|stop|status|tail]`
  runs a supervised fleet (git-ad listener, a CHAT_NEEDLE observer that
  prints every run-marked question/answer verbatim, and a chat-responder
  that answers ANY run's question from your peer — `RESPONDER=0` for
  watch-only) with logs in `$IPFS_OBSERVE_DIR/logs` (default
  `~/.ipfs-agentd-observe`). Requires node >= 22 (`NODE=/path/to/node-22`
  if `node` is older — node 20 crashes undici zstd). Env assignments in
  `svc_launch` must precede the command (`env` semantics) — after it they
  become argv, and the scripts read `process.env`.
  Both model legs PREFLIGHT before starting the witness: opencode legs probe
  the provider HTTP API (key/quota) then `opencode run` the exact model id
  (retried ×2 — GitHub flakes); copilot legs check the CLI runs (a real auth
  probe would burn premium requests). A failed preflight gates the witness +
  agent steps off and ends the leg orange in ~1 min with the API error in the
  step summary — a fast UNAVAILABLE means auth/quota (fix the OPENCODE
  secret), not gossipsub.
  On any leg's WITNESS PASS the leg uploads a `beam-pass-<run_id>[-suffix]`
  artifact; the **beam-promote** job (`needs: both legs`, `if: always() &&
  inputs.bump_on_pass`, concurrency-guarded) bumps the patch version on
  master — package.json + package-lock.json + src/daemon.js + src/tools.js
  (guarded greps: drift warns instead of missing). The promote commit is an
  UNSIGNED bot commit (the GPG key never leaves the maintainer); tags stay
  manual/signed to trigger release.yml.

Running CI locally with `act` (sandbox: dockerd started via `nohup dockerd &`,
act binary at `/mnt/agents/opt/act`, runner image
`ghcr.io/catthehacker/ubuntu:act-22.04` — Docker Hub is unreachable here):

```sh
# clean build, always — no -r (stale containers mask failures)
act -j test -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-22.04 --bind -vv
act workflow_dispatch -W .github/workflows/interop.yml -e /tmp/act-event.json \
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-22.04 --bind -vv
```

Known sandbox flake: act fetching actions from github.com (`info/refs: EOF`)
fails intermittently — re-run; the repo-side retry loops (npm ci in the
action + Dockerfile) only cover registry fetches, not action clones.

`gh` CLI: authenticate with `gh auth login` (token) for private endpoints.
For this public repo, the REST API works unauthenticated and is enough to poll
runs: `gh run list`, or plain
`curl https://api.github.com/repos/RandyMcMillan/ipfs-agentd/actions/runs`.
Git-over-SSH uses `~/.ssh/config` → IdentityFile
`/mnt/agents/output/ssh/id_ed25519`.

## Finding skills / plugins

Before building new capability here, check whether an installable plugin or
skill already covers it: use the plugin system's skill/plugin search
("find skills") with keywords like `ipfs`, `mcp`, `libp2p`, `pinning`. Use
what exists; only then extend `src/tools.js`. This repo deliberately ships a
daemon + tools, not a hosted plugin bundle.
