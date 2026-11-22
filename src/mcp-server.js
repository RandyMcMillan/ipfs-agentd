#!/usr/bin/env node
/* ipfs-agentd — MCP server (stdio transport).
 *
 * One persistent Helia node per daemon process; one daemon per agent.
 * Logs go to STDERR — stdout carries the MCP protocol exclusively.
 *
 * Usage:
 *   node src/mcp-server.js [--repo <path>] [--quiet]
 *
 * Env: IPFS_AGENTD_REPO, GNOSTR_BOOTSTRAP, GNOSTR_LISTEN (see node.js)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createAgentNode } from './node.js'
import * as tools from './tools.js'

const args = process.argv.slice(2)
const repoIdx = args.indexOf('--repo')
const repo = repoIdx !== -1 ? args[repoIdx + 1] : undefined
const quiet = args.includes('--quiet')

/* timestamped stderr log — this is what `tail -f` watches */
function log (msg) {
  if (quiet) return
  process.stderr.write(new Date().toISOString() + '  ' + msg + '\n')
}

log('ipfs-agentd starting…')
const ctx = await createAgentNode({ repoPath: repo, log })
log('node started (' + ctx.node.getPeers().length + ' peers at boot; bootstrap dials still landing)')

const server = new McpServer({ name: 'ipfs-agentd', version: '0.1.0' })

function def (name, description, shape, fn) {
  server.tool(name, description, shape, async (args) => {
    log('tool:' + name + ' ' + JSON.stringify({ ...args, contentBase64: args.contentBase64 ? `<${args.contentBase64.length} b64 chars>` : undefined, dataBase64: args.dataBase64 ? `<${args.dataBase64.length} b64 chars>` : undefined }))
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(ctx, args), null, 1) }] }
    } catch (err) {
      log('tool:' + name + ' ERROR ' + (err?.message || err))
      return { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] }
    }
  })
}

def('ipfs_id', 'Peer identity, listen addresses, and swarm stats of this agent\'s IPFS node',
  {}, tools.ipfsId)

def('ipfs_add', 'Add bytes to IPFS (UnixFS file) and pin them. Returns the CID.',
  { contentBase64: z.string().describe('base64-encoded file content'), name: z.string().optional() },
  tools.ipfsAdd)

def('ipfs_add_all', 'Add multiple files as a UnixFS directory. files: [{ path, contentBase64 }]',
  { files: z.array(z.object({ path: z.string(), contentBase64: z.string() })).min(1) },
  tools.ipfsAddAll)

def('ipfs_cat', 'Read a CID\'s content back (base64). offset/length for large files. 32 MiB cap per call.',
  { cid: z.string(), offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().optional() },
  tools.ipfsCat)

def('ipfs_stat', 'UnixFS stat of a CID: type, dag size, cumulative size, block count',
  { cid: z.string() }, tools.ipfsStat)

def('ipfs_pin_add', 'Pin a CID locally', { cid: z.string() }, tools.ipfsPinAdd)
def('ipfs_pin_rm', 'Unpin a CID', { cid: z.string() }, tools.ipfsPinRm)
def('ipfs_pin_ls', 'List all local pins', {}, tools.ipfsPinLs)

def('ipfs_resolve', 'Resolve /ipns/<name> to a CID (IPNS), or validate/echo a CID',
  { path: z.string() }, tools.ipfsResolve)

def('ipfs_pubsub_publish', 'Publish a message on a gossipsub topic (default "gnostr", wire-compatible with the gnostr git tools)',
  { topic: z.string().optional(), dataBase64: z.string() }, tools.ipfsPubsubPublish)

def('ipfs_pubsub_pull', 'Pull queued pubsub messages for a topic (subscribe-on-first-pull, poll-based)',
  { topic: z.string().optional(), max: z.number().int().positive().max(1000).optional() },
  tools.ipfsPubsubPull)

def('ipfs_name_publish', 'Publish a CID under a fresh one-shot IPNS key. Returns the IPNS name (PeerId).',
  { cid: z.string() }, tools.ipfsNamePublish)

const transport = new StdioServerTransport()
await server.connect(transport)
log('MCP stdio transport connected — ready for tool calls')
