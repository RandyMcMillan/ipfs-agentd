/* ipfs-agentd smoke test — exercises the node + tools in-process, no MCP layer.
 * Run: node test/smoke.mjs   (uses a temp repo; does not touch ~/.ipfs-agentd)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'

const repo = mkdtempSync(join(tmpdir(), 'ipfs-agentd-smoke-'))
const step = (s) => process.stderr.write('smoke: ' + s + '\n')

let failed = 0
async function check (label, fn) {
  try {
    const out = await fn()
    step('PASS ' + label + ' → ' + JSON.stringify(out).slice(0, 120))
  } catch (err) {
    failed++
    step('FAIL ' + label + ' — ' + (err?.message || err))
  }
}

const ctx = await createAgentNode({ repoPath: repo, log: (m) => process.stderr.write('node: ' + m + '\n') })
step('node started, peer ' + ctx.node.peerId.toString())

const b64 = (s) => Buffer.from(s).toString('base64')

let cid = null
await check('ipfs_add', async () => {
  const r = await tools.ipfsAdd(ctx, { contentBase64: b64('hello ipfs agents') })
  cid = r.cid
  return r
})
await check('ipfs_cat round-trip', async () => {
  const r = await tools.ipfsCat(ctx, { cid })
  if (Buffer.from(r.base64, 'base64').toString() !== 'hello ipfs agents') throw new Error('content mismatch')
  return { size: r.size }
})
await check('ipfs_stat', () => tools.ipfsStat(ctx, { cid }))
await check('ipfs_pin_ls (add auto-pins)', async () => {
  const r = await tools.ipfsPinLs(ctx)
  if (!r.pins.includes(cid)) throw new Error('auto-pin missing from pin set')
  return { count: r.count }
})
await check('ipfs_pin_rm + pin again', async () => {
  await tools.ipfsPinRm(ctx, { cid })
  let r = await tools.ipfsPinLs(ctx)
  if (r.pins.includes(cid)) throw new Error('pin survived removal')
  await tools.ipfsPinAdd(ctx, { cid })
  r = await tools.ipfsPinLs(ctx)
  if (!r.pins.includes(cid)) throw new Error('pin not re-added')
  return { ok: true }
})
await check('ipfs_add_all (directory)', async () => {
  const r = await tools.ipfsAddAll(ctx, { files: [
    { path: 'docs/readme.txt', contentBase64: b64('# docs') },
    { path: 'docs/todo.txt', contentBase64: b64('- ship it') }
  ] })
  const st = await tools.ipfsStat(ctx, { cid: r.cid })
  if (st.type !== 'directory') throw new Error('expected directory, got ' + st.type)
  return { cid: r.cid, type: st.type }
})
await check('ipfs_resolve (CID passthrough)', async () => {
  const r = await tools.ipfsResolve(ctx, { path: cid })
  if (r.value !== cid) throw new Error('resolve mismatch: ' + r.value)
  return r
})
await check('ipfs_pubsub loopback', async () => {
  const payload = b64('hello gnostr')
  await tools.ipfsPubsubPull(ctx, { topic: 'smoke-test' })   /* subscribe */
  await tools.ipfsPubsubPublish(ctx, { topic: 'smoke-test', dataBase64: payload })
  await new Promise((r) => setTimeout(r, 300))
  const got = await tools.ipfsPubsubPull(ctx, { topic: 'smoke-test' })
  if (got.messages.length === 0) throw new Error('no loopback message (gossipsub needs a moment; re-run may pass)')
  return { messages: got.messages.length }
})
await check('ipfs_id', () => tools.ipfsId(ctx))

step('stopping…')
await ctx.helia.stop()
rmSync(repo, { recursive: true, force: true })
if (failed) { step(failed + ' FAILED — exiting 1'); process.exit(1) }
step('all green')
