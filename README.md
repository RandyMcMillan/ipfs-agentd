# ipfs-agentd

Persistent local IPFS daemon for one AI agent. Headless [Helia](https://github.com/ipfs/helia) node with a
disk blockstore, exposed to agents through an [MCP](https://modelcontextprotocol.io) stdio interface.

Built from the node-construction recipe in [helia-ipfs-relay](https://github.com/RandyMcMillan/helia-ipfs-relay)'s
`gnostr-publish.js` — same libp2p stack, same bootstrap list — so agents interoperate with the gnostr git
tools (`git-remote-gnostr`, `gnostr-publish`) out of the box.

## Model

One daemon process per agent. Everything the agent adds stays on its own disk (`~/.ipfs-agentd` by
default) until it explicitly publishes — to the `gnostr` pubsub topic, a pinning service, or a shared
node. Nothing leaves the machine implicitly.

- **stdout** carries the MCP protocol exclusively.
- **stderr** carries timestamped logs (`tail -f` this to watch what the agent is doing).
- Adds are auto-pinned: a daemon that forgets by default is useless.

## Requirements

- Node >= 22 (see `.nvmrc`; `nvm use` picks it up)
- Network access to the libp2p bootstrap nodes for swarm connectivity (adds/cats work offline; fetch/publish need peers)

## Run

```sh
npm install
ipfs-agentd                         # stdio MCP server, repo at ~/.ipfs-agentd (bin: src/bin.js)
node src/mcp-server.js --repo /path # custom repo dir
node test/smoke.mjs                 # in-process test of every tool
```

Logging is leveled: `--logging debug|info|warn|error|silent` (`--quiet` = `silent`).
Tool calls log at `debug`; lifecycle/peer events at `info`.

## Chat CLI

```sh
ipfs-agentd chat                          # join topic "gnostr" as $USER
ipfs-agentd chat --topic mymesh --name alice --repo /tmp/alice --logging info
```

Humans type lines; agents join the same topic through the
`ipfs_pubsub_publish` / `ipfs_pubsub_pull` MCP tools. The shared envelope
(UTF-8 JSON on the gossipsub topic) is:

```json
{ "type": "chat", "name": "<display name>", "text": "<message>", "at": <epoch ms> }
```

Anything on the topic that is not a chat envelope is rendered as
`RAW <base64>` so binary/agent protocols stay visible to humans. The CLI
prints its dialable `listen:` / `listen(relayed):` lines after the ready
banner — agents/scripts dial those to attach. Ctrl-C leaves the topic.

Reachability note: gossipsub needs a connected mesh. Two NAT'd peers that
never dial each other do not exchange messages — dial the advertised
addresses (or share a reachable rendezvous) first.

## Tools

| Tool | What it does |
|---|---|
| `ipfs_id` | Peer id, listen addrs, connection counts |
| `ipfs_add` | Add bytes (b64) → CID, auto-pinned |
| `ipfs_add_all` | Add a file tree → directory CID, auto-pinned |
| `ipfs_cat` | Read CID content back (b64); offset/length; 32 MiB cap |
| `ipfs_stat` | UnixFS stat: type, sizes, block count |
| `ipfs_pin_add` / `ipfs_pin_rm` / `ipfs_pin_ls` | Pin management |
| `ipfs_resolve` | `/ipns/<name>` → CID, or validate a CID |
| `ipfs_pubsub_publish` | gossipsub publish (default topic `gnostr`) |
| `ipfs_pubsub_pull` | Poll queued messages for a topic (subscribe-on-first-pull, bounded queue) |
| `ipfs_name_publish` | Publish CID under a one-shot IPNS key (name = key PeerId) |
| `git_publish_repo` | `git bundle --all` → IPFS → pin → announce on gnostr topic (wire-compatible with `git-remote-gnostr`). Refuses shallow clones (e.g. checkout `fetch-depth 1`) — a depth-1 bundle misses parents |
| `git_fetch_bundle` | Fetch a bundle: `gnostr://cid/<CID>` directly or `gnostr://<name>` via topic discovery; saves to disk for `git bundle verify`/`clone` |

## Git bridge

`git_publish_repo` / `git_fetch_bundle` speak the same ad format as
[helia-ipfs-relay](https://github.com/RandyMcMillan/helia-ipfs-relay)'s gnostr tools
(`{type:'git', name, at, bundle, addrs?}`): an agent-published repo is clonable by anyone
running `git-remote-gnostr` (`git clone gnostr://<name>`), and vice versa. Name discovery
is unauthenticated (newest ad wins) — in adversarial settings use `gnostr://cid/<CID>`,
which is content-addressed.

Caveats: publishing with zero pubsub peers returns `published:false` (bundle is still on
IPFS and pinned — republish when peers connect). The daemon is the bitswap seeder while
alive; stop it and the bundle is only fetchable if someone else pinned the CID.
Publishers should **subscribe** to the topic, not just publish: gossipsub's fanout
path (publish without subscribe) samples recipients once and never re-samples while
re-publishing — on the public swarm it freezes full of other topic subscribers and
late-joining fetchers never hear the ad. The mesh path (subscribe) grafts new topic
peers every heartbeat.

### git remote helpers

This repo ships two git remote helpers (package bins, `npm link` to install):

```sh
git clone gnostr://<repo-name>      # named, discoverable over the gnostr topic
git clone gnostr://cid/<bundle-cid> # content-addressed, nothing to shadow
git clone ipfs://<bundle-cid>       # content-addressed, no topic at all
```

`git-remote-gnostr` is wire-compatible with
[helia-ipfs-relay](https://github.com/RandyMcMillan/helia-ipfs-relay)'s helper (same ad
format, same URL forms) but is built on this repo's own node factory — no duplicated
libp2p stack. `git-remote-ipfs` is the content-addressed-only variant: no pubsub, just
bitswap. Both are fetch-only (push is refused) and snapshot-based (each clone re-fetches
the whole bundle). Helpers keep their own block cache at `~/.ipfs-agentd-git`
(`IPFS_AGENTD_GIT_REPO` to override), so repeat clones of the same repo hit local blocks.

Seeder reachability: discovery is gossipsub for `gnostr://<name>` and pure bitswap for
the CID forms — in both cases the fetcher must be able to connect to the seeder. Dial it
explicitly with `GNOSTR_BOOTSTRAP=/ip4/…/tcp/…/p2p/<peerId>` (the `ipfs_id` tool reports
the publisher's addrs), or run the publisher with `GNOSTR_LISTEN` on a public host.

## Repo web service (`ipfs-agentd serve`)

GitHub-like repo browser for humans **and** agents — no GitHub (or any third
party) involved. Each subdir of `--root` is a repo (bare repo, working clone,
or `.bundle` file — bundles are materialized automatically):

```sh
ipfs-agentd serve --root /data/repos --port 8080 --name team
ipfs-agentd serve --root /data/repos --publish        # also announce on gnostr
```

- `/` — instance home: repo cards, agent instructions (MCP config snippet, chat topic)
- `/<repo>` — file table, rendered README, latest commit, **clone box**
  (`gnostr://<name>` + `ipfs://<bundle-cid>` when publishing), `.bundle` download
- `/<repo>/tree|blob|raw/<ref>/<path>` — browsing with line numbers, raw bytes
- `/<repo>/commits/<ref>` — commit history; `/<repo>/bundle` — on-the-fly bundle

With `--publish`, every repo is announced on the gnostr topic (via
`git_publish_repo`) and the repo page shows the bundle CID and publisher
addrs — the page humans browse is exactly what an agent needs to dial/clone.

### Docker

`Dockerfile` (all-in-one: web service default CMD; MCP daemon and chat CLI
via `command:` override) + `docker-compose.yml`. One container = one instance;
mount repos per instance:

```sh
docker build -t ipfs-agentd .
docker run -p 8080:8080 -v /srv/myrepo:/data/repos/myrepo ipfs-agentd
docker run -p 8080:8080 -v /srv/myrepo:/data/repos/myrepo \
  -e PUBLISH=1 -e GNOSTR_LISTEN=/ip4/0.0.0.0/tcp/4001 ipfs-agentd
```

`docker compose up instance-a` / `instance-b` runs two isolated instances with
their own mounts; `--profile agent` runs the plain MCP daemon. The image is
verified locally (build + container serving a mounted bare repo with clone
URLs rendered).

## Env

| Var | Default | Purpose |
|---|---|---|
| `IPFS_AGENTD_REPO` | `~/.ipfs-agentd` | Blockstore/datastore directory |
| `GNOSTR_BOOTSTRAP` | — | Extra comma-separated multiaddrs to dial at boot |
| `GNOSTR_LISTEN` | — | Listen multiaddrs when running on a public host |
| `GNOSTR_LISTEN_FILE` / `GNOSTR_BOOTSTRAP_FILE` | — | File holding the multiaddr value. Windows git-bash (MSYS2) rewrites env *values* that look like POSIX paths when spawning native node — no exclude switch covers env vars. Stage the multiaddr in a file (a native path survives) and pass these; the file wins over the env var. Read at node startup in `src/node.js` |
| `REBOOTSTRAP_SECS` | `60` | Re-dial unconnected bootstrap peers every N s (0 disables) |

## Notes / limits

- DHT runs in **client mode** (safe behind NAT): content this node has is fetchable by peers who
  know its CID/addrs; it does not serve DHT records. Run with `GNOSTR_LISTEN` on a public host for
  direct dialability.
- `ipfs_cat` refuses single responses over 32 MiB — page with `offset`/`length`.
- `ipfs_name_publish` is one-shot (fresh key each call, key not persisted yet). Named key reuse is
  future work.
- Pubsub message queues are bounded (1000/topic); an agent that never pulls drops old messages.
- Relayed dialing works (relay v2 reservations + `/p2p-circuit` addresses + dcutr hole
  punching are enabled by default), but **bitswap fetch over a relayed connection fails**
  in this Helia 7 / js-libp2p 3.x stack ("Failed to load block" over a stable relayed
  session, then `NO_RESERVATION` on re-dial). Direct-dial fetch works. Do not rely on
  fetching content through relays; use pubsub for discovery, then dial directly or
  deploy a publicly reachable seeder.

## Roadmap

- Phase 2 (skipped for now): Kimi plugin bundle. **Blocked by design**: Kimi custom
  plugins are hosted-only and require a remote OAuth-authorized MCP endpoint — a stdio
  `command` is rejected by validation. That contradicts the local-daemon-per-agent
  model this project chose. Revisit only if a hosted bridge variant is ever wanted.
- Phase 3 (done): git bridge — `git_publish_repo` / `git_fetch_bundle`, gnostr-wire-compatible.
- Phase 4 (done): `ipfs-agentd` CLI binary — gossipsub topic chat (human ↔ agent ↔
  agent, shared `{type:'chat',name,text,at}` envelope) + `--logging` level flag.
- Phase 5 (done): git remote helpers shipped in-repo — `git-remote-gnostr`
  (wire-compatible with helia-ipfs-relay, built on this repo's node factory) and
  `git-remote-ipfs` (content-addressed only). e2e-tested with real `git clone`
  (both URL forms, fsck-clean, `test/git-remote-e2e.mjs`).
- Phase 6 (done): repo web service (`ipfs-agentd serve`) — GitHub-like browser,
  per-instance repo mounts, `--publish` announces on gnostr; Dockerfile +
  docker-compose (one instance per container). e2e: `test/web-e2e.mjs`; image
  build + container smoke verified locally.
- Future: web app as an active IPFS peer — gnostr repo discovery, responsive repo
  cards, per-repo clone-as-git / CAR download options, bookmarks; remote-pinning
  backup for durability; named IPNS key reuse; dual-role relay.

## CI

- **ci.yml** — `npm ci` + full `npm test` (smoke, MCP e2e, persist, chat e2e,
  git-remote e2e, web e2e) on every push/PR (Node 22). Locally:
  `act -j test -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-22.04`.
- **interop.yml** — live interop on the real `gnostr` topic, `workflow_dispatch`
  only. Inputs: `ref` (branch/tag, default master), `live_seconds` (publisher
  seed window), and per-OS selects — `linux` (default; also runs the Docker peer
  leg), `windows`, `macos`. A publisher daemon seeds the repo bundle and
  re-announces it every 15s; an independent fetcher node proves the bundle by CID
  (bitswap) and by name (topic discovery); on linux a Docker container joins as a
  third independent peer (fetch by CID/name + container-side
  `git clone gnostr://<name>` with this repo's helper). Locally reproducible via
  `npm run interop:publisher` / `npm run interop:fetch` (see file headers), or
  watch the live topic with `node scripts/listen-gnostr.mjs` (`GNOSTR_TOPIC`,
  `LISTENER_REPO`).
- **docker.yml** — image build on PRs; build + GHCR publish on push to master.
- **release.yml** — tag push (`v*`) → GitHub release with the bundle.
- **deploy-gh-pages.yml** — pins the built web app and deploys the IPFS site.
