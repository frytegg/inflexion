/**
 * Tests for the hedging surface (GreeksEngine + HedgeSuggester + executeOnPanoptic).
 *
 * Offline: the on-chain reads (`ILMath.computeIL`, `FairValueOracle.fairRate`) are
 * MOCKED on a stand-in PublicClient so the finite-difference math, the Carr-Madan
 * strip, the legs, and the graceful-degradation paths are all exercised without an
 * RPC. The mock IL is a convex, capped synthetic payoff so the greeks have the
 * expected SIGNS (long-gamma, long-vega) and the BL second-difference strip is
 * non-empty.
 */
import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { GreeksEngine, HedgeSuggester, executeOnPanoptic, HEDGE_CAVEAT } from './hedge.js'
import { WAD } from './math.js'
import type { HedgeSuggestion, PositionGeometry } from './types.js'

// ─── A representative in-range position geometry (dWETH/dUSDC-like) ───────────
// sqrtP0X96 ≈ sqrt(P0)·2^96. We use round numbers; computeIL is mocked so the
// EXACT sqrt values only matter for monotonicity of the grid (preserved).
const SQRT_P0 = 79_228_162_514_264_337_593_543_950_336n // 2^96 → P0 = 1.0
const POS: PositionGeometry = {
  tokenId: 3174n,
  token0: '0x0000000000000000000000000000000000000001',
  token1: '0x0000000000000000000000000000000000000002',
  fee: 500,
  tickLower: -1000,
  tickUpper: 1000,
  liquidity: 1_000_000_000_000n,
  sqrtPaX96: (SQRT_P0 * 9n) / 10n, // Pa/P0 ≈ 0.81 (sqrt 0.9)
  sqrtPbX96: (SQRT_P0 * 11n) / 10n, // Pb/P0 ≈ 1.21 (sqrt 1.1)
  sqrtP0X96: SQRT_P0,
  aWad: 810_000_000_000_000_000n, // a = (0.9)^2 = 0.81
  bWad: 1_210_000_000_000_000_000n, // b = (1.1)^2 = 1.21
  amount0Entry: 500_000_000_000_000_000n,
  amount1Entry: 500_000_000n,
  maxIL: 1_000_000_000n, // $1,000 (6-dec) cap
  V0: 1_000_000_000n,
}

const DURATION = 7n * 24n * 60n * 60n // 7d
const SIGMA = 700_000_000_000_000_000n // σ_ref = 0.70 WAD

// ── synthetic on-chain math ──────────────────────────────────────────────────
// computeIL(sqrtPT, …): convex IL ∝ (P/P0 − 1)^2 in USDC raw, before the cap. We
// recover P/P0 from sqrtPT/sqrtP0 = sqrt(ratio). Coefficient chosen so the wings
// reach ~MaxIL near the range edges (so the cap actually bites → tests the min()).
function mockComputeIL(sqrtPT: bigint): bigint {
  const ratio = (Number(sqrtPT) / Number(SQRT_P0)) ** 2 // P/P0
  const il = 30_000_000_000 * (ratio - 1) ** 2 // convex, $ at edge ~ 30000·0.04·…
  return BigInt(Math.max(0, Math.round(il)))
}

// fairRate(a, b, σ, T): a closed-form-ish proxy that is INCREASING in σ and in T
// (so vega > 0 and theta > 0 for the long-gamma claim). Returns WAD (≤ 1).
function mockFairRate(sigma: bigint, dur: bigint): bigint {
  const s = Number(sigma) / Number(WAD)
  const t = Number(dur) / (365 * 24 * 60 * 60)
  const rate = Math.min(0.99, 0.4 * s * Math.sqrt(t)) // σ·√T shape
  return BigInt(Math.round(rate * 1e18))
}

/** A mock PublicClient that answers only the two reads the hedge module makes. */
function mockClient(opts?: { failIL?: boolean; failRate?: boolean }): PublicClient {
  const readContract = async (args: {
    functionName: string
    args: readonly unknown[]
  }): Promise<unknown> => {
    if (args.functionName === 'computeIL') {
      if (opts?.failIL) throw new Error('ILMath read reverted (mock)')
      return mockComputeIL(args.args[0] as bigint)
    }
    if (args.functionName === 'fairRate') {
      if (opts?.failRate) throw new Error('FairValueOracle read reverted (mock)')
      return mockFairRate(args.args[2] as bigint, args.args[3] as bigint)
    }
    throw new Error(`unexpected read: ${args.functionName}`)
  }
  return { readContract } as unknown as PublicClient
}

describe('GreeksEngine.greeks', () => {
  it('returns priceable greeks with the long-gamma / long-vega signs', async () => {
    const eng = new GreeksEngine(mockClient())
    const g = await eng.greeks(POS, DURATION, SIGMA)
    expect(g.priceable).toBe(true)
    if (!g.priceable) return
    // convex payoff ⇒ positive gamma (long convexity).
    expect(g.gamma).toBeGreaterThan(0)
    // increasing in σ and T ⇒ positive vega and theta.
    expect(g.vega).toBeGreaterThan(0)
    expect(g.theta).toBeGreaterThan(0)
    // delta is finite (near-zero for a symmetric-ish payoff around P0).
    expect(Number.isFinite(g.delta)).toBe(true)
  })

  it('degrades (priceable:false, oracle-degraded) when the IL read reverts', async () => {
    const eng = new GreeksEngine(mockClient({ failIL: true }))
    const g = await eng.greeks(POS, DURATION, SIGMA)
    expect(g.priceable).toBe(false)
    if (g.priceable) return
    expect(g.reason).toBe('oracle-degraded')
  })

  it('degrades when the fairRate read reverts (vega path)', async () => {
    const eng = new GreeksEngine(mockClient({ failRate: true }))
    const g = await eng.greeks(POS, DURATION, SIGMA)
    expect(g.priceable).toBe(false)
  })

  it('bookGreeks sums priceable positions and skips degraded ones', async () => {
    const eng = new GreeksEngine(mockClient())
    const r = await eng.bookGreeks([
      { position: POS, durationSeconds: DURATION, sigmaRefWad: SIGMA },
      { position: POS, durationSeconds: DURATION, sigmaRefWad: SIGMA },
    ])
    expect(r.counted).toBe(2)
    expect(r.skipped).toBe(0)
    expect(r.greeks.gamma).toBeGreaterThan(0)
    expect(r.greeks.vega).toBeGreaterThan(0)
  })

  it('bookGreeks never throws on a degraded read (counts it as skipped)', async () => {
    const eng = new GreeksEngine(mockClient({ failIL: true }))
    const r = await eng.bookGreeks([
      { position: POS, durationSeconds: DURATION, sigmaRefWad: SIGMA },
    ])
    expect(r.counted).toBe(0)
    expect(r.skipped).toBe(1)
  })
})

describe('HedgeSuggester.suggestHedge', () => {
  it('returns the three legs + the VERBATIM caveat for a single position', async () => {
    const sug = new HedgeSuggester(mockClient())
    const h = await sug.suggestHedge({
      position: POS,
      durationSeconds: DURATION,
      sigmaRefWad: SIGMA,
    })
    expect(h.caveat).toBe(HEDGE_CAVEAT)
    expect(h.caveat).toContain('APPROXIMATE')
    expect(h.caveat).toContain('NOT relied upon for pool solvency')
    expect(h.caveat).toContain('invariant I1')

    // strip: a non-empty long-gamma ladder of vanillas with both wings.
    expect(h.strip.length).toBeGreaterThan(0)
    for (const leg of h.strip) {
      expect(leg.notional).toBeGreaterThan(0)
      expect(['call', 'put']).toContain(leg.type)
      // BL convention: puts below P0 (ratio<1), calls above.
      if (leg.strike < 1) expect(leg.type).toBe('put')
      else expect(leg.type).toBe('call')
    }

    // onChainInverse: a long-gamma range spanning [Pa/P0, Pb/P0].
    expect(h.onChainInverse.direction).toBe('long-gamma')
    expect(h.onChainInverse.venue).toBe('panoptic')
    expect(h.onChainInverse.rangeLow).toBeCloseTo(0.81, 2)
    expect(h.onChainInverse.rangeHigh).toBeCloseTo(1.21, 2)
    expect(h.onChainInverse.sizeL).toBeGreaterThan(0)

    // deltaOverlay: a perp/spot of finite size.
    expect(['perp', 'spot']).toContain(h.deltaOverlay.instrument)
    expect(Number.isFinite(h.deltaOverlay.size)).toBe(true)
  })

  it('honours the venue + overlay-instrument options', async () => {
    const sug = new HedgeSuggester(mockClient())
    const h = await sug.suggestHedge(
      { position: POS, durationSeconds: DURATION, sigmaRefWad: SIGMA },
      { venue: 'gammaswap', overlayInstrument: 'spot', stripStrikes: 5 },
    )
    expect(h.onChainInverse.venue).toBe('gammaswap')
    expect(h.deltaOverlay.instrument).toBe('spot')
    expect(h.strip.length).toBeLessThanOrEqual(5)
  })

  it('aggregates a BOOK into one strip + a spanning inverse range', async () => {
    const sug = new HedgeSuggester(mockClient())
    const wide: PositionGeometry = {
      ...POS,
      aWad: 640_000_000_000_000_000n, // a = 0.8^2 = 0.64
      bWad: 1_440_000_000_000_000_000n, // b = 1.2^2 = 1.44
      sqrtPaX96: (SQRT_P0 * 8n) / 10n,
      sqrtPbX96: (SQRT_P0 * 12n) / 10n,
    }
    const h = await sug.suggestHedge([
      { position: POS, durationSeconds: DURATION, sigmaRefWad: SIGMA },
      { position: wide, durationSeconds: DURATION, sigmaRefWad: SIGMA },
    ])
    // range spans the WIDER position's edges.
    expect(h.onChainInverse.rangeLow).toBeCloseTo(0.64, 2)
    expect(h.onChainInverse.rangeHigh).toBeCloseTo(1.44, 2)
    // size proxy is the SUM of both positions' liquidity.
    expect(h.onChainInverse.sizeL).toBeCloseTo(Number(POS.liquidity) * 2, -3)
    expect(h.caveat).toBe(HEDGE_CAVEAT)
  })

  it('degrades to an empty (but valid) suggestion when reads revert — never throws', async () => {
    const sug = new HedgeSuggester(mockClient({ failIL: true }))
    const h = await sug.suggestHedge({
      position: POS,
      durationSeconds: DURATION,
      sigmaRefWad: SIGMA,
    })
    expect(h.strip).toEqual([])
    expect(h.onChainInverse.rangeLow).toBe(0)
    expect(h.deltaOverlay.size).toBe(0)
    // the caveat ALWAYS attaches, even degraded.
    expect(h.caveat).toBe(HEDGE_CAVEAT)
  })

  it('suggestHedgeChecked returns a typed degraded envelope when the strip read reverts', async () => {
    // The strip (leg 1) is built from computeIL; if it reverts the whole
    // suggestion is unpriceable.
    const sug = new HedgeSuggester(mockClient({ failIL: true }))
    const r = await sug.suggestHedgeChecked({
      position: POS,
      durationSeconds: DURATION,
      sigmaRefWad: SIGMA,
    })
    expect(r.priceable).toBe(false)
    if (r.priceable) return
    expect(r.reason).toBe('oracle-degraded')
  })

  it('still produces a valid suggestion when only the fairRate (overlay) read reverts', async () => {
    // computeIL drives the strip + inverse range (still good); only the delta
    // overlay needs fairRate, and bookGreeks degrades it to a zero overlay
    // rather than failing the whole suggestion.
    const sug = new HedgeSuggester(mockClient({ failRate: true }))
    const h = await sug.suggestHedge({
      position: POS,
      durationSeconds: DURATION,
      sigmaRefWad: SIGMA,
    })
    expect(h.strip.length).toBeGreaterThan(0) // strip survives
    expect(h.onChainInverse.rangeLow).toBeCloseTo(0.81, 2) // range survives
    expect(h.deltaOverlay.size).toBe(0) // overlay degraded to zero (greeks skipped)
    expect(h.caveat).toBe(HEDGE_CAVEAT)
  })

  it('handles an empty book without throwing', async () => {
    const sug = new HedgeSuggester(mockClient())
    const h = await sug.suggestHedge([])
    expect(h.strip).toEqual([])
    expect(h.caveat).toBe(HEDGE_CAVEAT)
  })
})

describe('executeOnPanoptic — read-only', () => {
  it('returns an UNEXECUTED plan carrying the range + caveat (never sends a tx)', async () => {
    const sug = new HedgeSuggester(mockClient())
    const h: HedgeSuggestion = await sug.suggestHedge({
      position: POS,
      durationSeconds: DURATION,
      sigmaRefWad: SIGMA,
    })
    const plan = executeOnPanoptic(h)
    expect(plan.executed).toBe(false)
    expect(plan.venue).toBe('panoptic')
    expect(plan.direction).toBe('long-gamma')
    expect(plan.rangeLow).toBe(h.onChainInverse.rangeLow)
    expect(plan.rangeHigh).toBe(h.onChainInverse.rangeHigh)
    expect(plan.caveat).toBe(HEDGE_CAVEAT)
    expect(plan.note).toContain('READ-ONLY')
  })
})
