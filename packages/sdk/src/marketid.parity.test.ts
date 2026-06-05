import { describe, it, expect } from 'vitest'
import { encodePacked, keccak256 } from 'viem'
import { computeMarketId } from './resolveMarket.js'
import { tokens, demo } from './addresses.js'

/**
 * marketId pre-image parity — the SDK side of the lock.
 *
 * The marketId is a load-bearing JOIN key three implementations must agree on
 * bit-for-bit, or the Swap↔Market join silently breaks:
 *   - on-chain  keccak256(abi.encodePacked(address,address,uint24,uint32))
 *   - subgraph  packages/subgraph/src/helpers.ts `deriveMarketId`
 *   - SDK       packages/sdk/src/resolveMarket.ts `computeMarketId` (tested here)
 *
 * This pins the REAL SDK `computeMarketId` to the LIVE Arbitrum Sepolia demo
 * marketIds (deployments/arbitrum-sepolia.json, via addresses.ts) — the same two
 * vectors the on-chain side asserts in packages/contracts/test/MarketIdParity.t.sol.
 * It freezes the 20/20/3/4 width contract the subgraph's tight-packed deriveMarketId
 * relies on: any field-width drift here fails against the on-chain ground truth.
 */
describe('marketId parity — SDK computeMarketId == live on-chain marketId', () => {
  it('fee-500 / 7d (604800s) matches the seeded demo marketId', () => {
    const got = computeMarketId(tokens.demoWeth, tokens.demoUsdc, demo.poolFee, 604800)
    expect(got.toLowerCase()).toBe(demo.marketId_fee500_7d.toLowerCase())
  })

  it('fee-500 / 300s matches the lifecycle marketId', () => {
    const got = computeMarketId(tokens.demoWeth, tokens.demoUsdc, demo.poolFee, 300)
    expect(got.toLowerCase()).toBe(demo.shortMarketId_fee500_300s.toLowerCase())
  })

  it('computeMarketId equals a hand-built tight-packed (20+20+3+4) keccak', () => {
    // Independent re-derivation of the exact pre-image the subgraph helper builds,
    // proving computeMarketId is plain abi.encodePacked tight packing (no padding).
    const manual = keccak256(
      encodePacked(
        ['address', 'address', 'uint24', 'uint32'],
        [tokens.demoWeth, tokens.demoUsdc, demo.poolFee, 604800],
      ),
    )
    expect(computeMarketId(tokens.demoWeth, tokens.demoUsdc, demo.poolFee, 604800)).toBe(manual)
  })
})
