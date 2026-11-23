/* ipfs-agentd chat — human <-> agent and agent <-> agent chat over a gossipsub topic.
 *
 * The chat envelope (shared contract, UTF-8 JSON on the topic):
 *   { "type": "chat", "name": "<display name>", "text": "<message>", "at": <epoch ms> }
 * Humans run this CLI; agents publish/pull the same envelope through the
 * ipfs_pubsub_publish / ipfs_pubsub_pull MCP tools. Anything that is not a chat
 * envelope is shown as RAW base64 so binary/agent protocols stay visible.
 *
 * Usage (also via `ipfs-agentd chat`):
 *   node src/cli.js chat --topic gnostr [--name alice] [--repo path] [--logging info]
 */
import readline from 'node:readline'
import { createAgentNode, DEFAULT_REPO } from './node.js'
import { createLogger } from './logger.js'

export async function chatMain (argv = []) {
  const opt = (flag, dflt) => {
    const i = argv.indexOf(flag)
    return i !== -1 ? argv[i + 1] : dflt
  }
  const topic = opt('--topic', 'gnostr')
  const name = opt('--name', process.env.USER || 'human')
  const repo = opt('--repo', DEFAULT_REPO)
  const logging = opt('--logging', 'info')

  const log = createLogger(logging)
  const ctx = await createAgentNode({ repoPath: repo, log })
  const self = ctx.node.peerId.toString()
  const short = (p) => (p.length > 14 ? p.slice(0, 8) + '…' : p)
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
  const show = (from, nameTag, text) => {
    process.stdout.write(`[${stamp()}] ${nameTag} (${short(from)}): ${text}\n`)
  }

  ctx.node.services.pubsub.subscribe(topic)
  /* rendezvous discovery: register under the topic's namespace and keep
   * dialing topic peers the rendezvous servers know — gossipsub then
   * starts with real neighbors instead of mesh luck. Inert when no
   * rendezvous server is configured. */
  if (ctx.rendezvous) {
    ctx.rendezvous.join(topic).then(
      (n) => { if (n > 0) process.stdout.write(`gnostr peers via rendezvous: ${n} found — dialing\n`) },
      () => {})
  }
  ctx.node.services.pubsub.addEventListener('message', (evt) => {
    log(`pubsub message on "${evt.detail.topic}" from ${evt.detail.from.toString().slice(0, 16)} (${evt.detail.data.length}B)`, 'debug')
    if (evt.detail.topic !== topic) return
    const from = evt.detail.from.toString()
    if (from === self) return
    let env = null
    try { env = JSON.parse(dec.decode(evt.detail.data)) } catch { /* raw payload */ }
    if (env?.type === 'chat' && typeof env.text === 'string') {
      show(from, env.name ?? 'anon', env.text)
    } else {
      show(from, 'RAW', Buffer.from(evt.detail.data).toString('base64'))
    }
  })

  /* give gossipsub a heartbeat to join the mesh before we claim readiness */
  await new Promise((r) => setTimeout(r, 2500))
  process.stdout.write(
    `chat ready — topic "${topic}" as "${name}" (${short(self)})\n` +
    'agents join via ipfs_pubsub_publish/pull with the {"type":"chat","name","text","at"} envelope; Ctrl-C to leave\n')
  /* advertise dialable addresses so agents/scripts can attach to this peer */
  for (const ma of ctx.node.getMultiaddrs()) {
    const s = ma.toString()
    const full = s.includes('/p2p/') ? s : s + '/p2p/' + self
    process.stdout.write((s.includes('/p2p-circuit') ? 'listen(relayed): ' : 'listen: ') + full + '\n')
  }

  const rl = readline.createInterface({ input: process.stdin, prompt: '> ' })
  rl.prompt()
  rl.on('line', (line) => {
    const text = line.trim()
    if (text.length > 0) {
      const msg = enc.encode(JSON.stringify({ type: 'chat', name, text, at: Date.now() }))
      ctx.node.services.pubsub.publish(topic, msg).then(
        /* local echo — a chat driver (human or agent) cannot otherwise tell
         * the line actually went out: receipt is not guaranteed and the
         * outbound envelope looks like any other traffic on a busy topic. */
        () => process.stdout.write('you: ' + text + '\n'),
        (err) => process.stderr.write('publish failed: ' + (err?.message || err) + '\n'))
    }
    rl.prompt()
  })

  await new Promise((resolve) => {
    process.on('SIGINT', resolve)
    rl.on('close', resolve)
  })
  rl.close()
  await ctx.helia.stop()
  process.stdout.write('left topic "' + topic + '"\n')
}
