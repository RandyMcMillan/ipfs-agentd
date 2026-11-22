/* ipfs-agentd — shared machinery for the git remote helpers
 * (git-remote-gnostr / git-remote-ipfs).
 *
 * Both are thin front-ends over this module: parse the URL form, resolve it
 * to a bundle CID, materialize a local bare repo, then serve git's
 * remote-helper protocol. The heavy lifting (libp2p stack, helia, bitswap)
 * comes from this repo's own node factory — no duplicated dependencies.
 *
 * Remote-helper protocol (we advertise a single capability, "connect"):
 *   git spawns `git-remote-<scheme> <remote-name> <url>` on PATH, speaks
 *   pkt-line request/response on our stdio until "connect git-upload-pack",
 *   after which we relay the byte stream to a local git-upload-pack child
 *   serving the materialized bare repo. Fetch-only; push is refused.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAgentNode } from './node.js'

export function fail (tag, msg) {
  process.stderr.write(tag + ': ' + msg + '\n')
  process.exit(1)
}

export const log = (tag, msg) => process.stderr.write(tag + ': ' + msg + '\n')

/* Boot a fetcher node on its own disk repo (block cache persists between
 * runs — repeat clones of the same repo hit local blocks). Env override for
 * the repo dir so CI/tests stay hermetic. */
export async function bootNode (tag) {
  const repoPath = process.env.IPFS_AGENTD_GIT_REPO || join(homedir(), '.ipfs-agentd-git')
  log(tag, 'node repo: ' + repoPath)
  return createAgentNode({
    repoPath,
    log: (m, level) => log(tag, '[' + level + '] ' + m)
  })
}

export async function stopNode (ctx) {
  try { await ctx.helia.stop() } catch {}
}

/* Bitswap wants are re-broadcast to every currently-connected peer on each
 * attempt, so retries pick up blocks from peers that dialed in late. */
export async function catWithRetry (ctx, tag, cidStr, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const chunks = []
      for await (const c of ctx.ufs.cat(cidStr)) chunks.push(c)
      return Buffer.concat(chunks)
    } catch (err) {
      if (i >= tries) throw err
      log(tag, `fetch attempt ${i} failed (${ctx.node.getPeers().length} peers connected), retrying…`)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

function run (cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    p.on('error', reject)
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code)))
  })
}

/* bundle CID → local bare repo dir (git clone --bare from the fetched bundle) */
export async function materializeBundle (ctx, tag, cidStr) {
  const dir = mkdtempSync(join(tmpdir(), tag + '-'))
  const bundlePath = join(dir, 'repo.bundle')
  log(tag, 'fetching bundle over ipfs/bitswap…')
  writeFileSync(bundlePath, await catWithRetry(ctx, tag, cidStr))
  await run('git', ['clone', '-q', '--bare', bundlePath, join(dir, 'repo.git')])
  return join(dir, 'repo.git')
}

/* bitswap wants must not race ahead of the bootstrap dials — wait until we
 * have at least one connection before subscribing or fetching */
export async function waitForPeers (ctx, tag, min = 1, timeoutMs = 20000) {
  if (ctx.node.getPeers().length >= min) return
  log(tag, 'dialing bootstrap peers…')
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(t); ctx.node.removeEventListener('peer:connect', onConnect) }
    const t = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for peers')) }, timeoutMs)
    const onConnect = () => { if (ctx.node.getPeers().length >= min) { cleanup(); resolve() } }
    ctx.node.addEventListener('peer:connect', onConnect)
  })
}

/* Serve the remote-helper protocol until git says "connect git-upload-pack",
 * then relay to a local git-upload-pack child. resolve() only fires when the
 * child exits — the caller awaits it before final cleanup. */
export function serveRepo (tag, repoDir) {
  log(tag, 'serving ' + repoDir)
  return new Promise((resolve) => {
    let chunks = []
    process.stdin.on('data', (d) => {
      chunks.push(d)
      let buf = Buffer.concat(chunks)
      let i
      while ((i = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, i).toString('utf8')
        chunks = [buf.subarray(i + 1)]
        buf = Buffer.concat(chunks)
        if (line === 'capabilities') {
          process.stdout.write('connect\n\n')
        } else if (line.startsWith('connect ')) {
          const service = line.slice('connect '.length).trim()
          if (service !== 'git-upload-pack') {
            process.stdout.write('error ' + tag + ' remotes are fetch-only (' + service + ' unsupported)\n')
            setTimeout(() => process.exit(1), 500)
            return
          }
          const child = spawn(service, [repoDir])
          child.stderr.pipe(process.stderr)
          process.stdin.removeAllListeners('data')
          process.stdout.write('\n') // connect ack: empty line = proceed
          const rest = Buffer.concat(chunks)
          if (rest.length) child.stdin.write(rest) // leftover pkt-line bytes
          process.stdin.pipe(child.stdin)
          child.stdout.pipe(process.stdout)
          child.on('close', (code) => { process.stdout.write('', () => process.exit(code ?? 0)) }) // drain our stdout buffer into git before exiting, else the pack tail is lost
          resolve()
          return
        } else if (line.startsWith('option ')) {
          process.stdout.write('unsupported\n')
        } else if (line === '') {
          // protocol spacer — ignore
        } else {
          process.stdout.write('error unknown command: ' + line + '\n')
          process.exit(1)
        }
      }
    })
  })
}
