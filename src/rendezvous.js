/* rendezvous.js — topic-scoped peer discovery for ipfs-agentd.
 *
 * Gossipsub has no lookup: topic membership only exists between directly
 * connected peers, so "who is on gnostr?" is unanswerable without already
 * knowing someone on it. This module implements a tiny rendezvous protocol
 * (libp2p rendezvous semantics — register / unregister / discover under a
 * string namespace with TTLs) so any node can ask a rendezvous server for
 * the dialable addresses of peers that joined a namespace:
 *
 *   server:  startRendezvousServer(node)        — usually the long-lived
 *            daemon/`serve` node (GNOSTR_RENDEZVOUS_SERVER=1); in-memory
 *            store, expired registrations swept periodically
 *   client:  startRendezvousClient(node)        — every node; inert until
 *            it knows a server (GNOSTR_RENDEZVOUS_SERVERS env or
 *            addServer() from e.g. a witness-dial envelope)
 *   use:     client.join(topic)                 — register our addrs under
 *            the topic's namespace, then discover + dial topic peers every
 *            few seconds, so gossipsub starts with real neighbors instead
 *            of mesh luck
 *
 * Wire format: one request + one response per stream, length-prefixed JSON
 * frames over /ipfs-agentd/rendezvous/1.0.0 (deliberately our own protocol
 * string — zero dependencies, SEA-safe, no native modules).
 *
 * libp2p v3 notes (learned the hard way):
 *  - streams have no sink()/source(); write with stream.send(data) + half-
 *    close with stream.closeWrite(), read by async-iterating the stream
 *  - direct /ip4|dns addrs must be dialed WITHOUT the trailing /p2p/<id>
 *    (the tcp transport's matcher rejects suffixed addrs); circuit addrs
 *    keep their suffix — it carries the hop destination
 */
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'

export const RENDEZVOUS_PROTO = '/ipfs-agentd/rendezvous/1.0.0'

function concat (a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/* send one JSON frame and half-close the write side so the peer can still
 * answer on the same stream */
async function writeFrame (stream, obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj))
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint32(0, body.length)
  stream.send(concat(head, body))
  if (typeof stream.closeWrite === 'function') await stream.closeWrite()
  else await stream.close()
}

/* read exactly one frame from an async-iterable stream (v3 streams are) */
async function readFrame (stream) {
  let buf = new Uint8Array(0)
  for await (const chunk of stream) {
    const c = chunk instanceof Uint8Array ? chunk : (chunk.subarray ? chunk.subarray() : new Uint8Array(chunk))
    if (c.length > 0) {
      const next = new Uint8Array(buf.length + c.length)
      next.set(buf)
      next.set(c, buf.length)
      buf = next
    }
    if (buf.length < 4) continue
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0)
    if (len > 1 << 20) throw new Error('rendezvous frame too large')
    if (buf.length < 4 + len) continue
    return JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len)))
  }
  return null
}

/* the peer id is the last /p2p/ (421) component's value (multiaddr v13
 * dropped getPeerId) */
function peerIdOf (addr) {
  try {
    const comps = multiaddr(addr).getComponents()
    const last = comps[comps.length - 1]
    return last && last.code === 421 ? String(last.value) : null
  } catch { return null }
}

/* an addr we can hand to node.dial / node.dialProtocol: strip the trailing
 * /p2p/<id> from DIRECT addrs (the transport matcher rejects it; identity
 * comes from the noise handshake), keep it on circuit addrs (it is the hop
 * destination) */
function dialableAddr (addr) {
  try {
    const ma = multiaddr(addr)
    const s = ma.toString()
    if (s.includes('/p2p-circuit')) return ma
    const i = s.lastIndexOf('/p2p/')
    return i === -1 ? ma : multiaddr(s.slice(0, i))
  } catch { return null }
}

export function startRendezvousServer (node, { log = () => {}, maxTTL = 3600, maxResults = 32 } = {}) {
  /* ns -> Map(peerId -> { addrs, exp }) — in-memory on purpose: a
   * restarted server with an empty store is harmless, peers re-register */
  const store = new Map()
  /* libp2p 3.5.1 calls handlers as handler(stream, connection) — two
   * positional args, not an IncomingStreamData object */
  node.handle(RENDEZVOUS_PROTO, (stream, connection) => {
    const peerId = connection.remotePeer.toString()
    void (async () => {
      const req = await readFrame(stream)
      if (req === null) return
      const now = Date.now()
      if (req.op === 'register' && typeof req.ns === 'string' && Array.isArray(req.addrs)) {
        const ttl = Math.min(Math.max(Number(req.ttl) || 0, 0), maxTTL) || maxTTL
        if (!store.has(req.ns)) store.set(req.ns, new Map())
        store.get(req.ns).set(peerId, { addrs: req.addrs.filter((a) => typeof a === 'string').slice(0, 16), exp: now + ttl * 1000 })
        await writeFrame(stream, { ok: true, ns: req.ns, ttl }).catch(() => {})
        log('rendezvous: ' + peerId.slice(0, 12) + '… registered in "' + req.ns + '" (ttl ' + ttl + 's)')
      } else if (req.op === 'unregister' && typeof req.ns === 'string') {
        store.get(req.ns)?.delete(peerId)
        await writeFrame(stream, { ok: true, ns: req.ns }).catch(() => {})
      } else if (req.op === 'discover' && typeof req.ns === 'string') {
        const limit = Math.min(Math.max(Number(req.limit) || maxResults, 1), maxResults)
        const peers = []
        for (const [id, r] of store.get(req.ns) || []) {
          if (r.exp > now && r.addrs.length > 0) peers.push({ id, addrs: r.addrs })
          if (peers.length >= limit) break
        }
        await writeFrame(stream, { ok: true, ns: req.ns, peers }).catch(() => {})
      } else {
        await writeFrame(stream, { ok: false, error: 'unknown op' }).catch(() => {})
      }
    })().catch(() => { try { stream.abort() } catch { /* gone */ } })
  })
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const m of store.values()) for (const [id, r] of m) if (r.exp <= now) m.delete(id)
  }, 60000)
  sweep.unref?.()
  log('rendezvous: server up (' + RENDEZVOUS_PROTO + ')')
  return {
    store,
    stop: () => { clearInterval(sweep); return node.unhandle(RENDEZVOUS_PROTO).catch(() => {}) }
  }
}

export function startRendezvousClient (node, { servers = [], log = () => {}, ttl = Number(process.env.GNOSTR_RENDEZVOUS_TTL || 1800), discoverEveryMs = Number(process.env.GNOSTR_RENDEZVOUS_DISCOVER_MS || 15000), maxDial = 8 } = {}) {
  const self = node.peerId.toString()
  const serverPeers = new Set()      /* peer id strings we treat as servers */
  const serverAddrs = new Map()      /* peer id -> [multiaddr strings] */
  const joined = new Set()           /* namespaces we registered */
  const dialed = new Set()           /* peers auto-dialed via discovery */
  const pendingDial = new Set()

  function addServer (addr) {
    const id = peerIdOf(String(addr))
    if (!id || id === self) return false
    if (!serverAddrs.has(id)) serverAddrs.set(id, [])
    if (serverAddrs.get(id).includes(String(addr))) return false
    serverAddrs.get(id).push(String(addr))
    serverPeers.add(id)
    kick()
    return true
  }

  async function rpc (peerIdStr, req) {
    const ma = dialableAddr((serverAddrs.get(peerIdStr) || [])[0] || '')
    if (ma == null) throw new Error('no address for rendezvous server ' + peerIdStr)
    const stream = await node.dialProtocol(ma, RENDEZVOUS_PROTO)
    try {
      await writeFrame(stream, req)
      return await readFrame(stream)
    } catch (err) {
      try { stream.abort() } catch { /* gone */ }
      throw err
    }
  }

  const myAddrs = () => node.getMultiaddrs().map(String)

  async function registerWith (id, ns) {
    const addrs = myAddrs()
    if (addrs.length === 0) return
    const res = await rpc(id, { op: 'register', ns, addrs, ttl }).catch(() => null)
    if (res?.ok) log('rendezvous: registered in "' + ns + '" with ' + id.slice(0, 12) + '…')
  }

  /* register ALL joined namespaces with ALL known servers (idempotent) */
  let kicking = false
  async function kick () {
    if (kicking) return
    kicking = true
    try {
      for (const id of serverPeers) {
        for (const ns of joined) await registerWith(id, ns)
      }
    } finally { kicking = false }
  }

  async function discoverPeers (ns) {
    const fresh = []
    const seen = new Set()
    for (const id of serverPeers) {
      const res = await rpc(id, { op: 'discover', ns, limit: 16 }).catch(() => null)
      if (!res?.ok || !Array.isArray(res.peers)) continue
      for (const p of res.peers) {
        if (!p || typeof p.id !== 'string' || p.id === self || seen.has(p.id)) continue
        seen.add(p.id)
        fresh.push(p)
      }
    }
    return fresh
  }

  async function dialDiscovered (p) {
    if (dialed.has(p.id) || pendingDial.has(p.id)) return
    pendingDial.add(p.id)
    try {
      for (const a of (p.addrs || []).slice(0, 4)) {
        const ma = dialableAddr(a)
        if (ma == null) continue
        try {
          await node.dial(ma)
          dialed.add(p.id)
          try { node.tagPeer(peerIdFromString(p.id), 'rendezvous', { value: 500, ttl: 3600000 }) } catch { /* keep going */ }
          log('rendezvous: dialed discovered peer ' + p.id.slice(0, 12) + '… (' + String(a).slice(0, 60) + ')')
          return
        } catch { /* try the next addr */ }
      }
    } finally { pendingDial.delete(p.id) }
  }

  /* join(topic): register + keep discovering and dialing topic peers.
   * Resolves to the number of NEW peers discovered in the first round —
   * callers surface it ("found N gnostr peers"). */
  async function join (ns) {
    const isNew = !joined.has(ns)
    joined.add(ns)
    if (isNew) {
      /* dedicated renew/discover cadence per joined namespace */
      const renew = setInterval(() => { void kick() }, Math.max(60000, (ttl * 1000) / 2))
      renew.unref?.()
      const discover = setInterval(() => {
        void discoverPeers(ns).then((peers) => peers.slice(0, maxDial).forEach(dialDiscovered)).catch(() => {})
      }, discoverEveryMs)
      discover.unref?.()
    }
    await kick()
    const peers = await discoverPeers(ns)
    peers.slice(0, maxDial).forEach(dialDiscovered)
    return peers.length
  }

  for (const a of servers) addServer(a)

  return { addServer, join, discover: discoverPeers, isServer: (id) => serverPeers.has(String(id)), stop: () => {} }
}
