/* ipfs-agentd — node factory.
 *
 * Persistent headless Helia node for one AI agent:
 *   - disk blockstore + datastore (content survives restarts)
 *   - libp2p stack identical to gnostr-publish.js (same bootstrap list,
 *     same services) so agents interoperate with the gnostr git tools
 *   - helia owns the libp2p config (createHelia({ libp2p: ... })) — the
 *     gnostr-publish recipe: pass options + explicit start, or the
 *     bitswap broker never registers
 *
 * Env:
 *   IPFS_AGENTD_REPO   blockstore/datastore directory (default ~/.ipfs-agentd)
 *   GNOSTR_BOOTSTRAP   comma-separated extra multiaddrs to dial at boot
 *   GNOSTR_LISTEN      comma-separated listen multiaddrs (public hosts only)
 */
import { createHelia } from 'helia'
import { FsBlockstore } from 'blockstore-fs'
import { FsDatastore } from 'datastore-fs'
import { unixfs } from '@helia/unixfs'
import { ipns } from '@helia/ipns'
import { helia as ipnsHelia, pubsub as ipnsPubsub } from '@helia/ipns/routing'
import { multiaddr } from '@multiformats/multiaddr'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { gossipsub } from '@libp2p/gossipsub'
import { bootstrap } from '@libp2p/bootstrap'
import { kadDHT } from '@libp2p/kad-dht'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { autoNAT } from '@libp2p/autonat'
import { dcutr } from '@libp2p/dcutr'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* canonical libp2p bootstrap list (same as helia-ipfs-relay server.js) */
const BOOTSTRAP_LIST = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPRQ4HEBC6VrPNLPWezKBcjDiJvRft2E6q',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCRHPZsaM3KFN4j5RMteQdaLvMq34dxrb5',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
  ...(process.env.GNOSTR_BOOTSTRAP
    ? process.env.GNOSTR_BOOTSTRAP.split(',').map((s) => s.trim()).filter(Boolean)
    : [])
]

export const DEFAULT_REPO = process.env.IPFS_AGENTD_REPO || join(homedir(), '.ipfs-agentd')

/* create + start the node. never throws for "no peers yet" — callers get a
 * node that fills in connections as bootstrap dials land.
 *
 * Reachability: every publicly reachable Kubo node (including the bootstrap
 * list) runs a relay v2 server by default. discoverRelays asks connected
 * peers for reservations and advertises /p2p-circuit addresses, so NAT'd
 * agents are dialable through the swarm; dcutr then tries to upgrade relayed
 * connections to direct ones (real hole punching), autonat reports whether
 * the node is publicly dialable at all. */
export async function createAgentNode ({ repoPath = DEFAULT_REPO, log = () => {} } = {}) {
  log('repo: ' + repoPath)
  const blockstore = new FsBlockstore(join(repoPath, 'blocks'))
  const datastore = new FsDatastore(join(repoPath, 'data'))
  const listen = process.env.GNOSTR_LISTEN
    ? process.env.GNOSTR_LISTEN.split(',').map((s) => s.trim()).filter(Boolean)
    : []

  const helia = createHelia({
    blockstore,
    datastore,
    libp2p: {
      /* relay reservations land under /p2p-circuit; explicit listeners come from GNOSTR_LISTEN */
      addresses: { listen: [...listen, '/p2p-circuit'] },
      transports: [tcp(), webSockets(), circuitRelayTransport({ discoverRelays: 2 })],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [bootstrap({ list: BOOTSTRAP_LIST })],
      services: {
        identify: identify(),
        ping: ping(),
        /* client mode: safe behind NAT; does not publish undialable DHT records */
        dht: kadDHT({ clientMode: true }),
        pubsub: gossipsub({ emitSelf: true }),   /* agents see their own publishes in ipfs_pubsub_pull */
        autonat: autoNAT(),
        dcutr: dcutr()
      }
    }
  })
  await helia.start()
  const node = helia.libp2p
  log('peer id: ' + node.peerId.toString())
  const addrs = node.getMultiaddrs().map((a) => a.toString())
  if (addrs.length === 0) log('listening: (none yet — relay reservations still landing)')
  for (const a of addrs) log('listening: ' + a)
  node.addEventListener('connection:prune', (e) => log('connection:prune ' + (e.detail?.remotePeer?.toString?.() || e.detail?.remoteAddr?.toString?.() || 'peer?')))
  node.addEventListener('connection:close', (e) => {
    const conn = e.detail
    if (conn.remoteAddr.toString().includes('/p2p-circuit/')) log('connection:close (relayed) ' + conn.remotePeer.toString())
  })

  /* periodic re-bootstrap: @libp2p/bootstrap dials once at startup, so a node
   * that boots on a flaky network (or wakes before its NAT/relay is ready)
   * stays partitioned until restart. Every RESECS, re-dial any bootstrap peer
   * we are not currently connected to. Unref'd — never holds the process open. */
  const REBOOTSTRAP_SECS = Number(process.env.REBOOTSTRAP_SECS || 60)
  if (REBOOTSTRAP_SECS > 0) {
    const rebootstrap = setInterval(() => {
      const connected = new Set(node.getPeers().map(p => p.toString()))
      for (const a of BOOTSTRAP_LIST) {
        const m = a.match(/\/p2p\/([^/]+)$/)
        if (m && connected.has(m[1])) continue
        node.dial(multiaddr(a)).catch(() => {})   /* already dialing / unreachable — fine */
      }
      log('re-bootstrap sweep: ' + connected.size + ' connected')
    }, REBOOTSTRAP_SECS * 1000)
    rebootstrap.unref()
  }

  /* IPNS: helia routing (DHT, client mode) + pubsub router, which works even client-side */
  const namesys = ipns(helia, { routers: [ipnsHelia(helia), ipnsPubsub(helia)] })

  node.addEventListener('peer:connect', (e) => log('peer:connect ' + e.detail.toString() + ' (' + node.getPeers().length + ' peers)'))
  node.addEventListener('peer:disconnect', (e) => log('peer:disconnect ' + e.detail.toString()))

  return { helia, node, ufs: unixfs(helia), ipns: namesys, repoPath }
}
