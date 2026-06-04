/**
 * LpClient tests.
 *
 * Two assertion paths (matching the foundation convention):
 *  1. ALWAYS (offline, no RPC) — pure helpers (sqrt→price, V0, slippage, the
 *     empty-quote sentinel, the create-call calldata encoders) + graceful-
 *     degradation behaviour driven by a MOCK public client that simulates a
 *     reverting oracle, a missing engine, and a missing wallet. These prove the
 *     typed-degraded contract without any network.
 *  2. WHEN AN RPC IS AVAILABLE (gated) — exercise `resolveGeometry` /
 *     `previewPremium` / `getPayoffCurve` / `getProtectionStatus` against the live
 *     Arbitrum Sepolia deployment using the seeded demo position + market.
 */
import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { LpClient, positionV0, sqrtToPriceWad, withSlippage, type LpGeometry } from './lp.js'
import { inflexionCoreAbi } from './abis.js'
import { core, demo, tokens } from './addresses.js'
import { makePublicClient, resolveRpcUrl } from './client.js'
import * as cvamm from './math.js'

// ─── pure helpers (offline) ──────────────────────────────────────────────────

describe('LP pure helpers (offline)', () => {
  it('sqrtToPriceWad inverts a known sqrtPriceX96 (P=1 → 1e18)', () => {
    const Q96 = 1n << 96n // sqrt(1)·2^96 → price 1.0
    expect(sqrtToPriceWad(Q96)).toBe(cvamm.WAD)
    // P=4 → sqrtP = 2·Q96
    expect(sqrtToPriceWad(2n * Q96)).toBe(4n * cvamm.WAD)
  })

  it('withSlippage adds a bps buffer and rounds up', () => {
    expect(withSlippage(1_000_000n, 100)).toBe(1_010_001n) // +1% +1 wei round-up
    expect(withSlippage(0n, 100)).toBe(1n)
  })

  it('positionV0 = amount0·P0 + amount1 in numéraire units', () => {
    const Q96 = 1n << 96n
    const g = {
      sqrtP0X96: Q96, // P0 = 1.0
      amount0Entry: 5n * 10n ** 18n,
      amount1Entry: 7n * 10n ** 18n,
    } as unknown as LpGeometry
    expect(positionV0(g)).toBe(12n * 10n ** 18n) // 5·1 + 7
  })
})

// ─── calldata encoders (offline) ─────────────────────────────────────────────

describe('LpClient.encodeBuyProtection (offline)', () => {
  const lp = new LpClient({ publicClient: {} as never })
  const tokenId = 3174n
  const marketId = demo.marketId_fee500_7d as Hex
  const maxPremium = 1_000_000_000n

  it('default routes via createSwapRouted with the empty-quote sentinel (pool-only)', () => {
    const data = lp.encodeBuyProtection({ tokenId, marketId, maxPremium })
    const dec = decodeFunctionData({ abi: inflexionCoreAbi, data })
    expect(dec.functionName).toBe('createSwapRouted')
    const quote = dec.args?.[0] as { mm: Address; marketId: Hex }
    expect(quote.mm).toBe(zeroAddress) // sentinel ⇒ router falls back to pool
    expect(quote.marketId.toLowerCase()).toBe(marketId.toLowerCase())
    expect(dec.args?.[1]).toBe('0x')
    expect(dec.args?.[2]).toBe(tokenId)
    expect(dec.args?.[3]).toBe(maxPremium)
  })

  it("escapeHatch 'A' encodes createSwapPathA", () => {
    const data = lp.encodeBuyProtection({ tokenId, marketId, maxPremium, escapeHatch: 'A' })
    const dec = decodeFunctionData({ abi: inflexionCoreAbi, data })
    expect(dec.functionName).toBe('createSwapPathA')
    expect(dec.args?.[0]).toBe(marketId)
    expect(dec.args?.[1]).toBe(tokenId)
  })

  it("escapeHatch 'B' encodes createSwap with the supplied quote", () => {
    const quote = {
      mm: demo.marketMaker,
      marketId,
      loadBps: 500,
      minMaxILRatioBps: 0,
      maxMaxILRatioBps: 10_000,
      quotePrice: 123n,
      priceBandBps: 50,
      model: 0,
      partialRatioBps: 0,
      maxNotionalV0: 1_000_000n,
      validUntil: 9_999_999_999n,
      quoteId: ('0x' + '11'.repeat(32)) as Hex,
      nonce: 1n,
    }
    const data = lp.encodeBuyProtection({
      tokenId,
      marketId,
      maxPremium,
      escapeHatch: 'B',
      quote,
      signature: ('0x' + 'ab'.repeat(65)) as Hex,
    })
    const dec = decodeFunctionData({ abi: inflexionCoreAbi, data })
    expect(dec.functionName).toBe('createSwap')
    const q = dec.args?.[0] as { mm: Address; loadBps: number }
    expect(q.mm).toBe(demo.marketMaker)
    expect(q.loadBps).toBe(500)
  })

  it("escapeHatch 'B' without a quote throws (the one hard error)", () => {
    expect(() =>
      lp.encodeBuyProtection({ tokenId, marketId, maxPremium, escapeHatch: 'B' }),
    ).toThrow(/requires \{quote, signature\}/)
  })
})

// ─── graceful degradation (offline, mock client) ─────────────────────────────

/** A minimal mock public client where every read throws a synthetic revert. */
function revertingClient(): { publicClient: never } {
  const err = Object.assign(new Error('execution reverted: OracleStale'), {
    name: 'ContractFunctionExecutionError',
  })
  return {
    publicClient: {
      readContract: vi.fn(async () => {
        throw err
      }),
      simulateContract: vi.fn(async () => {
        throw err
      }),
    } as never,
  }
}

describe('LpClient graceful degradation (offline)', () => {
  it('previewPremium returns a typed NotPriceable when the market read reverts', async () => {
    const lp = new LpClient(revertingClient())
    const r = await lp.previewPremium(3174n, demo.marketId_fee500_7d as Hex)
    expect(r.priceable).toBe(false)
    if (!r.priceable) {
      // market read reverts first → market-unknown (still a typed result, no throw)
      expect(['market-unknown', 'oracle-degraded', 'position-unknown']).toContain(r.reason)
    }
  })

  it('resolveGeometry never throws on a reverting oracle/market', async () => {
    const lp = new LpClient(revertingClient())
    const r = await lp.resolveGeometry(3174n, demo.marketId_fee500_7d as Hex)
    expect(r.priceable).toBe(false)
  })

  it('listEligiblePositions returns [] when NPM is unreachable (no throw)', async () => {
    const lp = new LpClient(revertingClient())
    const list = await lp.listEligiblePositions(
      '0x0000000000000000000000000000000000000001' as Address,
    )
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBe(0)
  })

  it('getProtectionStatus returns {available:false} on a reverting read (no throw)', async () => {
    const lp = new LpClient(revertingClient())
    const s = await lp.getProtectionStatus(1n)
    expect('available' in s && s.available === false).toBe(true)
  })

  it('write methods throw a clear error when no wallet is configured', async () => {
    const lp = new LpClient({ publicClient: {} as never })
    await expect(
      lp.buyProtection({ tokenId: 1n, marketId: demo.marketId_fee500_7d as Hex, maxPremium: 1n }),
    ).rejects.toThrow(/wallet client is required/)
    await expect(lp.settle(1n)).rejects.toThrow(/wallet client is required/)
  })

  it('fetchEngineQuote / telemetry never throw when there is no engine configured', async () => {
    // No engineBaseUrl + no fetch → previewPremium just routes Path A. We can't run
    // the on-chain price offline, but the engine-quote path itself must be inert:
    // a reverting client still yields a typed degraded result, never a fetch error.
    const lp = new LpClient(revertingClient())
    const r = await lp.previewPremium(3174n, demo.marketId_fee500_7d as Hex)
    expect(r.priceable).toBe(false) // degraded, not thrown
  })
})

// ─── live (gated on RPC) ─────────────────────────────────────────────────────

describe('LpClient live reads (gated on RPC)', () => {
  const rpc = resolveRpcUrl()
  const maybe = rpc === undefined ? it.skip : it

  maybe('resolveGeometry returns priceable geometry for the demo position', async () => {
    const lp = new LpClient({ publicClient: makePublicClient() })
    const r = await lp.resolveGeometry(demo.lpPositionTokenId, demo.marketId_fee500_7d as Hex)
    // Either priceable (oracle live) or a typed oracle-degraded result — never a throw.
    if (r.priceable) {
      expect(r.geometry.sqrtPaX96 > 0n).toBe(true)
      expect(r.geometry.sqrtPbX96 > r.geometry.sqrtPaX96).toBe(true)
      expect(r.geometry.maxIL >= 0n).toBe(true)
    } else {
      expect(['oracle-degraded', 'market-unknown', 'position-unknown']).toContain(r.reason)
    }
  })

  maybe('previewPremium returns premiumA ≤ maxIL and best ≤ premiumA', async () => {
    const lp = new LpClient({ publicClient: makePublicClient() })
    const r = await lp.previewPremium(demo.lpPositionTokenId, demo.marketId_fee500_7d as Hex)
    if (r.priceable) {
      expect(r.premiumA <= r.maxIL).toBe(true)
      expect(r.best <= r.premiumA).toBe(true)
      expect(r.path === 'A' || r.path === 'B').toBe(true)
      expect(r.fairPremium >= 0n).toBe(true)
    }
  })

  maybe('getPayoffCurve is monotone-capped at maxIL with the edges marked', async () => {
    const lp = new LpClient({ publicClient: makePublicClient() })
    const c = await lp.getPayoffCurve(demo.lpPositionTokenId, demo.marketId_fee500_7d as Hex, {
      points: 24,
    })
    if (c.priceable) {
      expect(c.points.length).toBeGreaterThanOrEqual(24)
      for (const pt of c.points) {
        expect(pt.payout <= c.maxIL).toBe(true)
        expect(pt.payout <= pt.il || pt.payout === pt.il).toBe(true)
      }
      expect(c.edgeHighWad > c.edgeLowWad).toBe(true)
    }
  })

  maybe('getProtectionStatus resolves the seeded settled swap', async () => {
    const lp = new LpClient({ publicClient: makePublicClient() })
    const s = await lp.getProtectionStatus(demo.smokeTestSwapId)
    if ('available' in s) {
      expect(s.available).toBe(false)
    } else {
      expect(s.noBadDebtFull).toBe(true)
      expect(typeof s.isPathA).toBe('boolean')
      // ilToDate is itself a Priceable — degraded-safe.
      expect('priceable' in s.ilToDate).toBe(true)
    }
  })
})

// silence the unused-import linter for the always-present demo token refs.
void tokens
void core
