/* interop publisher — CI live-window seeder.
 *
 * Publishes INTEROP_REPO as a git bundle via git_publish_repo, re-announces it
 * on the real "gnostr" topic every INTEROP_AD_SECS (so late-joining fetchers
 * and external observers can see it), and keeps the node alive — seeding over
 * bitswap — for INTEROP_LIVE_SECS. Writes cid/peer/name files under INTEROP_OUT
 * for the fetch steps.
 *
 * Run locally:
 *   GNOSTR_LISTEN=/ip4/127.0.0.1/tcp/4011 INTEROP_REPO=$PWD \
 *     INTEROP_LIVE_SECS=60 node test/interop-publisher.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'

const liveSecs = Number(process.env.INTEROP_LIVE_SECS || 600)
const adSecs = Number(process.env.INTEROP_AD_SECS || 15)
const name = process.env.INTEROP_NAME || ('ipfs-agentd-ci-' + Date.now())
const gitRepo = process.env.INTEROP_REPO || process.cwd()
const outDir = process.env.INTEROP_OUT || '/tmp/interop'
const topic = process.env.INTEROP_TOPIC || 'gnostr'
mkdirSync(outDir, { recursive: true })
const log = (m) => process.stderr.write('publisher: ' + m + '\n')

const ctx = await createAgentNode({ repoPath: join(outDir, 'publisher-store'), log })

/* if we have no public listener, wait for a relay reservation so external peers
 * can actually dial us — readiness (and the notice below) must not race it */
if (!process.env.GNOSTR_LISTEN) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (ctx.node.getMultiaddrs().some((a) => a.toString().includes('/p2p-circuit/'))) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const circuitAddrs = ctx.node.getMultiaddrs().filter((a) => a.toString().includes('/p2p-circuit/'))
  log('relay addrs: ' + (circuitAddrs.length ? circuitAddrs.map((a) => a.toString()).join(' ') : 'NONE — publishing anyway'))
}

const res = await tools.gitPublishRepo(ctx, { repoPath: gitRepo, name, topic })
if (!res.published) log('initial ad not published: ' + res.note)

const peer = ctx.node.peerId.toString()
const allAddrs = ctx.node.getMultiaddrs().map((a) => a.toString())
writeFileSync(join(outDir, 'cid'), res.bundle)
writeFileSync(join(outDir, 'peer'), peer)
writeFileSync(join(outDir, 'name'), name)
writeFileSync(join(outDir, 'addrs'), allAddrs.join(','))
console.log(`::notice::interop name=${name} bundle=${res.bundle} peer=${peer} addrs=${allAddrs.join(',')}`)
log(`name=${name} bundle=${res.bundle} peer=${peer}`)

/* re-announce so fetchers that start later still catch the ad on the live topic */
const enc = new TextEncoder()
const adTimer = setInterval(() => {
  const ad = { type: 'git', name, at: Date.now(), bundle: res.bundle }
  const addrs = ctx.node.getMultiaddrs().map((a) => a.toString())
  if (addrs.length > 0) ad.addrs = addrs
  ctx.node.services.pubsub.publish(topic, enc.encode(JSON.stringify(ad))).catch(() => {})
}, adSecs * 1000)

setTimeout(async () => {
  clearInterval(adTimer)
  log('live window over — stopping')
  await ctx.helia.stop()
  process.exit(0)
}, liveSecs * 1000)
log('seeding for ' + liveSecs + 's (INTEROP_LIVE_SECS)')
