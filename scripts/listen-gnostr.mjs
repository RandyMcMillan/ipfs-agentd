#!/usr/bin/env node
/* listen-gnostr — live listener on the real gnostr topic.
 *
 * Joins the public gossipsub swarm, subscribes to TOPIC, and prints every
 * {type:'git'} ad as it lands: name, timestamp, bundle CID, dial addrs.
 * Use it to externally confirm that a publisher (CI interop run, web service,
 * gnostr-publish) is actually announcing — or just to watch the network.
 *
 * Run:
 *   node scripts/listen-gnostr.mjs
 * Env:
 *   GNOSTR_TOPIC   topic to subscribe to            (default 'gnostr')
 *   LISTENER_REPO  local helia repo path            (default ~/.listen-gnostr)
 *   REBOOTSTRAP_SECS re-dial unconnected bootstrap peers every N s (default 60)
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'

const topic = process.env.GNOSTR_TOPIC || 'gnostr'
const repoPath = process.env.LISTENER_REPO || join(homedir(), '.listen-gnostr')
const log = (m) => process.stderr.write('listener: ' + m + '\n')

const ctx = await createAgentNode({ repoPath, log })
log('peer: ' + ctx.node.peerId.toString())

const t0 = Date.now()
for (;;) {
  const { messages } = await tools.ipfsPubsubPull(ctx, { topic, max: 20 })
  if (!messages.length) {
    await new Promise((r) => setTimeout(r, 2000))
    continue
  }
  for (const m of messages) {
    let ad
    try { ad = JSON.parse(Buffer.from(m.dataBase64, 'base64').toString()) } catch { continue }
    if (ad.type !== 'git') continue
    log(`AD after ${((Date.now() - t0) / 1000).toFixed(0)}s: name=${ad.name} at=${ad.at} bundle=${ad.bundle || '-'} addrs=${(ad.addrs || []).join(',') || '-'}`)
  }
}
