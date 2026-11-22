/* chat e2e — human (chat CLI subprocess) <-> agent (in-process tools node).
 *
 *   1. start the chat CLI on a private topic
 *   2. agent joins via ipfs_pubsub_pull/publish using the chat envelope
 *   3. human types a line; agent must receive it
 *   4. agent sends a chat envelope; CLI stdout must show it
 *   5. --logging error must suppress info-level stderr
 * Run: node test/chat-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'
import { createLogger, LEVELS } from '../src/logger.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const step = (s) => process.stderr.write('chat-e2e: ' + s + '\n')
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

/* logging level sanity */
const silentLog = createLogger('silent')
let wrote = false
silentLog('x') // default sink writes to stderr — just assert LEVELS ordering instead
check('logger levels ordered', LEVELS.debug < LEVELS.info && LEVELS.info < LEVELS.warn && LEVELS.warn < LEVELS.error && LEVELS.error < LEVELS.silent)

const topic = 'chat-smoke-' + process.pid
const chatRepo = mkdtempSync(join(tmpdir(), 'chat-human-'))
const agentRepo = mkdtempSync(join(tmpdir(), 'chat-agent-'))

/* the human side */
const human = spawn(process.execPath, [join(root, 'src/bin.js'), 'chat', '--topic', topic, '--name', 'alice', '--repo', chatRepo, '--logging', 'error'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GNOSTR_LISTEN: '/ip4/127.0.0.1/tcp/0' } })
let humanOut = ''
human.stdout.on('data', (d) => { humanOut += d.toString() })
let humanErr = ''
human.stderr.on('data', (d) => { humanErr += d.toString() })

/* the agent side — created AFTER the CLI announces, so it can bootstrap
 * against the human's advertised address. Bootstrapping (not a one-shot
 * dial) matters: the re-bootstrap sweep then self-heals the connection if
 * transient churn prunes it mid-test */
let ctx = null
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

try {
  await new Promise((r) => setTimeout(r, 9000))   /* chat ready + mesh settle */
  check('chat CLI announced ready', humanOut.includes('chat ready'), humanOut.split('\n')[0]?.slice(0, 80))

  const listen = [...humanOut.matchAll(/^listen: (\S+)$/gm)].map((m) => m[1])
  check('chat CLI advertised listen addrs', listen.length > 0, listen.slice(0, 2).join(' ').slice(0, 80))
  process.env.GNOSTR_BOOTSTRAP = listen.join(',')
  process.env.REBOOTSTRAP_SECS = '5'
  ctx = await createAgentNode({ repoPath: agentRepo })
  tools.ipfsPubsubPull(ctx, { topic, max: 1 })   /* subscribe the agent BEFORE any traffic */
  await new Promise((r) => setTimeout(r, 8000))   /* bootstrap dial + gossipsub mesh join */

  /* human -> agent */
  human.stdin.write('hello agents\n')
  let got = null
  const deadline = Date.now() + 60000
  while (!got && Date.now() < deadline) {
    const r = await tools.ipfsPubsubPull(ctx, { topic, max: 100 })
    for (const m of r.messages) {
      let env
      try { env = JSON.parse(Buffer.from(m.dataBase64, 'base64').toString()) } catch { continue }
      if (env?.type === 'chat' && env.name === 'alice' && env.text === 'hello agents') { got = env; break }
    }
    if (!got) await new Promise((r) => setTimeout(r, 3000))
  }
  check('human -> agent envelope', Boolean(got), got ? JSON.stringify(got).slice(0, 80) : 'never received')

  /* agent -> human: publish, then poll — transient mesh churn (bootstrap
   * connections flapping can prune the agent<->CLI session) must not flake
   * the suite; republish until rendered, like a real user would */
  let rendered = false
  for (let attempt = 1; attempt <= 3 && !rendered; attempt++) {
    await tools.ipfsPubsubPublish(ctx, { topic, dataBase64: b64(JSON.stringify({ type: 'chat', name: 'bot-7', text: 'hi human', at: Date.now() })) })
    const deadline = Date.now() + 15000
    while (!rendered && Date.now() < deadline) {
      rendered = humanOut.includes('bot-7') && humanOut.includes('hi human')
      if (!rendered) await new Promise((r) => setTimeout(r, 500))
    }
  }
  check('agent -> human rendered', rendered, humanOut.split('\n').filter((l) => l.includes('bot-7')).join(' | ').slice(0, 100))

  check('--logging error kept stderr quiet', humanErr.trim() === '', humanErr.trim().slice(0, 80))
} finally {
  human.kill('SIGTERM')
  if (ctx) await ctx.helia.stop()
  rmSync(chatRepo, { recursive: true, force: true })
  rmSync(agentRepo, { recursive: true, force: true })
}

if (failed) { step(failed + ' FAILED — exiting 1'); process.exit(1) }
step('all green')
