#!/usr/bin/env node
/* check-deployed-peer.mjs — interop probe of the DEPLOYED site's embedded peer.
 *
 * The gh-pages app (ipfs-gh-pages) IS a Helia IPFS node in the browser: the
 * Peer tab initializes libp2p in-page, reserves relay slots, dials the
 * mainline swarm over wss/webtransport/webrtc and joins the repo's pubsub
 * topic. CI can't be dialed BY the page, but it can load the page headless
 * and assert the embedded peer actually comes up on the live network:
 *
 *   1. page loads and the Peer section renders
 *   2. in-browser Helia node reports a Peer ID (init left "Initializing…")
 *   3. it has multiaddrs — incl. a relayed one once a reservation lands
 *   4. Connected Peers >= 1 (it dialed the mainline swarm)
 *
 * All four are hard checks: a deployed page whose embedded peer can't join
 * the swarm has regressed. Requires playwright + chromium
 * (`npx playwright install chromium`); SITE_URL picks a non-default deploy.
 */
import { chromium } from 'playwright'

const SITE_URL = (process.env.SITE_URL || 'https://randymcmillan.github.io/ipfs-agentd').replace(/\/$/, '')
const BOOT_TIMEOUT_MS = Number(process.env.PEER_BOOT_TIMEOUT_MS || 150000)
const PEER_ID_RE = /(?:12D3KooW[1-9A-HJ-NP-Za-km-z]{44}|16Uiu2H[1-9A-HJ-NP-Za-km-z]{44}|Qm[1-9A-HJ-NP-Za-km-z]{44})/

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) console.log('PASS ' + label + (detail ? ' → ' + detail : ''))
  else { failed++; console.log('FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(SITE_URL + '/#/peer', { waitUntil: 'domcontentloaded', timeout: 60000 })
  check('page loads', true, SITE_URL + '/#/peer')

  /* the SPA renders every tab's DOM up front; the peer node fills in async —
   * poll the rendered text until the status block carries a real peer id */
  let text = ''
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.body.innerText).catch(() => '')
    const id = text.match(PEER_ID_RE)
    const peers = text.match(/Connected Peers \((\d+)\)/)
    if (id && peers && Number(peers[1]) >= 1) break
    await new Promise((r) => setTimeout(r, 3000))
  }

  const peerId = text.match(PEER_ID_RE)
  check('in-browser Helia node initialized (peer id)', !!peerId, peerId?.[0] ?? 'still "Initializing Helia IPFS Node…"')

  const addrs = (text.match(/\/(?:ip4|ip6|dns4|dns6)\/[^\s`]+/g) ?? [])
  const relayed = addrs.filter((a) => a.includes('/p2p-circuit'))
  check('node has multiaddrs', addrs.length > 0, addrs.length + ' addrs' + (relayed.length ? ', ' + relayed.length + ' relayed' : ''))

  const peers = text.match(/Connected Peers \((\d+)\)/)
  check('connected to the mainline swarm', !!peers && Number(peers[1]) >= 1, peers ? peers[1] + ' peers' : 'counter never rendered')

  if (pageErrors.length) console.log('::warning::page JS errors: ' + pageErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

if (failed) { console.log(failed + ' check(s) FAILED — exiting 1'); process.exit(1) }
console.log('deployed-peer: all green')
