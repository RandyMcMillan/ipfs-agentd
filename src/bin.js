#!/usr/bin/env node
/* ipfs-agentd — CLI binary.
 *
 *   ipfs-agentd [daemon] [daemon flags]   MCP stdio daemon (default)
 *   ipfs-agentd chat [--topic gnostr] [--name alice] [--repo path] [--logging L]
 *   ipfs-agentd --help
 *
 * Always run through an interpreter (`node src/bin.js …`) — packed/plugin
 * sandboxes may mount files non-executable.
 */
const USAGE = `ipfs-agentd — persistent local IPFS daemon for AI agents

Usage:
  ipfs-agentd [daemon] [--repo <path>] [--logging <level>] [--quiet]
      Run the MCP stdio daemon (default command).
      --logging: debug | info | warn | error | silent   (default: info)
  ipfs-agentd chat [--topic <topic>] [--name <name>] [--repo <path>] [--logging <level>]
      Human <-> agent / agent <-> agent chat on a gossipsub topic.
      Envelope: {"type":"chat","name","text","at"} (UTF-8 JSON).
  ipfs-agentd --help    Show this help.
`

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(USAGE)
} else if (cmd === 'chat') {
  const { chatMain } = await import('./cli.js')
  await chatMain(rest)
} else if (cmd === 'daemon') {
  const { main } = await import('./daemon.js')
  await main(rest)
} else if (cmd === undefined) {
  const { main } = await import('./daemon.js')
  await main([])
} else if (cmd.startsWith('-')) {
  /* bare flags with no subcommand = daemon */
  const { main } = await import('./daemon.js')
  await main([cmd, ...rest])
} else {
  process.stderr.write('unknown command: ' + cmd + '\n\n' + USAGE)
  process.exit(1)
}
