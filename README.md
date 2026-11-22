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
node src/mcp-server.js              # stdio MCP server, repo at ~/.ipfs-agentd
node src/mcp-server.js --repo /path # custom repo dir
node test/smoke.mjs                 # in-process test of every tool
```

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

## Env

| Var | Default | Purpose |
|---|---|---|
| `IPFS_AGENTD_REPO` | `~/.ipfs-agentd` | Blockstore/datastore directory |
| `GNOSTR_BOOTSTRAP` | — | Extra comma-separated multiaddrs to dial at boot |
| `GNOSTR_LISTEN` | — | Listen multiaddrs when running on a public host |

## Notes / limits

- DHT runs in **client mode** (safe behind NAT): content this node has is fetchable by peers who
  know its CID/addrs; it does not serve DHT records. Run with `GNOSTR_LISTEN` on a public host for
  direct dialability.
- `ipfs_cat` refuses single responses over 32 MiB — page with `offset`/`length`.
- `ipfs_name_publish` is one-shot (fresh key each call, key not persisted yet). Named key reuse is
  future work.
- Pubsub message queues are bounded (1000/topic); an agent that never pulls drops old messages.

## Roadmap

- Phase 2: Kimi plugin bundle wrapping this daemon (MCP tools as shipped).
- Phase 3: git bridge — agent-driven `gnostr-publish`/`git-remote-gnostr` workflows; optional
  remote-pinning backup for durability.
