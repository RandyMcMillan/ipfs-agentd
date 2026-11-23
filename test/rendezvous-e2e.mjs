/* rendezvous-e2e — topic peer discovery through the rendezvous protocol.
 *
 * 1. server + two clients on bare libp2p (tcp/127.0.0.1)
 * 2. A joins the namespace, then B joins -> B must discover AND dial A
 * 3. gossipsub across the rendezvous-found connection: B publishes on the
 *    namespace topic, A must receive it — "find gnostr peers" end to end
 * 4. unregister -> namespace empty again
 */
import assert from 'node:assert'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { gossipsub } from '@libp2p/gossipsub'
import { identify } from '@libp2p/identify'
import { startRendezvousServer, startRendezvousClient, RENDEZVOUS_PROTO } from '../src/rendezvous.js'

const NS = 'rv-e2e-' + process.pid
const results = []
const check = (what, cond) => {
  results.push([what, !!cond])
  console.log('rendezvous-e2e: ' + (cond ? 'PASS' : 'FAIL') + ' ' + what)
}

const mk = () => createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify(), pubsub: gossipsub({ emitSelf: false }) }
})

const server = await mk()
const srv = startRendezvousServer(server, { log: () => {} })
/* getMultiaddrs() already carries the /p2p/<id> suffix (multiaddr v13) */
const srvAddr = server.getMultiaddrs()[0].toString()

const a = await mk()
const b = await mk()
const ca = startRendezvousClient(a, { servers: [srvAddr], discoverEveryMs: 3000 })
const cb = startRendezvousClient(b, { servers: [srvAddr], discoverEveryMs: 3000 })

check('server speaks ' + RENDEZVOUS_PROTO, server.getProtocols().includes(RENDEZVOUS_PROTO))

/* A joins first, registers; B joins after -> B discovers and dials A */
await ca.join(NS)
const found = await cb.join(NS)
check('B discovered A via rendezvous', found >= 1)
let dialed = false
for (let i = 0; i < 40 && !dialed; i++) {
  await new Promise((r) => setTimeout(r, 500))
  dialed = b.getPeers().map(String).includes(a.peerId.toString())
}
check('B dialed A via rendezvous', dialed)

/* gossipsub over the rendezvous-found connection: B publishes, A receives */
a.services.pubsub.subscribe(NS)
b.services.pubsub.subscribe(NS)
await new Promise((r) => setTimeout(r, 4000))   /* let the mesh graft */
const got = new Promise((resolve) => {
  a.services.pubsub.addEventListener('message', (evt) => {
    if (evt.detail.topic !== NS) return
    try { resolve(JSON.parse(new TextDecoder().decode(evt.detail.data)).text) } catch { /* ignore */ }
  })
})
await b.services.pubsub.publish(NS, new TextEncoder().encode(JSON.stringify({ text: 'hello via rendezvous' })))
const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 15000))])
check('gossipsub message across rendezvous-found peer', msg === 'hello via rendezvous')

/* unregister clears the registration */
await new Promise((r) => setTimeout(r, 500))
const before = (await cb.discover(NS)).length
srv.store.get(NS)?.delete(a.peerId.toString())
const after = (await cb.discover(NS)).filter((p) => p.id === a.peerId.toString()).length
check('discover reflects unregister', after === 0 && before >= 1)

await a.stop()
await b.stop()
await server.stop()
const failed = results.filter(([, ok]) => !ok)
console.log('rendezvous-e2e: ' + (failed.length === 0 ? 'all green' : failed.length + ' FAILED'))
process.exit(failed.length === 0 ? 0 : 1)
