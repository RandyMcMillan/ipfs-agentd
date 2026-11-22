/* ipfs-agentd MCP end-to-end test — spawns src/mcp-server.js as a real stdio
 * subprocess, performs the JSON-RPC handshake, lists tools, and round-trips
 * content through the MCP layer. Run: node test/mcp-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = mkdtempSync(join(tmpdir(), 'ipfs-agentd-mcp-'))

const step = (s) => process.stderr.write('e2e: ' + s + '\n')
let failed = 0
function check (label, ok, detail = '') {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const child = spawn(process.execPath, [join(root, 'src/mcp-server.js'), '--repo', repo], {
  stdio: ['pipe', 'pipe', 'inherit']   // server logs flow to OUR stderr — visible live
})

/* newline-delimited JSON-RPC over stdio */
let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})
function rpc (method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('RPC timeout: ' + method)) } }, 30000)
  })
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-e2e', version: '0.0.1' }
  })
  check('initialize', init.result?.serverInfo?.name === 'ipfs-agentd', JSON.stringify(init.result?.serverInfo))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const tools = await rpc('tools/list')
  const names = (tools.result?.tools ?? []).map((t) => t.name)
  check('tools/list (14 tools)', names.length === 14, names.join(','))

  const payload = Buffer.from('hello over MCP').toString('base64')
  const added = await rpc('tools/call', { name: 'ipfs_add', arguments: { contentBase64: payload } })
  const addedJson = JSON.parse(added.result.content[0].text)
  check('ipfs_add via MCP', Boolean(addedJson.cid), addedJson.cid)

  const cat = await rpc('tools/call', { name: 'ipfs_cat', arguments: { cid: addedJson.cid } })
  const catJson = JSON.parse(cat.result.content[0].text)
  check('ipfs_cat via MCP round-trip', Buffer.from(catJson.base64, 'base64').toString() === 'hello over MCP', catJson.size + ' bytes')

  const idRes = await rpc('tools/call', { name: 'ipfs_id', arguments: {} })
  check('ipfs_id via MCP', JSON.parse(idRes.result.content[0].text).peerId?.startsWith('12D3Koo'), '')

  const bad = await rpc('tools/call', { name: 'ipfs_cat', arguments: { cid: 'not-a-cid' } })
  check('error path returns isError', bad.result?.isError === true, bad.result?.content?.[0]?.text?.slice(0, 40))
} catch (err) {
  failed++
  step('FAIL exception — ' + (err?.message || err))
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => child.on('exit', r))
  rmSync(repo, { recursive: true, force: true })
}

if (failed) { step(failed + ' FAILED — exiting 1'); process.exit(1) }
step('all green')
