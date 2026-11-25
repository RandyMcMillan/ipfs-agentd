/* web e2e — ipfs-agentd serve: GitHub-like repo browser over HTTP.
 *
 *   1. fixture repo (README.md + src/nested.txt, two commits) under --root
 *   2. start serveMain on an ephemeral port (publish OFF — no swarm needed)
 *   3. GET /, /<repo>, /<repo>/blob/HEAD/README.md, /<repo>/raw/…,
 *      /<repo>/tree/HEAD/src, /<repo>/commits/HEAD, /<repo>/bundle
 *   4. assert GitHub-like chrome, rendered README, traversal refusal
 * Run: node test/web-e2e.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const step = (s) => process.stderr.write('web-e2e: ' + s + '\n')
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const work = mkdtempSync(join(tmpdir(), 'web-e2e-'))
const root = join(work, 'repos')
const repo = join(root, 'demo')
mkdirSync(join(repo, 'src'), { recursive: true })
execFileSync('git', ['init', '-q', '-b', 'master', repo])
execFileSync('git', ['-C', repo, 'config', 'user.email', 't@e.st'])
execFileSync('git', ['-C', repo, 'config', 'user.name', 'test'])
writeFileSync(join(repo, 'README.md'), '# demo\n\n**bold** and `code`\n\n- one\n- two\n')
writeFileSync(join(repo, 'src', 'nested.txt'), 'nested hello\n')
execFileSync('git', ['-C', repo, 'add', '.'])
execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial commit'])
writeFileSync(join(repo, 'second.txt'), 'second\n')
execFileSync('git', ['-C', repo, 'add', '.'])
execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'second commit'])
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()

/* bundle fixture: repo served from a .bundle file */
execFileSync('git', ['-C', repo, 'bundle', 'create', join(root, 'packed.bundle'), '--all'])

const port = 18000 + Math.floor(Math.random() * 20000)
const srv = spawn(process.execPath, ['src/bin.js', 'serve', '--root', root, '--port', String(port), '--host', '127.0.0.1', '--name', 'webtest', '--logging', 'error'], { stdio: ['ignore', 'ignore', 'pipe'] })
let srvErr = ''
srv.stderr.on('data', d => { srvErr += d })
const get = async (path) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, body: await r.text(), type: r.headers.get('content-type') || '' } }

try {
  /* wait for listen; surface the child's stderr on failure — a server that
   * dies before binding must never be a silent error */
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); up = r.status === 200 } catch { await new Promise(r => setTimeout(r, 250)) }
    if (!up && srv.exitCode !== null) break
  }
  check('server up', up, up ? '' : 'child exited early — stderr: ' + srvErr.trim().slice(0, 200))
  if (!up) throw new Error('server never listened')

  const home = await get('/')
  check('home lists both repos', home.status === 200 && home.body.includes('demo') && home.body.includes('packed'),
    home.body.match(/repo-card/g)?.length + ' repo card(s)')
  check('home shows agent instructions', home.body.includes('mcpServers') && home.body.includes('ipfs-agentd chat'))

  const rp = await get('/demo')
  check('repo page chrome', rp.status === 200 && rp.body.includes('demo') && rp.body.includes('git clone') && rp.body.includes('gnostr://demo'))
  check('repo page file table', rp.body.includes('README.md') && rp.body.includes('src'))
  check('README rendered as markdown', rp.body.includes('<h1>demo</h1>') && rp.body.includes('<strong>bold</strong>') && rp.body.includes('<code>code</code>') && rp.body.includes('<li>one</li>'))

  const blob = await get('/demo/blob/HEAD/README.md')
  /* a text blob must render line-numbered content — a bug once made EVERY
   * blob "binary file" (String.includes('') is always true) and this check
   * still passed because 'blob'/'raw' appear in the chrome */
  check('blob page with line numbers', blob.status === 200 && blob.body.includes('blob') && blob.body.includes('raw'))
  check('text blob renders content (not "binary file")',
    blob.body.includes('<span class="ln"># demo</span>') && !blob.body.includes('binary file'),
    blob.body.includes('binary file') ? 'rendered as binary — isText bug?' : 'line-numbered text rendered')

  const raw = await get('/demo/raw/HEAD/src/nested.txt')
  check('raw file bytes', raw.status === 200 && raw.body === 'nested hello\n', JSON.stringify(raw.body.slice(0, 20)))

  const tree = await get('/demo/tree/HEAD/src')
  check('subdirectory listing', tree.status === 200 && tree.body.includes('nested.txt'))

  const commits = await get('/demo/commits/HEAD')
  check('commit list', commits.status === 200 && commits.body.includes('second commit') && commits.body.includes('initial commit') && commits.body.includes(head.slice(0, 10)))

  const bundle = await get('/demo/bundle')
  check('bundle download', bundle.status === 200 && bundle.body.startsWith('# v2 git bundle'), bundle.body.slice(0, 20))

  const packed = await get('/packed')
  check('bundle-sourced repo page', packed.status === 200 && packed.body.includes('packed'))

  const evil = await get('/demo/raw/HEAD/../../../../etc/passwd')
  check('path traversal refused', evil.status !== 200 || !evil.body.includes('root:'), 'status ' + evil.status)

  check('no stderr noise at error level', srvErr.trim() === '', srvErr.trim().slice(0, 80))
} finally {
  srv.kill('SIGTERM')
  rmSync(work, { recursive: true, force: true })
}

if (failed) { step(failed + ' FAILED — exiting 1'); process.exit(1) }
step('all green')
