#!/usr/bin/env node
/* ipfs-agentd — CLI binary.
 *
 *   ipfs-agentd [daemon] [daemon flags]   MCP stdio daemon (default)
 *   ipfs-agentd chat [--topic gnostr] [--name alice] [--repo path] [--logging L]
 *   ipfs-agentd serve [--root /data/repos] [--port 8080] [--publish]
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
  ipfs-agentd serve [--root <dir>] [--port <port>] [--host <addr>] [--name <id>]
                    [--publish] [--topic <topic>] [--logging <level>]
      GitHub-like repo browser for humans + agents. Each subdir of --root is
      a repo (bare, working clone, or .bundle). --publish announces every
      repo on the gnostr topic and shows clone URLs on the repo pages.
  ipfs-agentd --help    Show this help.
`

/* Wrapped in async main() rather than top-level await so the tree bundles
 * to CommonJS — Node SEA (single-executable apps) only runs an embedded
 * CJS script (see .github/workflows/release.yml). */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2)

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE)
  } else if (cmd === 'chat') {
    const { chatMain } = await import('./cli.js')
    await chatMain(rest)
  } else if (cmd === 'serve') {
    const { serveMain } = await import('./web.js')
    await serveMain(rest)
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
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
