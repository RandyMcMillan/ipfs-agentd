/* git remote helpers e2e — real `git clone` through git-remote-gnostr and
 * git-remote-ipfs, against a live in-process publisher node.
 *
 *   1. create a small source git repo with a commit
 *   2. publisher node (GNOSTR_LISTEN on 127.0.0.1, ephemeral port) runs
 *      git_publish_repo and keeps re-announcing the ad (like gnostr-publish)
 *   3. `git clone gnostr://<name>` with GNOSTR_BOOTSTRAP → the helper hears
 *      the ad on the topic, dials ad-carried addrs, bitswap-fetches, serves
 *   4. `git clone ipfs://<bundle-cid>` with GNOSTR_BOOTSTRAP → content-
 *      addressed fetch, no topic
 *   5. both clones verified: file contents, git fsck, branch tips
 * Run: node test/git-remote-e2e.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const step = (s) => process.stderr.write('git-remote-e2e: ' + s + '\n')
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const work = mkdtempSync(join(tmpdir(), 'gitremote-'))
const srcRepo = join(work, 'src')
const helperBin = join(work, 'bin')
mkdirSync(helperBin)

/* PATH-visible wrappers — git spawns `git-remote-<scheme>` from PATH; the
 * helpers are ESM, so the wrapper execs them through the interpreter */
const NODE = process.execPath
for (const scheme of ['gnostr', 'ipfs']) {
  const target = join(root, 'src', 'git-remote-' + scheme + '.js')
  writeFileSync(join(helperBin, 'git-remote-' + scheme),
    '#!/bin/sh\nexec "' + NODE + '" "' + target + '" "$@"\n')
  execFileSync('chmod', ['+x', join(helperBin, 'git-remote-' + scheme)])
}
const envWith = (extra) => ({ ...process.env, PATH: helperBin + ':' + process.env.PATH, IPFS_AGENTD_GIT_REPO: join(work, 'git-store'), ...extra })

/* 1. source repo with two commits on a topic branch and master */
mkdirSync(srcRepo)
const git = (args) => execFileSync('git', ['-C', srcRepo, ...args], { stdio: ['ignore', 'ignore', 'ignore'] })
execFileSync('git', ['init', '-q', '-b', 'master', srcRepo])
execFileSync('git', ['-C', srcRepo, 'config', 'user.email', 'test@example.com'])
execFileSync('git', ['-C', srcRepo, 'config', 'user.name', 'test'])
writeFileSync(join(srcRepo, 'hello.txt'), 'hello from ipfs-agentd\n')
execFileSync('git', ['-C', srcRepo, 'add', '.'])
execFileSync('git', ['-C', srcRepo, 'commit', '-q', '-m', 'initial'])
writeFileSync(join(srcRepo, 'second.txt'), 'second commit\n')
execFileSync('git', ['-C', srcRepo, 'add', '.'])
execFileSync('git', ['-C', srcRepo, 'commit', '-q', '-m', 'second'])
const srcHead = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD']).toString().trim()

/* 2. publisher node on a loopback listener */
process.env.GNOSTR_LISTEN = '/ip4/127.0.0.1/tcp/0'
const ctx = await createAgentNode({ repoPath: join(work, 'pub-store'), log: () => {} })
const pubAddr = ctx.node.getMultiaddrs().map(a => a.toString()).filter(a => !a.includes('/p2p-circuit'))
const name = 'gitremote-' + process.pid
const pub = await tools.gitPublishRepo(ctx, { repoPath: srcRepo, name })
check('git_publish_repo (publisher)', Boolean(pub?.bundle), JSON.stringify(pub).slice(0, 90))

/* re-announce loop — mirrors gnostr-publish: the ad is republished on an
 * interval so helpers that dial in late still resolve the name */
let announcing = true
const announce = async () => {
  while (announcing) {
    const ad = { type: 'git', name, at: Date.now(), bundle: pub.bundle, addrs: pubAddr }
    try { await ctx.node.services.pubsub.publish('gnostr', new TextEncoder().encode(JSON.stringify(ad))) } catch {}
    await sleep(4000)
  }
}
announce()

/* helper runner: git clone <url>, capture result */
const clone = (url, dest, timeoutMs = 180000) => new Promise((resolve) => {
  const t0 = Date.now()
  const p = spawn('git', ['clone', url, dest], { env: envWith({ GNOSTR_BOOTSTRAP: pubAddr.join(',') }), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', d => { out += d })
  p.stderr.on('data', d => { out += d })
  const cap = setTimeout(() => { p.kill('SIGKILL'); resolve({ ok: false, out: out + '\n[test: killed after ' + timeoutMs / 1000 + 's]' }) }, timeoutMs)
  p.on('close', code => { clearTimeout(cap); resolve({ ok: code === 0, out, ms: Date.now() - t0 }) })
})

try {
  /* 3. gnostr://<name> */
  const destName = join(work, 'clone-name')
  const r1 = await clone('gnostr://' + name, destName)
  check('git clone gnostr://<name>', r1.ok, r1.ok ? r1.ms + 'ms' : r1.out.split('\n').filter(l => l.includes('git-remote-gnostr')).slice(-2).join(' | ').slice(0, 110))
  if (r1.ok) {
    const hello = execFileSync('cat', [join(destName, 'hello.txt')]).toString()
    const head = execFileSync('git', ['-C', destName, 'rev-parse', 'HEAD']).toString().trim()
    check('gnostr clone contents + HEAD', hello.includes('hello from ipfs-agentd') && head === srcHead, 'HEAD ' + head.slice(0, 8))
    execFileSync('git', ['-C', destName, 'fsck', '--strict'], { stdio: ['ignore', 'ignore', 'ignore'] })
    check('gnostr clone fsck clean', true)
  }

  /* 4. ipfs://<bundle-cid> */
  const destCid = join(work, 'clone-cid')
  const r2 = await clone('ipfs://' + pub.bundle, destCid)
  check('git clone ipfs://<cid>', r2.ok, r2.ok ? r2.ms + 'ms' : r2.out.split('\n').filter(l => l.includes('git-remote-ipfs')).slice(-2).join(' | ').slice(0, 110))
  if (r2.ok) {
    const second = execFileSync('cat', [join(destCid, 'second.txt')]).toString()
    const head = execFileSync('git', ['-C', destCid, 'rev-parse', 'HEAD']).toString().trim()
    check('ipfs clone contents + HEAD', second.includes('second commit') && head === srcHead, 'HEAD ' + head.slice(0, 8))
  }
} finally {
  announcing = false
  await ctx.helia.stop()
  rmSync(work, { recursive: true, force: true })
}

if (failed) { step(failed + ' FAILED — exiting 1'); process.exit(1) }
step('all green')
