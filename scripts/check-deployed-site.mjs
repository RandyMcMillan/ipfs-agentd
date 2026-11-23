#!/usr/bin/env node
/* check-deployed-site.mjs — interop probe against the deployed gh-pages site
 * (https://randymcmillan.github.io/ipfs-agentd/ — built by deploy-gh-pages.yml
 * from the ipfs-gh-pages action; the site itself is a browser Helia peer,
 * which CI can't drive, so this probes everything around it).
 *
 * Hard checks (exit 1):
 *   1. the page responds over HTTPS and looks like the ipfs-agentd app
 *   2. repo-manifest.json parses: version, root CID, per-file CIDs
 * Soft checks (::warning::, never fail the run):
 *   3. swarm probe: from an independent agent node, UnixFS-stat the manifest
 *      root and cat the smallest file over bitswap. The site only ADVERTISES
 *      CIDs — whether they're retrievable from the public swarm depends on
 *      the deploy's optional Pinata/Filebase pinning secrets, so absence is
 *      a warning, not a failure.
 *
 * Env:
 *   SITE_URL      deployed site base URL (default: the gh-pages URL)
 *   DEPLOYED_REF  the ref this dispatch tests — the site always tracks
 *                 master HEAD, so a non-master ref only earns a warning
 *   SWARM_PROBE=0 skip leg 3 (no outbound swarm access)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { createAgentNode } from '../src/node.js'

const SITE_URL = (process.env.SITE_URL || 'https://randymcmillan.github.io/ipfs-agentd').replace(/\/$/, '')
const FETCH_TIMEOUT_MS = 20000
const PROBE_TIMEOUT_MS = 75000

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) console.log('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; console.log('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}
const warn = (m) => console.log('::warning::' + m)

async function get (url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res
  } finally { clearTimeout(t) }
}

/* ---- 1. the deployed page ---- */
let page = ''
try {
  page = await (await get(SITE_URL + '/')).text()
  check('deployed page responds', true, SITE_URL)
  check('page is the ipfs-agentd app', page.includes('ipfs-agentd') && page.includes('assets/index-'))
} catch (err) {
  check('deployed page responds', false, err.message)
  console.log(failed + ' hard check(s) failed — not probing further')
  process.exit(1)
}

/* ---- 2. repo manifest ---- */
let manifest = null
try {
  manifest = await (await get(SITE_URL + '/repo-manifest.json')).json()
  check('repo-manifest.json parses', true, 'version=' + manifest.version)
  check('manifest root is a CID', (() => { CID.parse(manifest.root); return true })(), manifest.root)
  check('manifest lists files', Array.isArray(manifest.files) && manifest.files.length > 0, (manifest.files?.length ?? 0) + ' files')
  let bad = 0
  for (const f of manifest.files ?? []) {
    if (typeof f.path !== 'string' || typeof f.size !== 'number') { bad++; continue }
    try { CID.parse(f.cid) } catch { bad++ }
  }
  check('every manifest entry is well-formed', bad === 0, bad + ' bad')
} catch (err) {
  check('repo-manifest.json parses', false, err.message)
}

/* the site always builds from master HEAD — a dispatch on another ref probes
 * a site that may not match the checked-out code */
if (process.env.DEPLOYED_REF && process.env.DEPLOYED_REF !== 'master') {
  warn('deployed site tracks master HEAD; dispatch ref ' + process.env.DEPLOYED_REF + ' may not match what the site was built from')
}

/* ---- 3. swarm probe (soft) ---- */
if (manifest && process.env.SWARM_PROBE !== '0') {
  const store = mkdtempSync(join(tmpdir(), 'check-deployed-'))
  const log = () => {}   /* node chatter stays out of the CI log */
  let ctx
  try {
    ctx = await createAgentNode({ repoPath: store, log })
    const probe = async (label, fn) => {
      const t = setTimeout(() => { /* raced below */ }, PROBE_TIMEOUT_MS)
      try {
        const result = await Promise.race([
          fn().then((v) => ({ ok: true, v })),
          new Promise((r) => setTimeout(() => r({ ok: false }), PROBE_TIMEOUT_MS))
        ])
        if (result.ok) console.log('PASS ' + label + ' → ' + result.v)
        else warn(label + ' timed out after ' + PROBE_TIMEOUT_MS / 1000 + 's — content not on the reachable swarm (optional pinning secrets not set?)')
      } finally { clearTimeout(t) }
    }
    await probe('swarm: stat manifest root ' + manifest.root, async () => {
      const st = await ctx.ufs.stat(manifest.root)
      return st.type + ' (' + (st.fileSize ?? st.dagSize ?? '?') + ' bytes)'
    })
    const smallest = (manifest.files ?? []).filter((f) => f.size > 0 && f.size <= 8192)
      .sort((a, b) => a.size - b.size)[0]
    if (smallest) {
      await probe('swarm: cat ' + smallest.path + ' (' + smallest.cid + ')', async () => {
        const chunks = []
        for await (const c of ctx.ufs.cat(smallest.cid)) chunks.push(c)
        const bytes = chunks.reduce((n, c) => n + c.length, 0)
        if (bytes !== smallest.size) throw new Error('size mismatch: ' + bytes + ' != ' + smallest.size)
        return bytes + ' bytes'
      })
    }
  } catch (err) {
    warn('swarm probe aborted: ' + (err?.message || err))
  } finally {
    if (ctx) await ctx.helia.stop().catch(() => {})
    rmSync(store, { recursive: true, force: true })
  }
}

if (failed) { console.log(failed + ' hard check(s) FAILED — exiting 1'); process.exit(1) }
console.log('deployed-site: all green')
