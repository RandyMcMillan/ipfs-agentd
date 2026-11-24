/* interop fetcher — an INDEPENDENT second node: fetches the publisher's bundle
 * two ways and verifies both:
 *   1. by CID  (gnostr://cid/<CID>) — pure bitswap, dial the publisher via
 *      GNOSTR_BOOTSTRAP (e.g. /ip4/127.0.0.1/tcp/4011/p2p/<peerId>)
 *   2. by name (topic discovery) — subscribes to the live "gnostr" topic and
 *      takes the newest matching ad the publisher keeps re-announcing
 *
 * Run after interop-publisher (reads cid/peer/name from INTEROP_OUT):
 *   GNOSTR_BOOTSTRAP=/ip4/127.0.0.1/tcp/4011/p2p/<peer> node test/interop-fetch.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'

const outDir = process.env.INTEROP_OUT || '/tmp/interop'
const topic = process.env.INTEROP_TOPIC || 'gnostr'
const cid = (process.env.INTEROP_CID || readFileSync(join(outDir, 'cid'), 'utf8')).trim()
const name = (process.env.INTEROP_NAME || readFileSync(join(outDir, 'name'), 'utf8')).trim()
const log = (m) => process.stderr.write('fetcher: ' + m + '\n')

const ctx = await createAgentNode({ repoPath: join(outDir, 'fetcher-store'), log })
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) log('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; log('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const byCid = await tools.gitFetchBundle(ctx, { source: 'gnostr://cid/' + cid, outPath: join(outDir, 'by-cid.bundle'), topic })
check('fetch by cid (bitswap from peer)', byCid.size > 0, byCid.size + ' bytes')

/* fetch by name over the PUBLIC topic — mesh formation between two arbitrary
 * swarm peers is probabilistic (repro: two relay-public nodes each held 5-14
 * topic peers yet never meshed with each other in 130s), so retry instead of
 * one long wait. Each attempt logs the gossipsub mesh so a failure shows
 * whether we ever shared a mesh with the publisher. */
const PEER = process.env.INTEROP_PEER || ''
const ATTEMPTS = Number(process.env.INTEROP_NAME_ATTEMPTS || 3)
const ATTEMPT_TIMEOUT_MS = Number(process.env.INTEROP_NAME_TIMEOUT_MS || 60000)
let byName = null
/* re-dial the publisher every attempt: the bootstrap connection can be pruned
 * after the bitswap fetch (observed in CI: docker fetcher only reconnected to
 * the publisher during its final re-bootstrap sweep, after all attempts had
 * already timed out ad-less). A live direct connection is enough for the ads
 * to arrive — no mesh graft required. */
import { multiaddr } from '@multiformats/multiaddr'
const BOOTSTRAP_ADDRS = (process.env.GNOSTR_BOOTSTRAP || '').split(',').map(s => s.trim()).filter(Boolean)
async function redialPublisher () {
  for (const a of BOOTSTRAP_ADDRS) {
    try { await ctx.node.dial(multiaddr(a)) } catch { /* already connected or gone */ }
  }
}
for (let attempt = 1; attempt <= ATTEMPTS && !byName; attempt++) {
  await redialPublisher()
  const meshPeers = ctx.node.services.pubsub.getPeers().map(String)
  log(`by-name attempt ${attempt}/${ATTEMPTS} — topic '${topic}' mesh peers: ${meshPeers.length}` +
    (PEER ? (meshPeers.includes(PEER) ? ' (publisher IN mesh)' : ' (publisher not in mesh yet)') : ''))
  try {
    byName = await tools.gitFetchBundle(ctx, { source: name, outPath: join(outDir, 'by-name.bundle'), topic, timeoutMs: ATTEMPT_TIMEOUT_MS })
  } catch (err) {
    log(`attempt ${attempt} failed: ${err.message}`)
  }
}
check('fetch by name (topic discovery)', !!byName && byName.bundle === cid && byName.size === byCid.size, byName ? byName.size + ' bytes' : 'no ad after ' + ATTEMPTS + ' attempts')

await ctx.helia.stop()
if (failed) { log(failed + ' FAILED — exiting 1'); process.exit(1) }
log('all green')
