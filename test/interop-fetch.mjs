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

const byName = await tools.gitFetchBundle(ctx, { source: name, outPath: join(outDir, 'by-name.bundle'), topic, timeoutMs: 90000 })
check('fetch by name (topic discovery)', byName.bundle === cid && byName.size === byCid.size, byName.size + ' bytes')

await ctx.helia.stop()
if (failed) { log(failed + ' FAILED — exiting 1'); process.exit(1) }
log('all green')
