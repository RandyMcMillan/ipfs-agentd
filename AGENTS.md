# AGENTS.md

You are an agent reading `ipfs-agentd`. This file orients you; README.md is the
human-facing reference and is kept current — read it next.

## What this repo is

A persistent local IPFS daemon (Helia 7 / js-libp2p 3.x, Node >= 22) for one AI
agent: disk blockstore + MCP stdio server + gossipsub chat CLI + git remote
helpers + repo web service. Agents on the same machine interoperate with gnostr
git tools (`git-remote-gnostr`, `gnostr-publish`) over the public `gnostr`
gossipsub topic.

## Layout

- `src/node.js` — node factory (bootstrap list, relay v2, dcutr, autonat, DHT
  client mode, re-bootstrap sweep, `GNOSTR_*_FILE` env reads). Everything builds
  on this; do not create parallel libp2p stacks.
- `src/tools.js` — MCP tool implementations (publish/fetch/pubsub/IPNS).
- `src/daemon.js`, `src/mcp-server.js`, `src/bin.js` — stdio server + CLI entry.
- `src/cli.js` — chat CLI; `src/serve.js` — repo web service; `src/git-remote-*.js` — git helpers.
- `test/` — `smoke.mjs`, `mcp-e2e.mjs`, `persist.mjs`, `chat-e2e.mjs`,
  `git-remote-e2e.mjs`, `web-e2e.mjs`, `interop-publisher.mjs`, `interop-fetch.mjs`.
- `scripts/listen-gnostr.mjs` — join the live gnostr topic and print repo ads.
- `.github/workflows/` — ci (push/PR), interop (dispatch-only), docker (GHCR),
  release (tags), deploy-gh-pages.

## How an agent uses this daemon

1. Start it: `ipfs-agentd` (stdio MCP, repo at `~/.ipfs-agentd`). stdout is the
   MCP protocol exclusively — never print to stdout; log to stderr.
2. Tools (full table in README): `ipfs_id`, `ipfs_add`/`ipfs_add_all`/`ipfs_cat`/
   `ipfs_stat`, pin management, `ipfs_resolve`, `ipfs_pubsub_publish`/`_pull`,
   `ipfs_name_publish`, `git_publish_repo`, `git_fetch_bundle`.
3. To talk with humans/other agents live: join topic `gnostr` and speak the chat
   envelope: `{"type":"chat","name":"<display name>","text":"<message>","at":<epoch ms>}`
   (UTF-8 JSON). Non-envelope payloads render as `RAW <base64>` to humans.
4. To publish/fetch git repos: `git_publish_repo` (bundle → IPFS → pin → ad) and
   `git_fetch_bundle` (`gnostr://cid/<CID>` or `gnostr://<name>`). Ad format:
   `{"type":"git","name","at","bundle","addrs?"}`.

## Hard-won operational rules (do not relearn these)

- **Subscribe before you publish.** gossipsub's fanout path (publish without
  subscribe) samples recipients once and never re-samples while you keep
  publishing — on the public swarm it freezes full of other topic subscribers
  and late-joining peers never hear your ads. `pubsub.subscribe(topic)` puts you
  on the mesh path, which grafts new topic peers every heartbeat. This burned a
  CI interop run ("no git ad within 90000ms" while directly connected).
- **Two NAT'd peers that never dial each other do not exchange messages.** Dial
  advertised addrs (or a shared rendezvous) first; gossipsub needs a mesh.
- **Relayed bitswap fetch fails** in this stack ("Failed to load block" over a
  stable relayed session). Use pubsub for discovery, then direct-dial.
- **`git_publish_repo` refuses shallow clones** (checkout `fetch-depth 1`) — a
  depth-1 `git bundle --all` misses parents. CI checkouts that publish must use
  `fetch-depth: 0`.
- **Windows git-bash (MSYS2)** rewrites env *values* that look like POSIX paths
  when spawning native node; no exclude switch covers env vars. Stage multiaddrs
  in files and pass `GNOSTR_LISTEN_FILE` / `GNOSTR_BOOTSTRAP_FILE` (read in
  `src/node.js`; file wins over env).
- **Hosted-runner uid (1001) vs image `node` uid (1000)**: a container can't
  write host-mounted dirs — `mkdir -p` + `chmod -R 777` on the mount, or pass
  state via env.
- `$RUNNER_TEMP` is wiped between steps on hosted runners; docker legs recreate
  state dirs and take CID/name via env, not files.

## Contributing (agent workflow)

- `npm test` must pass (all six suites: smoke, mcp-e2e, persist, chat-e2e,
  git-remote-e2e, web-e2e).
- Commits are GPG-signed (repo has `commit.gpgsign=true`); identity and key are
  configured repo-locally.
- CI exactness: use Node from `.nvmrc` (22.x); run `bash -n` on workflow run
  blocks after editing YAML; interop changes are validated with a local
  publisher+fetcher pair before pushing.
- Keep README.md and this file in sync with behavior changes.

## Verification commands

```sh
npm test                                   # full suite
node test/smoke.mjs                        # every tool, in-process
node scripts/listen-gnostr.mjs             # watch the live gnostr topic
INTEROP_REPO=$PWD INTEROP_LIVE_SECS=60 INTEROP_AD_SECS=5 \
  INTEROP_OUT=/tmp/interop node test/interop-publisher.mjs   # local seeder
GNOSTR_BOOTSTRAP_FILE=/tmp/interop/bootstrap \
  node test/interop-fetch.mjs              # independent fetcher
```
