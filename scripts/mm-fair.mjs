// Fetch the live "fair price" floor an MM must beat for a market — the geometry-free
// pool load-to-beat (`InflexionCore` σ_ref + utilisation + concentration → totalLoad).
// This is the Path-A floor; any MM quote with a smaller loadBps undercuts it.
//
// Run (from repo root):
//   MARKET_ID=0xb8bbd684f213d5833886ade7b531a6949d85522249881a2b5d46a5cc76e439c2 \
//   node scripts/mm-fair.mjs
// Import the built SDK by path (the repo root doesn't symlink @inflexion/sdk).
// Requires the SDK to be built once: `pnpm --filter @inflexion/sdk build`.
import { createInflexionSdk } from '../packages/sdk/dist/index.js'

const MARKET_ID = process.env.MARKET_ID
const RPC = process.env.RPC_URL ?? 'https://arbitrum-sepolia.publicnode.com'
if (MARKET_ID === undefined) throw new Error('MARKET_ID required')

const sdk = createInflexionSdk({ rpcUrl: RPC, chainId: 421614 })
const t = await sdk.mm.getPoolLoadToBeat(MARKET_ID)
if (!t.available) {
  console.log(`pool floor unreadable: ${t.reason ?? 'unknown'} ${t.detail ?? ''}`)
  process.exit(1)
}
const sig = t.sigmaRefWad !== undefined ? (Number(t.sigmaRefWad) / 1e16).toFixed(2) + '%' : 'n/a'
console.log(`market             ${MARKET_ID}`)
console.log(`σ_ref              ${sig}`)
console.log(`regime             ${t.regime ?? 'n/a'}`)
console.log(`POOL LOAD TO BEAT  ${t.totalLoadBps} bps`)
console.log(`→ any MM quote with loadBps < ${t.totalLoadBps} undercuts the pool (Path-A floor).`)
