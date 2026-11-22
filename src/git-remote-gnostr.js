#!/usr/bin/env node
/* git-remote-gnostr — git remote helper: clone/fetch git repos announced on
 * the "gnostr" gossipsub topic, fetching objects over IPFS/bitswap.
 *
 *   git clone gnostr://<repo-name>     listen on the gnostr topic for git ads
 *                                      whose "name" matches; newest ad wins
 *                                      (bundle ads preferred over http-url ads)
 *   git clone gnostr://cid/<bundle-cid>  skip discovery; bitswap-fetch this CID
 *
 * Ad format (published by ipfs-agentd's git_publish_repo and helia-ipfs-relay):
 *   { type: "git", name, at, bundle?, url?, addrs? }
 *     bundle — CID of a `git bundle create` file (fetched over bitswap)
 *     url    — smart-http git endpoint (materialized via git clone --bare)
 *     addrs  — publisher listen multiaddrs; we dial them so the bundle pulls
 *              straight from the source (no manual bootstrap needed)
 *
 * Name ads are UNAUTHENTICATED (anyone on the topic can shadow a name; newest
 * `at` wins). Use gnostr://cid/<bundle-cid> in adversarial settings.
 *
 * ENV
 *   GNOSTR_TOPIC              pubsub topic carrying git ads (default "gnostr")
 *   GNOSTR_DISCOVERY_TIMEOUT  max seconds to listen in name mode (default 30)
 *   GNOSTR_BOOTSTRAP          comma-separated extra multiaddrs to dial at boot
 *                             (e.g. a known publisher's /ip4/…/tcp/…/p2p/<id>)
 *   IPFS_AGENTD_GIT_REPO      helper blockstore dir (default ~/.ipfs-agentd-git)
 *
 * Install: npm link (package.json bin) or copy next to git on PATH as
 * git-remote-gnostr with a node interpreter. Fetch-only; push is refused.
 */
import { multiaddr } from '@multiformats/multiaddr'
import { bootNode, stopNode, fail, log, materializeBundle, waitForPeers, serveRepo } from './git-remote-helper.js'

const TAG = 'git-remote-gnostr'
const url = process.argv[3]
if (!url || !url.startsWith('gnostr:')) fail(TAG, 'usage: git-remote-gnostr <name> <gnostr-url>')
const rest = url.slice('gnostr:'.length).replace(/\/+$/, '')
let wantName = null
let wantCid = null
if (rest.startsWith('//')) {
  const body = rest.slice(2)
  if (body.startsWith('cid/')) wantCid = body.slice(4) // git only routes scheme:// URLs to helpers, so the direct form lives under the host part
  else wantName = body || null
} else fail(TAG, 'unknown gnostr url form: ' + url + ' (want gnostr://<name> or gnostr://cid/<cid>)')

const TOPIC = process.env.GNOSTR_TOPIC || 'gnostr'
const DISCOVERY_MS = Number(process.env.GNOSTR_DISCOVERY_TIMEOUT || 30) * 1000

log(TAG, `${wantCid ? 'cid ' + wantCid : 'name "' + wantName + '"'} via topic "${TOPIC}"`)

const ctx = await bootNode(TAG)

/* ── discovery: name → newest matching git ad on the gnostr topic ───── */
async function discover (name) {
  const ads = new Map()
  let finish = null
  let grace = null
  const done = new Promise(r => { finish = r })
  ctx.node.services.pubsub.subscribe(TOPIC)
  ctx.node.services.pubsub.addEventListener('message', (evt) => {
    if (evt.detail.topic !== TOPIC) return
    try {
      const ad = JSON.parse(new TextDecoder().decode(evt.detail.data))
      if (ad && ad.type === 'git' && ad.name === name && (ad.bundle || ad.url)) {
        ads.set(ad.bundle || ad.url, ad)
        if (!grace) grace = setTimeout(finish, 1500) // first match + grace, then go
      }
    } catch {}
  })
  log(TAG, `listening for "${name}" ads (${DISCOVERY_MS / 1000}s max)…`)
  const cap = setTimeout(finish, DISCOVERY_MS)
  await done
  clearTimeout(cap); if (grace) clearTimeout(grace)
  const list = [...ads.values()]
  if (!list.length) { await stopNode(ctx); fail(TAG, `no git ads for "${name}" on topic "${TOPIC}"`) }
  list.sort((a, b) => (b.at || 0) - (a.at || 0))
  const best = list.find(a => a.bundle) || list[0]
  log(TAG, `${list.length} ad(s), using ${best.bundle ? 'bundle ' + best.bundle : 'url ' + best.url}`)
  return best
}

let repoDir
await waitForPeers(ctx, TAG).catch(async err => { await stopNode(ctx); fail(TAG, err.message) })
if (wantCid) {
  repoDir = await materializeBundle(ctx, TAG, wantCid)
} else {
  const ad = await discover(wantName)
  if (Array.isArray(ad.addrs) && ad.addrs.length) {
    log(TAG, 'dialing ' + ad.addrs.length + ' ad-carried addrs…')
    await Promise.allSettled(ad.addrs.map(a => ctx.node.dial(multiaddr(a))))
    await new Promise(r => setTimeout(r, 1500))
  }
  if (ad.bundle) {
    repoDir = await materializeBundle(ctx, TAG, ad.bundle)
  } else if (ad.url) {
    log(TAG, 'fetching ' + ad.url + ' (smart http)…')
    const { spawn } = await import('node:child_process')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), TAG + '-'))
    await new Promise((resolve, reject) => {
      const p = spawn('git', ['clone', '-q', '--bare', ad.url, join(dir, 'repo.git')], { stdio: ['ignore', 'ignore', 'inherit'] })
      p.on('error', reject)
      p.on('exit', code => code === 0 ? resolve() : reject(new Error('git clone --bare exited ' + code)))
    })
    repoDir = join(dir, 'repo.git')
  } else {
    await stopNode(ctx)
    fail(TAG, 'ad has neither bundle nor url')
  }
}
await stopNode(ctx) // git's child needs no libp2p; release the swarm before relaying

await serveRepo(TAG, repoDir) // resolves when git-upload-pack child exits
