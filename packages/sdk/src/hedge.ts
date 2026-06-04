/**
 * `GreeksEngine` + `HedgeSuggester` — the MM hedging surface (read-only analytics).
 *
 * The capped IL claim the MM writes is **long-gamma, long-vega convexity** (the
 * LP is long it; the MM is short it). This module produces exact, actionable
 * analytics, all derived from the protocol's OWN deployed math — no parallel
 * pricing model:
 *
 *  - **Price greeks (delta/gamma)** finite-difference the deployed `ILMath.computeIL`
 *    over a P_T grid — `computeIL` is the reference settlement math, so delta/gamma
 *    of the capped payoff `min(IL(P_T), MaxIL)` are exact.
 *  - **Vol greeks (vega) and theta** finite-difference the on-chain
 *    `FairValueOracle.fairRate(a, b, σ, T)` (pure) in σ and T. This keeps vega/theta
 *    anchored to the protocol's own fair value — NEVER a reimplemented Φ-sum.
 *
 * `HedgeSuggester.suggestHedge` returns a concrete three-leg hedge — a vanilla
 * long-gamma options `strip` (Carr-Madan / Breeden-Litzenberger discretisation of
 * the convex payoff from the same `computeIL` grid; Lipton-Lucic-Sepp static
 * replication is the theory anchor only), an `onChainInverse` long-gamma position,
 * and a residual `deltaOverlay` — with the VERBATIM approximate-hedge caveat.
 *
 * GRACEFUL DEGRADATION: every method that needs an on-chain read returns a typed
 * degraded result (`Priceable<…>` → `{ priceable:false, reason }`) when a read
 * fails (e.g. the oracle/RPC is unreachable). NOTHING throws on a missing read.
 * `executeOnPanoptic` is ANALYTICS ONLY — it never sends a transaction.
 */
import type { Address, PublicClient } from 'viem'
import { fairValueOracleAbi, ilMathAbi } from './abis.js'
import { core as coreAddrs, stylus as stylusAddrs } from './addresses.js'
import { WAD } from './math.js'
import type {
  DeltaOverlay,
  Greeks,
  HedgeLeg,
  HedgeSuggestion,
  OnChainInverse,
  PositionGeometry,
  Priceable,
} from './types.js'

// ─── Verbatim caveat (spec §3.5 — attached to EVERY HedgeSuggestion) ─────────
// Reproduced word-for-word from docs/ACCESS_LAYER_ARCHITECTURE.md §3.5. Any LP
// payout surface carries claim (A); this hedge surface carries the I1-structural
// disclaimer: the hedge is the MM's residual-risk choice, NOT relied on for
// solvency.

/** The approximate-hedge caveat — VERBATIM, attached to every suggestion. */
export const HEDGE_CAVEAT =
  'A perpetual-option / on-chain inverse hedge is APPROXIMATE relative to the ' +
  'fixed-maturity IL claim (mismatched expiry, funding, discretisation). It is ' +
  "the MM's own residual-risk choice and is NOT relied upon for pool solvency — " +
  'invariant I1 (no bad debt, FULL) is structural and oracle-independent, fully ' +
  'collateralised at MaxIL regardless of whether the MM hedges.'

// ─── Tunables ────────────────────────────────────────────────────────────────

export interface GreeksOptions {
  /** Number of interior grid points across [Pa, Pb] for the price-greeks FD. */
  points?: number
  /** Relative price bump for the central-difference delta/gamma (default 1%). */
  priceBumpRel?: number
  /** Absolute σ bump (WAD) for vega; default 0.01 (1 vol point). */
  sigmaBumpWad?: bigint
  /** Relative T bump for theta (default 1% of duration). */
  durationBumpRel?: number
}

const DEFAULT_POINTS = 64
const DEFAULT_PRICE_BUMP_REL = 0.01
const DEFAULT_SIGMA_BUMP_WAD = 10_000_000_000_000_000n // 0.01 in WAD
const DEFAULT_DURATION_BUMP_REL = 0.01

// ─── Addresses bundle (so the engine is injectable / testable) ───────────────

/** The on-chain addresses the hedge surface reads from. Both default to the
 *  registry; injectable for tests / alternate deployments. */
export interface HedgeAddresses {
  /** Deployed `ILMath` (computeIL — price greeks + strip). */
  ilMath: Address
  /** Stylus `FairValueOracle` (fairRate — vol greeks). */
  fairValueOracle: Address
}

function defaultAddresses(): HedgeAddresses {
  return { ilMath: coreAddrs.ilMath, fairValueOracle: stylusAddrs.fairValueOracle }
}

// ─── Small numeric helpers (bigint→float only at the FD boundary) ────────────

function toFloat(x: bigint): number {
  return Number(x)
}

/** sqrtPriceX96 for a price expressed as a WAD ratio relative to P0's sqrtP0X96.
 *  sqrtP(P) = sqrtP0 · sqrt(P/P0); here `priceRatioWad` = P/P0 in WAD. */
function sqrtPForRatio(sqrtP0X96: bigint, priceRatioWad: bigint): bigint {
  // sqrt(ratio) in WAD via float (the FD grid tolerates this; computeIL is exact
  // at whatever sqrtP we feed — the only approximation is the grid spacing).
  const r = Math.sqrt(toFloat(priceRatioWad) / toFloat(WAD))
  const scaled = BigInt(Math.round(r * 1e18))
  return (sqrtP0X96 * scaled) / WAD
}

// ─── GreeksEngine ─────────────────────────────────────────────────────────────

export class GreeksEngine {
  private readonly client: PublicClient
  private readonly addrs: HedgeAddresses

  constructor(client: PublicClient, addrs?: Partial<HedgeAddresses>) {
    this.client = client
    const d = defaultAddresses()
    this.addrs = {
      ilMath: addrs?.ilMath ?? d.ilMath,
      fairValueOracle: addrs?.fairValueOracle ?? d.fairValueOracle,
    }
  }

  /**
   * Greeks of the capped IL claim for a single position.
   *
   * delta/gamma  — central-difference of the capped payoff `min(computeIL, MaxIL)`
   *                in P (via `ILMath.computeIL`, the deployed reference math).
   * vega         — central-difference of `FairValueOracle.fairRate(a,b,σ,T)·MaxIL`
   *                in σ.
   * theta        — central-difference of the same fair premium in T (per year;
   *                sign convention: ∂Payout/∂T, positive = value rises with more
   *                time, as a long-gamma claim does).
   *
   * Returns a typed degraded result if any on-chain read fails — never throws.
   */
  async greeks(
    position: PositionGeometry,
    durationSeconds: bigint,
    sigmaRefWad: bigint,
    opts: GreeksOptions = {},
  ): Promise<Priceable<Greeks>> {
    try {
      const price = await this.priceGreeks(position, opts)
      const vol = await this.volGreeks(position, durationSeconds, sigmaRefWad, opts)
      return {
        priceable: true,
        delta: price.delta,
        gamma: price.gamma,
        vega: vol.vega,
        theta: vol.theta,
      }
    } catch (e) {
      return {
        priceable: false,
        reason: 'oracle-degraded',
        detail: e instanceof Error ? e.message : String(e),
      }
    }
  }

  /** Sum greeks across a book of positions. Degraded positions are skipped and
   *  reported in `skipped`; the call never throws on a single bad position. */
  async bookGreeks(
    positions: ReadonlyArray<{
      position: PositionGeometry
      durationSeconds: bigint
      sigmaRefWad: bigint
    }>,
    opts: GreeksOptions = {},
  ): Promise<{ greeks: Greeks; counted: number; skipped: number }> {
    const acc: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 }
    let counted = 0
    let skipped = 0
    for (const p of positions) {
      const g = await this.greeks(p.position, p.durationSeconds, p.sigmaRefWad, opts)
      if (g.priceable) {
        acc.delta += g.delta
        acc.gamma += g.gamma
        acc.vega += g.vega
        acc.theta += g.theta
        counted++
      } else {
        skipped++
      }
    }
    return { greeks: acc, counted, skipped }
  }

  // ── price greeks: finite-difference computeIL of the CAPPED payoff in P ──────

  private async priceGreeks(
    position: PositionGeometry,
    opts: GreeksOptions,
  ): Promise<{ delta: number; gamma: number }> {
    const bumpRel = opts.priceBumpRel ?? DEFAULT_PRICE_BUMP_REL
    const maxILf = toFloat(position.maxIL)

    // Capped payoff at price-ratio P/P0 (WAD). computeIL is `pure` → readContract.
    const payoutAtRatio = async (ratioWad: bigint): Promise<number> => {
      const sqrtPT = sqrtPForRatio(position.sqrtP0X96, ratioWad)
      const il = await this.client.readContract({
        address: this.addrs.ilMath,
        abi: ilMathAbi,
        functionName: 'computeIL',
        args: [
          sqrtPT,
          position.sqrtPaX96,
          position.sqrtPbX96,
          position.liquidity,
          position.amount0Entry,
          position.amount1Entry,
        ],
      })
      const ilf = toFloat(il)
      return ilf > maxILf ? maxILf : ilf // min(IL, MaxIL)
    }

    // Central difference around P0 (ratio = 1.0). Use a real price-fraction bump.
    const up = BigInt(Math.round((1 + bumpRel) * 1e18))
    const dn = BigInt(Math.round((1 - bumpRel) * 1e18))
    const [pUp, p0, pDn] = await Promise.all([
      payoutAtRatio(up),
      payoutAtRatio(WAD),
      payoutAtRatio(dn),
    ])

    // dP in (price-ratio) units; P0 = 1.0 so the relative bump IS the absolute
    // step in ratio space. Greeks are reported per unit price-RATIO (dimensionless
    // in P/P0), which is the natural, decimals-independent convention.
    const dP = bumpRel
    const delta = (pUp - pDn) / (2 * dP)
    const gamma = (pUp - 2 * p0 + pDn) / (dP * dP)
    return { delta, gamma }
  }

  // ── vol greeks: finite-difference fairRate·MaxIL in σ (vega) and T (theta) ──

  private async volGreeks(
    position: PositionGeometry,
    durationSeconds: bigint,
    sigmaRefWad: bigint,
    opts: GreeksOptions,
  ): Promise<{ vega: number; theta: number }> {
    const maxILf = toFloat(position.maxIL)
    const sigmaBump = opts.sigmaBumpWad ?? DEFAULT_SIGMA_BUMP_WAD
    const durBumpRel = opts.durationBumpRel ?? DEFAULT_DURATION_BUMP_REL

    // fair premium (USDC raw, float) = fairRate(a,b,σ,T)·MaxIL/WAD.
    const premiumAt = async (sigma: bigint, dur: bigint): Promise<number> => {
      const rate = await this.client.readContract({
        address: this.addrs.fairValueOracle,
        abi: fairValueOracleAbi,
        functionName: 'fairRate',
        args: [position.aWad, position.bWad, sigma, dur],
      })
      // premium = rate(WAD) · MaxIL / WAD ; cap at MaxIL (a fairRate ≤ 1 holds in-range).
      const prem = (toFloat(rate) / toFloat(WAD)) * maxILf
      return prem > maxILf ? maxILf : prem
    }

    // vega = ∂Premium/∂σ, central difference in σ. Reported per unit σ (per 1.0 vol).
    const sUp = sigmaRefWad + sigmaBump
    const sDn = sigmaRefWad > sigmaBump ? sigmaRefWad - sigmaBump : 0n
    const [vUp, vDn] = await Promise.all([
      premiumAt(sUp, durationSeconds),
      premiumAt(sDn, durationSeconds),
    ])
    const dSigma = toFloat(sUp - sDn) / toFloat(WAD)
    const vega = dSigma > 0 ? (vUp - vDn) / dSigma : 0

    // theta = ∂Premium/∂T (per YEAR). FD in seconds, then scale to per-year.
    const durBumpSec = BigInt(Math.max(1, Math.round(toFloat(durationSeconds) * durBumpRel)))
    const tUp = durationSeconds + durBumpSec
    const tDn = durationSeconds > durBumpSec ? durationSeconds - durBumpSec : 0n
    const [pTUp, pTDn] = await Promise.all([
      premiumAt(sigmaRefWad, tUp),
      premiumAt(sigmaRefWad, tDn),
    ])
    const dTsec = toFloat(tUp - tDn)
    const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
    const theta = dTsec > 0 ? ((pTUp - pTDn) / dTsec) * SECONDS_PER_YEAR : 0

    return { vega, theta }
  }
}

// ─── HedgeSuggester ────────────────────────────────────────────────────────────

export interface SuggestHedgeOptions extends GreeksOptions {
  /** Which on-chain inverse venue to suggest (default Panoptic). */
  venue?: 'panoptic' | 'gammaswap'
  /** Delta-overlay instrument (default 'perp'). */
  overlayInstrument?: 'perp' | 'spot'
  /** Number of strikes in the replication strip (default 8). */
  stripStrikes?: number
}

/** A single position OR a book (array) the suggester can hedge. */
export type HedgeInput =
  | { position: PositionGeometry; durationSeconds: bigint; sigmaRefWad: bigint }
  | ReadonlyArray<{ position: PositionGeometry; durationSeconds: bigint; sigmaRefWad: bigint }>

export class HedgeSuggester {
  private readonly engine: GreeksEngine
  private readonly client: PublicClient
  private readonly addrs: HedgeAddresses

  constructor(client: PublicClient, addrs?: Partial<HedgeAddresses>) {
    this.client = client
    const d = defaultAddresses()
    this.addrs = {
      ilMath: addrs?.ilMath ?? d.ilMath,
      fairValueOracle: addrs?.fairValueOracle ?? d.fairValueOracle,
    }
    this.engine = new GreeksEngine(client, this.addrs)
  }

  /**
   * Suggest an APPROXIMATE static hedge for a single position or a whole book.
   *
   * Returns a `HedgeSuggestion` with the three required legs + the verbatim
   * caveat. On a degraded read it still returns a structurally-valid suggestion
   * with an empty `strip` and zero overlay (so a caller never crashes) — the
   * caveat always attaches. Use `suggestHedgeChecked` for the explicit
   * `Priceable` envelope when you want to branch on degradation.
   */
  async suggestHedge(input: HedgeInput, opts: SuggestHedgeOptions = {}): Promise<HedgeSuggestion> {
    const checked = await this.suggestHedgeChecked(input, opts)
    if (checked.priceable) return checked.suggestion
    // Degraded: return a structurally-valid, empty hedge — never throw.
    return {
      strip: [],
      onChainInverse: this.emptyInverse(opts.venue ?? 'panoptic'),
      deltaOverlay: { instrument: opts.overlayInstrument ?? 'perp', side: 'long', size: 0 },
      caveat: HEDGE_CAVEAT,
    }
  }

  /** Like `suggestHedge` but returns a `Priceable` envelope so callers can branch
   *  on degradation (e.g. an unreachable oracle). Never throws. */
  async suggestHedgeChecked(
    input: HedgeInput,
    opts: SuggestHedgeOptions = {},
  ): Promise<Priceable<{ suggestion: HedgeSuggestion }>> {
    const items = Array.isArray(input) ? input : [input]
    if (items.length === 0) {
      return {
        priceable: true,
        suggestion: {
          strip: [],
          onChainInverse: this.emptyInverse(opts.venue ?? 'panoptic'),
          deltaOverlay: { instrument: opts.overlayInstrument ?? 'perp', side: 'long', size: 0 },
          caveat: HEDGE_CAVEAT,
        },
      }
    }

    try {
      // 1) strip — Carr-Madan / Breeden-Litzenberger discretisation of the convex
      //    capped payoff (summed across the book on a common grid).
      const strip = await this.replicationStrip(items, opts)

      // 2) onChainInverse — the inverse long-gamma range (book-aggregate edges).
      const onChainInverse = this.inverseRange(items, opts)

      // 3) deltaOverlay — residual delta after legs 1+2, from book greeks.
      const book = await this.engine.bookGreeks(items, opts)
      const overlay = this.deltaOverlayFromGreeks(book.greeks, opts)

      return {
        priceable: true,
        suggestion: { strip, onChainInverse, deltaOverlay: overlay, caveat: HEDGE_CAVEAT },
      }
    } catch (e) {
      return {
        priceable: false,
        reason: 'oracle-degraded',
        detail: e instanceof Error ? e.message : String(e),
      }
    }
  }

  // ── leg 1: vanilla long-gamma replication strip (Carr-Madan / BL) ───────────
  // The convex payoff f(P) = min(IL(P), MaxIL) is replicated by a strike ladder.
  // Breeden-Litzenberger: the density of options needed at strike K is the second
  // derivative f''(K). We discretise f over a price grid (from computeIL) and read
  // off the second differences as per-strike option notionals. The IL payoff is
  // convex with two wings (below Pa it pays on the down move ⇒ puts; above Pb on the
  // up move ⇒ calls), so each strike gets the natural option TYPE for its side.

  private async replicationStrip(
    items: ReadonlyArray<{ position: PositionGeometry }>,
    opts: SuggestHedgeOptions,
  ): Promise<HedgeLeg[]> {
    const strikes = Math.max(3, opts.stripStrikes ?? 8)
    const gridPts = Math.max(strikes + 2, opts.points ?? DEFAULT_POINTS)

    // Aggregate the capped payoff across the book on a SHARED price-ratio grid in
    // [a_min, b_max] (ratio = P/P0). Each position contributes its own computeIL.
    let aMin = Number.POSITIVE_INFINITY
    let bMax = Number.NEGATIVE_INFINITY
    for (const { position } of items) {
      aMin = Math.min(aMin, toFloat(position.aWad) / toFloat(WAD))
      bMax = Math.max(bMax, toFloat(position.bWad) / toFloat(WAD))
    }
    if (!Number.isFinite(aMin) || !Number.isFinite(bMax) || bMax <= aMin) return []

    // Build the grid (ratio space).
    const grid: number[] = []
    for (let i = 0; i < gridPts; i++) {
      grid.push(aMin + ((bMax - aMin) * i) / (gridPts - 1))
    }

    // Capped book payoff at each grid ratio.
    const payoff: number[] = []
    for (const ratio of grid) {
      const ratioWad = BigInt(Math.round(ratio * 1e18))
      let sum = 0
      for (const { position } of items) {
        const sqrtPT = sqrtPForRatio(position.sqrtP0X96, ratioWad)
        const il = await this.client.readContract({
          address: this.addrs.ilMath,
          abi: ilMathAbi,
          functionName: 'computeIL',
          args: [
            sqrtPT,
            position.sqrtPaX96,
            position.sqrtPbX96,
            position.liquidity,
            position.amount0Entry,
            position.amount1Entry,
          ],
        })
        const ilf = toFloat(il)
        const maxILf = toFloat(position.maxIL)
        sum += ilf > maxILf ? maxILf : ilf
      }
      payoff.push(sum)
    }

    // Second differences → BL density. Pick `strikes` evenly-spaced interior nodes.
    const legs: HedgeLeg[] = []
    const stepIdx = Math.max(1, Math.floor((gridPts - 2) / strikes))
    const h = (bMax - aMin) / (gridPts - 1)
    for (let i = 1; i < gridPts - 1; i += stepIdx) {
      const f2 = (payoff[i + 1]! - 2 * payoff[i]! + payoff[i - 1]!) / (h * h)
      const notional = f2 * h // density × strike spacing = option count at this node
      if (notional <= 1e-9) continue // skip flat (capped / OTM-flat) regions
      const strike = grid[i]!
      // Below P0 (ratio<1): the down-move IL wing → puts. Above: calls.
      const type: 'call' | 'put' = strike < 1 ? 'put' : 'call'
      legs.push({ strike, type, notional })
      if (legs.length >= strikes) break
    }
    return legs
  }

  // ── leg 2: inverse on-chain long-gamma range ────────────────────────────────
  // The MM is SHORT the LP's in-range convexity; the offsetting on-chain position
  // is a LONG-gamma range over the same [Pa, Pb] (e.g. a Panoptic long strangle /
  // a GammaSwap borrowed-LP position). We surface the book-aggregate range + a
  // size proxy from total liquidity (the MM right-sizes against funding).

  private inverseRange(
    items: ReadonlyArray<{ position: PositionGeometry }>,
    opts: SuggestHedgeOptions,
  ): OnChainInverse {
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    let sizeL = 0
    for (const { position } of items) {
      low = Math.min(low, toFloat(position.aWad) / toFloat(WAD))
      high = Math.max(high, toFloat(position.bWad) / toFloat(WAD))
      sizeL += toFloat(position.liquidity)
    }
    if (!Number.isFinite(low) || !Number.isFinite(high))
      return this.emptyInverse(opts.venue ?? 'panoptic')
    const venue = opts.venue ?? 'panoptic'
    return {
      venue,
      direction: 'long-gamma',
      rangeLow: low,
      rangeHigh: high,
      sizeL,
      note:
        `Inverse long-gamma range over [Pa/P0=${low.toFixed(4)}, Pb/P0=${high.toFixed(4)}] ` +
        `on ${venue}; size proxy = Σ position liquidity (${sizeL}). APPROXIMATE — see caveat.`,
    }
  }

  private emptyInverse(venue: 'panoptic' | 'gammaswap'): OnChainInverse {
    return {
      venue,
      direction: 'long-gamma',
      rangeLow: 0,
      rangeHigh: 0,
      sizeL: 0,
      note: 'No priceable geometry — inverse range unavailable (degraded read).',
    }
  }

  // ── leg 3: residual delta overlay ───────────────────────────────────────────
  // After legs 1+2 the MM flattens the book delta with a perp/spot. The MM is
  // SHORT the convexity claim, so its book delta is the NEGATIVE of the claim's
  // delta; the overlay takes the OPPOSITE side to flatten it.

  private deltaOverlayFromGreeks(g: Greeks, opts: SuggestHedgeOptions): DeltaOverlay {
    const instrument = opts.overlayInstrument ?? 'perp'
    // claim delta = g.delta (long, from the LP's perspective). MM is short the
    // claim ⇒ MM book delta = −g.delta. To flatten, trade +g.delta of the
    // underlying: side = sign(g.delta) (positive delta ⇒ buy/long underlying).
    const mmBookDelta = -g.delta
    const hedgeDelta = -mmBookDelta // = g.delta
    const side: 'long' | 'short' = hedgeDelta >= 0 ? 'long' : 'short'
    return { instrument, side, size: Math.abs(hedgeDelta) }
  }
}

// ─── executeOnPanoptic — READ-ONLY (analytics only; never sends a tx) ─────────

/** The plan an MM would execute on Panoptic — produced read-only. This function
 *  deliberately returns ONLY a description; it NEVER builds or sends a tx (the
 *  hedge is the MM's own residual-risk choice, NOT a protocol action — I1 is
 *  structural and does not depend on it). */
export interface PanopticPlan {
  /** Always false — this surface is analytics-only by design. */
  executed: false
  venue: 'panoptic'
  direction: 'long-gamma'
  rangeLow: number
  rangeHigh: number
  sizeL: number
  caveat: string
  note: string
}

/** Produce a READ-ONLY Panoptic execution plan from a hedge suggestion. Never
 *  submits a transaction — analytics only (spec §3.5: hedge execution is read-only). */
export function executeOnPanoptic(suggestion: HedgeSuggestion): PanopticPlan {
  const inv = suggestion.onChainInverse
  return {
    executed: false,
    venue: 'panoptic',
    direction: 'long-gamma',
    rangeLow: inv.rangeLow,
    rangeHigh: inv.rangeHigh,
    sizeL: inv.sizeL,
    caveat: suggestion.caveat,
    note:
      'READ-ONLY plan. This SDK does not execute on-chain hedges — it returns the ' +
      'inverse long-gamma range the MM may choose to open on Panoptic. Not relied ' +
      'on for solvency (I1 is structural).',
  }
}
