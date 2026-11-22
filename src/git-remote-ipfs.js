#!/usr/bin/env node
/* git-remote-ipfs — git remote helper: clone/fetch a git bundle stored on
 * IPFS, content-addressed. No topic, no name discovery — the CID is the name.
 *
 *   git clone ipfs://<bundle-cid>
 *   git clone ipfs://cid/<bundle-cid>
 *
 * The CID must be a `git bundle create` file (raw or UnixFS single file) —
 * the same CIDs produced by ipfs-agentd's git_publish_repo. For named,
 * discoverable repos use git-remote-gnostr (gnostr://<name>) instead.
 *
 * Discovery is entirely content-based: bitswap want-list broadcast to
 * connected peers. Seeders must be reachable or pre-known:
 *
 * ENV
 *   GNOSTR_BOOTSTRAP      comma-separated multiaddrs to dial at boot (a
 *                         seeder's /ip4/…/tcp/…/p2p/<id>) — usually required,
 *                         since DHT provider records are only found when the
 *                         seeder announced them on a full DHT node
 *   IPFS_AGENTD_GIT_REPO  helper blockstore dir (default ~/.ipfs-agentd-git)
 *
 * Install: npm link (package.json bin) or copy next to git on PATH as
 * git-remote-ipfs with a node interpreter. Fetch-only; push is refused.
 */
import { bootNode, stopNode, fail, log, materializeBundle, waitForPeers, serveRepo } from './git-remote-helper.js'

const TAG = 'git-remote-ipfs'
const url = process.argv[3]
if (!url || !url.startsWith('ipfs:')) fail(TAG, 'usage: git-remote-ipfs <name> <ipfs-url>')
const rest = url.slice('ipfs:'.length).replace(/\/+$/, '')
let wantCid = null
if (rest.startsWith('//')) {
  const body = rest.slice(2)
  wantCid = body.startsWith('cid/') ? body.slice(4) : body // ipfs://cid/<cid> or ipfs://<cid>
} else {
  fail(TAG, 'unknown ipfs url form: ' + url + ' (want ipfs://<cid> or ipfs://cid/<cid>)')
}
if (!wantCid) fail(TAG, 'empty CID in ' + url)

log(TAG, 'cid ' + wantCid)

const ctx = await bootNode(TAG)
await waitForPeers(ctx, TAG).catch(async err => { await stopNode(ctx); fail(TAG, err.message) })
const repoDir = await materializeBundle(ctx, TAG, wantCid)
await stopNode(ctx) // git's child needs no libp2p; release the swarm before relaying

await serveRepo(TAG, repoDir) // resolves when git-upload-pack child exits
