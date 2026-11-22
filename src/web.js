/* ipfs-agentd web — GitHub-like repo browser + agent/human service point.
 *
 * Serves every repo under --root over HTTP: file tree, blob views with line
 * numbers, rendered README, commit list, raw downloads, on-the-fly git
 * bundles, and clone URLs in gnostr:// / ipfs:// form. With --publish, each
 * repo is also announced on the gnostr topic (git_publish_repo) and its
 * bundle CID + publisher addrs are shown on the repo page — the same page
 * humans browse is what agents need to dial/clone. Zero third-party
 * runtime deps: node:http + the git CLI + this repo's own node factory.
 *
 * Repo sources under the root (one subdir per repo — mount them per
 * instance, e.g. docker -v /srv/myrepo:/data/repos/myrepo):
 *   name.git/     bare repo
 *   name/         working clone (has .git) or bare repo
 *   name.bundle   git bundle file (materialized to a cached bare repo)
 *
 * Usage (also via `ipfs-agentd serve`):
 *   node src/web.js --root /data/repos [--port 8080] [--host 0.0.0.0]
 *                   [--name <instance-id>] [--publish] [--topic gnostr]
 *                   [--logging info]
 *
 * Env: IPFS_AGENTD_REPO, GNOSTR_BOOTSTRAP, GNOSTR_LISTEN (publish mode)
 */
import http from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, sep, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentNode, DEFAULT_REPO } from './node.js'
import { createLogger } from './logger.js'
import * as tools from './tools.js'

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ── minimal markdown (escape-first: no raw HTML injection) ─────────── */
export function md (src) {
  const lines = String(src).split('\n')
  const out = []
  let inCode = false
  let list = null
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
  const closeList = () => { if (list) { out.push(list === 'ul' ? '</ul>' : '</ol>'); list = null } }
  for (const raw of lines) {
    if (raw.trimStart().startsWith('```')) {
      if (inCode) { out.push('</code></pre>'); inCode = false } else { closeList(); out.push('<pre class="code"><code>'); inCode = true }
      continue
    }
    if (inCode) { out.push(esc(raw) + '\n'); continue }
    const line = raw
    let m
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue }
    if (/^\s*[-*]\s+/.test(line)) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' } out.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue }
    if (/^\s*\d+\.\s+/.test(line)) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' } out.push('<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue }
    if (line.trim() === '') { closeList(); continue }
    closeList(); out.push('<p>' + inline(line) + '</p>')
  }
  if (inCode) out.push('</code></pre>')
  closeList()
  return out.join('\n')
}

/* ── git plumbing helpers ───────────────────────────────────────────── */
const git = (args, cwd) => new Promise((resolvePromise, reject) => {
  execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) reject(new Error('git ' + args[0] + ' failed: ' + (stderr || err.message).trim().slice(0, 120)))
    else resolvePromise(stdout)
  })
})

/* discover repos under root; materialize bundles into a cache dir */
export function scanRepos (root, cacheDir, log = () => {}) {
  const repos = new Map()
  if (!existsSync(root)) return repos
  for (const entry of readdirSync(root)) {
    const p = join(root, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      const name = entry.replace(/\.git$/, '')
      if (existsSync(join(p, 'HEAD')) || existsSync(join(p, '.git'))) repos.set(name, p)
    } else if (entry.endsWith('.bundle')) {
      const name = entry.slice(0, -'.bundle'.length)
      const dest = join(cacheDir, name + '.git')
      if (!existsSync(dest)) {
        try {
          mkdirSync(cacheDir, { recursive: true })
          execFileSyncSafe('git', ['clone', '-q', '--bare', p, dest])
          log('materialized bundle ' + entry + ' -> ' + dest)
        } catch (err) { log('skip bundle ' + entry + ': ' + err.message); continue }
      }
      repos.set(name, dest)
    }
  }
  return repos
}
import { execFileSync } from 'node:child_process'
function execFileSyncSafe (cmd, args) { execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }) }

/* resolve a repo-relative git path, refusing traversal outside the repo */
function safeGitPath (repoDir, p) {
  const cleaned = normalize(p).replace(/^(\.\.([/\\]|$))+/, '').replace(/^[/\\]+/, '')
  const abs = resolve(repoDir, cleaned)
  if (abs !== repoDir && !abs.startsWith(repoDir + sep)) return null
  return cleaned || '.'
}

async function resolveRef (repoDir, ref) {
  try { return (await git(['rev-parse', '--verify', ref + '^{commit}'], repoDir)).trim() } catch { return null }
}

async function repoInfo (dir) {
  let head = null; let branch = null; let subject = null; let ago = null
  try { head = (await git(['rev-parse', 'HEAD'], dir)).trim() } catch { return null }
  try { branch = (await git(['symbolic-ref', '--short', 'HEAD'], dir)).trim() } catch { branch = 'HEAD' }
  try {
    const l = (await git(['log', '-1', '--format=%ct%x09%s'], dir)).trim().split('\t')
    ago = timeAgo(Number(l[0]) * 1000); subject = l.slice(1).join('\t')
  } catch {}
  let branches = []
  try { branches = (await git(['branch', '-a', '--format=%(refname:short)'], dir)).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('origin/HEAD')) } catch {}
  return { head: head.slice(0, 12), headFull: head, branch, subject, ago, branches }
}

function timeAgo (t) {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return s + ' seconds ago'
  if (s < 3600) return Math.floor(s / 60) + ' minutes ago'
  if (s < 86400) return Math.floor(s / 3600) + ' hours ago'
  return Math.floor(s / 86400) + ' days ago'
}

/* ── GitHub-like chrome ─────────────────────────────────────────────── */
const STYLE = `
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--dim:#8b949e;--link:#58a6ff;--accent:#238636;--code:#161b22}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header.top{background:var(--panel);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:12px}
header.top .mark{color:var(--fg);font-weight:600;font-size:16px}
header.top .inst{color:var(--dim);font-size:12px;margin-left:auto}
main{max-width:980px;margin:0 auto;padding:20px}
.repohead{border-bottom:1px solid var(--border);padding:16px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.repohead h1{font-size:20px;margin:0;font-weight:500}
.badge{border:1px solid var(--border);border-radius:12px;padding:1px 10px;font-size:12px;color:var(--dim)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:6px;margin:16px 0}
.panel .bar{display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.panel .bar .commit{color:var(--dim);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table.files{width:100%;border-collapse:collapse}
table.files td{padding:8px 14px;border-top:1px solid var(--border);font-size:14px}
table.files tr:first-child td{border-top:0}
table.files .meta{color:var(--dim);text-align:right;font-size:12px;white-space:nowrap}
.icon{width:16px;display:inline-block;text-align:center;margin-right:8px}
.pathcrumb{color:var(--dim);font-size:12px;margin:10px 0}
.pathcrumb a{color:var(--link)}
.blob{padding:14px;overflow:auto}
.blob pre{margin:0;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;counter-reset:l}
.blob pre .ln{display:block}
.blob pre .ln::before{counter-increment:l;content:counter(l);display:inline-block;width:3em;margin-right:1em;color:var(--dim);text-align:right;user-select:none}
pre.code,code{background:var(--code);border-radius:6px}code{padding:2px 6px;font:12px ui-monospace,Menlo,monospace}
pre.code{padding:12px;overflow:auto}
.commitrow{padding:10px 14px;border-top:1px solid var(--border);font-size:13px}
.commitrow .msg{color:var(--fg)}.commitrow .when{color:var(--dim);font-size:12px}
.clonebox{display:flex;gap:8px;align-items:center;margin-left:auto}
.clonebox input{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);padding:5px 10px;font:12px ui-monospace,Menlo,monospace;width:280px}
button.copy{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
.readme{padding:16px 24px}.readme h1,.readme h2{border-bottom:1px solid var(--border);padding-bottom:6px}
.hint{color:var(--dim);font-size:12px}
footer{border-top:1px solid var(--border);margin-top:40px;padding:16px 20px;color:var(--dim);font-size:12px;text-align:center}
.flash{background:#2ea04322;border:1px solid #2ea04366;color:#7ee787;border-radius:6px;padding:8px 14px;margin:10px 0;font-size:13px}
.flash b{color:#7ee787}
.repo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin:16px 0}
.repo-card{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:14px}
.repo-card h3{margin:0 0 6px;font-size:15px;font-weight:600}
.repo-card .meta{color:var(--dim);font-size:12px}
.section-title{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin:22px 0 8px}`

function page (title, body, inst) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<header class="top"><span class="mark">⬡ ipfs-agentd</span><span class="hint">decentralized git for agents &amp; humans</span><span class="inst">${esc(inst)}</span></header>
<main>${body}</main>
<footer>served by ipfs-agentd — no GitHub required · clone over <code>gnostr://</code> or <code>ipfs://</code></footer>
</body></html>`
}

function crumbs (repo, p) {
  const parts = p.split('/').filter(Boolean)
  let out = `<div class="pathcrumb"><a href="/${esc(repo)}">${esc(repo)}</a>`
  let acc = ''
  for (const part of parts) { acc += '/' + part; out += ` / <a href="/${esc(repo)}/tree/HEAD${esc(acc)}">${esc(part)}</a>` }
  return out + '</div>'
}

/* ── handlers ───────────────────────────────────────────────────────── */
async function homePage (repos, pub, inst, root) {
  const cards = []
  for (const [name, dir] of [...repos.entries()].sort()) {
    const info = await repoInfo(dir)
    if (!info) continue
    cards.push(`<div class="repo-card"><h3><a href="/${esc(name)}">⬡ ${esc(name)}</a></h3>
      <div class="meta">${info.branches.length} branch(es) · HEAD <code>${info.head}</code>${info.ago ? ' · ' + esc(info.ago) : ''}</div>
      <div class="meta" style="margin-top:6px">${esc(info.subject || '')}</div></div>`)
  }
  const pubBlock = pub
    ? `<div class="flash">publishing to topic <b>${esc(pub.topic)}</b> · peer <code>${esc(pub.peer)}</code> · re-announce every ${pub.adSecs}s</div>`
    : `<div class="hint">publish mode off — start with <code>--publish</code> to announce these repos on the gnostr topic for agents</div>`
  const body = `
  <div class="repohead"><h1>⬡ ${esc(inst)}</h1><span class="badge">${repos.size} repo(s)</span></div>
  ${pubBlock}
  ${cards.length ? '<div class="repo-grid">' + cards.join('\n') + '</div>' : '<p class="hint">no repos found — mount one at <code>' + esc(root) + '/&lt;name&gt;</code> (bare repo, working clone, or <code>.bundle</code> file)</p>'}
  <div class="section-title">for agents</div>
  <div class="panel"><div class="bar" style="display:block">
    <div class="hint">MCP stdio server (per-agent daemon):</div>
    <pre class="code">{"mcpServers":{"ipfs":{"command":"node","args":["/app/src/mcp-server.js"]}}}</pre>
    <div class="hint">or chat with humans on the topic: <code>ipfs-agentd chat --topic ${pub ? esc(pub.topic) : 'gnostr'}</code></div>
  </div></div>`
  return page(inst, body, inst + ' · ' + root)
}

async function repoPage (name, dir, pubs, inst) {
  const info = await repoInfo(dir)
  if (!info) return null
  const tree = (await git(['ls-tree', 'HEAD'], dir)).split('\n').filter(Boolean).map(l => {
    const [meta, file] = l.split('\t')
    const [mode, type, sha] = meta.split(' ')
    return { mode, type, sha, file }
  }).sort((a, b) => (a.type === b.type ? a.file.localeCompare(b.file) : a.type === 'tree' ? -1 : 1))
  const rows = tree.map(e =>
    `<tr><td><span class="icon">${e.type === 'tree' ? '📁' : '📄'}</span><a href="/${esc(name)}/${e.type === 'tree' ? 'tree' : 'blob'}/HEAD/${esc(e.file)}">${esc(e.file)}</a></td><td class="meta"><code>${e.sha.slice(0, 10)}</code></td></tr>`).join('')
  const readme = tree.find(e => /^readme(\.md)?$/i.test(e.file))
  let readmeHtml = ''
  if (readme) {
    try {
      const raw = await git(['show', 'HEAD:' + readme.file], dir)
      readmeHtml = `<div class="panel"><div class="bar"><strong>${esc(readme.file)}</strong></div><div class="readme">${md(raw)}</div></div>`
    } catch {}
  }
  const pub = pubs.get(name)
  const cloneUrls = [`gnostr://${name}`, ...(pub ? [`ipfs://${pub.bundle}`] : [])]
  const body = `
  <div class="repohead"><h1>⬡ <a href="/">⬡</a> / ${esc(name)}</h1>
    <span class="badge">${esc(info.branch)}</span><span class="badge">${info.branches.length} branch(es)</span>
    <span class="clonebox"><input readonly value="${esc(cloneUrls[0])}" onclick="this.select()"><button class="copy" onclick="navigator.clipboard.writeText('${esc(cloneUrls[0])}')">Copy</button></span>
  </div>
  ${pub ? `<div class="flash">announced on <b>${esc(pub.topic)}</b> · bundle <code>${esc(pub.bundle)}</code>${pub.addrs.length ? ' · <code>' + esc(pub.addrs[0]) + '</code>' : ''}</div>` : ''}
  <div class="hint" style="margin:8px 0">clone: <code>git clone ${esc(cloneUrls.join('</code> · <code>'))}</code> · <a href="/${esc(name)}/bundle">download .bundle</a></div>
  <div class="panel">
    <div class="bar"><span class="badge">${esc(info.branch)}</span><span class="commit"><code>${info.head}</code> ${esc(info.subject || '')}</span><span class="hint" style="margin-left:auto">${esc(info.ago || '')}</span></div>
    <table class="files">${rows}</table>
  </div>
  ${readmeHtml}
  <div class="section-title"><a href="/${esc(name)}/commits/HEAD">commits →</a></div>`
  return page(name, body, inst)
}

async function treePage (name, dir, ref, p) {
  const gitPath = safeGitPath(dir, p)
  if (gitPath === null) return { status: 400, text: 'bad path' }
  const commit = await resolveRef(dir, ref)
  if (!commit) return { status: 404, text: 'ref not found: ' + ref }
  let out
  try { out = await git(['ls-tree', commit + ':' + gitPath], dir) } catch { return { status: 404, text: 'not found: ' + p } }
  const entries = out.split('\n').filter(Boolean).map(l => {
    const [meta, file] = l.split('\t'); const [mode, type, sha] = meta.split(' ')
    return { type, sha, file }
  }).sort((a, b) => (a.type === b.type ? a.file.localeCompare(b.file) : a.type === 'tree' ? -1 : 1))
  const sub = gitPath === '.' ? '' : gitPath + '/'
  const rows = entries.map(e =>
    `<tr><td><span class="icon">${e.type === 'tree' ? '📁' : '📄'}</span><a href="/${esc(name)}/${e.type === 'tree' ? 'tree' : 'blob'}/${esc(ref)}/${esc(sub + e.file)}">${esc(e.file)}</a></td><td class="meta"><code>${e.sha.slice(0, 10)}</code></td></tr>`).join('')
  const body = `${crumbs(name, sub)}<div class="panel"><table class="files">${rows}</table></div>`
  return { html: page(name + '/' + p, body, name) }
}

async function blobPage (name, dir, ref, p) {
  const gitPath = safeGitPath(dir, p)
  if (gitPath === null) return { status: 400, text: 'bad path' }
  const commit = await resolveRef(dir, ref)
  if (!commit) return { status: 404, text: 'ref not found: ' + ref }
  let buf
  try { buf = await git(['show', commit + ':' + gitPath], dir).catch(() => null); if (buf === null) return { status: 404, text: 'not found: ' + p } } catch { return { status: 404, text: 'not found: ' + p } }
  const isText = !buf.includes('')
  const lines = isText ? buf.split('\n').map((l, i) => `<span class="ln">${esc(l)}</span>`).join('') : null
  const body = `${crumbs(name, p)}
  <div class="panel"><div class="bar"><strong>${esc(p.split('/').pop())}</strong>
    <span style="margin-left:auto"><a href="/${esc(name)}/raw/${esc(ref)}/${esc(p)}">raw</a></span></div>
  <div class="blob">${isText ? `<pre>${lines}</pre>` : `<pre class="code">binary file · ${buf.length} bytes · <a href="/${esc(name)}/raw/${esc(ref)}/${esc(p)}">download raw</a></pre>`}</div></div>`
  return { html: page(name + '/' + p, body, name) }
}

async function rawHandler (name, dir, ref, p, res) {
  const gitPath = safeGitPath(dir, p)
  if (gitPath === null) { res.writeHead(400); return res.end('bad path') }
  const commit = await resolveRef(dir, ref)
  if (!commit) { res.writeHead(404); return res.end('ref not found') }
  await new Promise((resolvePromise, reject) => {
    const p2 = execFile('git', ['show', commit + ':' + gitPath], { cwd: dir, timeout: 30000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) { res.writeHead(404); res.end('not found'); resolvePromise() } else { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(stdout); resolvePromise() }
    })
    p2.on('error', reject)
  })
}

async function commitsPage (name, dir, ref) {
  const commit = await resolveRef(dir, ref)
  if (!commit) return { status: 404, text: 'ref not found: ' + ref }
  const out = await git(['log', '--format=%H%x09%ct%x09%an%x09%s', '-20', commit], dir)
  const rows = out.split('\n').filter(Boolean).map(l => {
    const [h, ct, an, ...s] = l.split('\t')
    return `<div class="commitrow"><div class="msg">${esc(s.join('\t'))}</div><div class="when"><code>${h.slice(0, 10)}</code> ${esc(an)} committed ${esc(timeAgo(Number(ct) * 1000))}</div></div>`
  }).join('')
  return { html: page(name + ' commits', `<div class="repohead"><h1>⬡ ${esc(name)} — commits</h1></div><div class="panel">${rows || '<div class="commitrow hint">no commits</div>'}</div>`, name) }
}

/* generate + serve a fresh git bundle of the whole repo */
async function bundleHandler (name, dir, res, log) {
  const tmp = join(tmpdir(), 'ipfs-agentd-web-' + name + '-' + Date.now() + '.bundle')
  try {
    await git(['-C', dir, 'bundle', 'create', tmp, '--all'])
    const data = (await import('node:fs')).readFileSync(tmp)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="' + name + '.bundle"' })
    res.end(data)
  } catch (err) { res.writeHead(500); res.end('bundle failed: ' + err.message) }
}

/* ── main ───────────────────────────────────────────────────────────── */
export async function serveMain (argv = []) {
  const opt = (flag, dflt) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : dflt }
  const root = resolve(opt('--root', '/data/repos'))
  const port = Number(opt('--port', process.env.PORT || 8080))
  const host = opt('--host', process.env.HOST || '0.0.0.0')
  const inst = opt('--name', process.env.SERVE_NAME || 'ipfs-agentd')
  const publish = argv.includes('--publish') || process.env.PUBLISH === '1'
  const topic = opt('--topic', process.env.GNOSTR_TOPIC || 'gnostr')
  const logging = opt('--logging', 'info')
  const log = createLogger(logging)
  const cacheDir = join(root, '.ipfs-agentd-cache')

  mkdirSync(root, { recursive: true })
  let repos = scanRepos(root, cacheDir, (m) => log(m, 'info'))
  log(`serving ${repos.size} repo(s) from ${root}`)

  /* publish mode: node + announce loop (git_publish_repo per repo, re-announce) */
  let ctx = null
  const pubs = new Map()
  const adSecs = Number(process.env.AD_SECS || 15)
  if (publish) {
    ctx = await createAgentNode({ repoPath: process.env.IPFS_AGENTD_REPO || DEFAULT_REPO, log })
    const peer = ctx.node.peerId.toString()
    const announceAll = async () => {
      for (const [name, dir] of repos) {
        try {
          const r = await tools.gitPublishRepo(ctx, { repoPath: dir, name, topic })
          if (r?.bundle) pubs.set(name, { bundle: r.bundle, topic, addrs: ctx.node.getMultiaddrs().map(a => a.toString()).filter(a => !a.includes('/p2p-circuit')), peer })
        } catch (err) { log('publish ' + name + ' failed: ' + err.message, 'warn') }
      }
    }
    await announceAll()
    setInterval(() => { announceAll().catch(() => {}) }, adSecs * 1000).unref()
    log('publish mode on: announcing ' + repos.size + ' repo(s) on topic "' + topic + '" as peer ' + peer)
  }

  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0])
    const seg = url.split('/').filter(Boolean)
    const send = (status, body, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'content-type': type }); res.end(body) }
    try {
      if (url === '/' || url === '') return send(200, await homePage(repos, publish ? { topic, peer: ctx.node.peerId.toString(), adSecs } : null, inst, root), 'text/html; charset=utf-8')
      const name = seg[0]
      const dir = repos.get(name)
      if (!dir) return send(404, 'no such repo: ' + name)
      if (seg.length === 1) return send(200, await repoPage(name, dir, pubs, inst), 'text/html; charset=utf-8')
      const [, kind, ref, ...rest] = seg
      if (kind === 'tree') { const r = await treePage(name, dir, ref, rest.join('/')); return r.html ? send(200, r.html, 'text/html; charset=utf-8') : send(r.status, r.text) }
      if (kind === 'blob') { const r = await blobPage(name, dir, ref, rest.join('/')); return r.html ? send(200, r.html, 'text/html; charset=utf-8') : send(r.status, r.text) }
      if (kind === 'raw') return rawHandler(name, dir, ref, rest.join('/'), res)
      if (kind === 'commits') { const r = await commitsPage(name, dir, ref); return r.html ? send(200, r.html, 'text/html; charset=utf-8') : send(r.status, r.text) }
      if (kind === 'bundle') return bundleHandler(name, dir, res, log)
      return send(404, 'unknown route')
    } catch (err) {
      log('http ' + url + ' → ' + err.message, 'error')
      send(500, 'internal error: ' + err.message)
    }
  })

  await new Promise(r => server.listen(port, host, r))
  log(`web: http://${host}:${port}/ (${inst}) — repos under ${root}`)
  await new Promise((resolve) => {
    process.on('SIGINT', resolve)
    process.on('SIGTERM', resolve)
    server.on('close', resolve)
  })
  server.close()
  if (ctx) await ctx.helia.stop()
}
