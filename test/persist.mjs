/* ipfs-agentd persistence test — proves the disk blockstore/datastore survive
 * a restart: add+pin, stop, start a FRESH node on the same repo, cat + pin_ls.
 * Run: node test/persist.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentNode } from '../src/node.js'
import * as tools from '../src/tools.js'

const repo = mkdtempSync(join(tmpdir(), 'ipfs-agentd-persist-'))
const step = (s) => process.stderr.write('persist: ' + s + '\n')
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) step('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; step('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const b64 = (s) => Buffer.from(s).toString('base64')
let cid = null

{ /* session 1: add + pin, then stop */
  const ctx = await createAgentNode({ repoPath: repo })
  cid = (await tools.ipfsAdd(ctx, { contentBase64: b64('survive the restart') })).cid
  step('session 1: added ' + cid)
  await ctx.helia.stop()
  step('session 1: stopped')
}

{ /* session 2: brand-new node on the same repo dir — no add, only reads */
  const ctx = await createAgentNode({ repoPath: repo })
  const cat = await tools.ipfsCat(ctx, { cid })
  check('content survives restart', Buffer.from(cat.base64, 'base64').toString() === 'survive the restart', cat.size + ' bytes')
  const pins = await tools.ipfsPinLs(ctx)
  check('pin survives restart', pins.pins.includes(cid), pins.count + ' pin(s)')
  await ctx.helia.stop()
}

rmSync(repo, { recursive: true, force: true })
if (failed) { step(failed + ' FAILED — exiting 1'); process.exit(1) }
step('all green')
