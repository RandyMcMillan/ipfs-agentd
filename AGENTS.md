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
npm test                            # smoke + MCP e2e + persist + chat e2e
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
  - `src/bin.js` — CLI dispatcher: `daemon` (default) / `chat` / `--help`.
  - `src/cli.js` — gossipsub chat REPL (envelope `{type:'chat',name,text,at}`;
    prints `listen:`/`listen(relayed):` lines so scripts/agents can attach).
  - `src/logger.js` — leveled stderr logger shared by daemon and CLI.
- **Dependency rules (hard-won, see commit history):**
  - `blockstore-fs@^4` + `datastore-fs@^12` — the only versions matching helia
    7's interfaces. Older majors install cleanly and silently no-op pins.
  - helia `pins.add/rm` are async generators — drain them (see `drainPin`);
    swallow `AlreadyPinnedError` on re-pin.
  - Several `multiformats` copies coexist: pass CID **strings** to
    `@helia/unixfs`, CID **instances** to `helia.pins`.
  - Keep `@libp2p/*` pins aligned with helia-ipfs-relay's package.json.
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
  `src/mcp-server.js`. Not shipped; keep the daemon local — see README
  "Roadmap" for why a hosted Kimi-plugin variant was rejected (hosted-only +
  OAuth MCP), and only revisit if the privacy model changes.
- **gnostr git interop:** `git_publish_repo`/`git_fetch_bundle` speak the same
  ad format as helia-ipfs-relay (`{type:'git', name, at, bundle, addrs?}`).
  Adversarial settings: always the `gnostr://cid/<CID>` form — name discovery
  is unauthenticated (newest ad wins).
- **Pubsub across NAT:** two NAT'd nodes cannot see each other's topic
  messages without a mutually reachable rendezvous (a public relay subscriber
  or a shared helia-ipfs-relay `server.js` host). Relay reservations make
  nodes *dialable*; they do not bridge gossipsub meshes.

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
  `git clone` locally, or `git clone gnostr://…` with `git-remote-gnostr`.
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
- Name discovery (`gnostr://<name>`) is unauthenticated, newest ad wins;
  adversarial settings → `gnostr://cid/<CID>`.

## CI / gh

Workflows:

- `ci.yml` — `npm ci` + `npm test` on every push/PR (Node 22).
- `interop.yml` — live interop on `feat/**` pushes and manual dispatch
  (`live_seconds` input): publisher seeds for the live window, an independent
  node fetches by CID and by name, the real `git-remote-gnostr` helper clones
  the bundle with plain git.

Running CI locally with `act` (sandbox: dockerd started via `nohup dockerd &`,
act binary at `/mnt/agents/opt/act`, runner image
`ghcr.io/catthehacker/ubuntu:act-22.04` — Docker Hub is unreachable here):

```sh
act -j test -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-22.04
act workflow_dispatch -W .github/workflows/interop.yml -e /tmp/act-event.json \
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-22.04
# flags: -r reuse the container (kills nothing for you — pkill stale
#        ipfs-agentd daemons first), --bind live-mount the repo, -vv debug logs
```

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
daemon + tools, not a Kimi plugin bundle (see README Roadmap).
