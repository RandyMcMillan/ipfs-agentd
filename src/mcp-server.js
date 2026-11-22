#!/usr/bin/env node
/* thin entry point — the daemon implementation lives in daemon.js so the
 * `ipfs-agentd` CLI binary can dispatch to it (see bin.js). */
import { main } from './daemon.js'

await main()
