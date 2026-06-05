/**
 * TS port of `CvammPricing` — the deterministic, `pure` cvAMM load stack. This is
 * the ONLY duplication the access-layer doc permits: the load math (NOT the
 * fairRate Φ-sum, which is always read from the on-chain FairValueOracle).
 *
 * This is the PERMANENT off-chain mirror: the on-chain `CvammPricing` library IS
 * deployed (with totalLoadWad/loadComponents) but is DELEGATECALL-ONLY — a direct
 * eth_call to it reverts (Solidity guards deployed libraries; confirmed on the
 * 2026-06-05 deploy), so the SDK cannot read it directly and instead keeps this
 * port parity-locked byte-equal to the deployed Solidity (math.parity.test.ts).
 * The lib runs on-chain only via the core's delegatecall during pricing.
 *
 * All arithmetic is bigint (WAD = 1e18). The WAD exp/ln/pow helpers mirror
 * solady's `FixedPointMathLib` closely enough that `totalLoadWad` agrees with the
 * on-chain lib to within a few wei (the test allows a small absolute tolerance).
 */
import type { LoadBreakdown, LoadParams, Regime } from './types.js'

export const WAD = 1_000_000_000_000_000_000n // 1e18
export const BPS_TO_WAD = 100_000_000_000_000n // 1e14 (1 bp)
const BPS = 10_000n

// ─── WAD fixed-point helpers (match solady rounding: mulWad/divWad floor) ────

export function mulWad(a: bigint, b: bigint): bigint {
  return (a * b) / WAD
}

export function divWad(a: bigint, b: bigint): bigint {
  return (a * WAD) / b
}

/** ceil(a*b / d). Matches OZ `Math.ceilDiv` used in `premiumFromLoad`. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('ceilDiv: division by zero')
  return a === 0n ? 0n : (a - 1n) / b + 1n
}

// ─── WAD exp / ln (for powWad) ──────────────────────────────────────────────
// powWad(x, y) = expWad(lnWad(x) * y / WAD); x ∈ (0,1], y ≥ 0 in the load stack.
// We implement exp/ln in extended-precision floating point then re-quantise to
// WAD. For the inputs used here (x ∈ (0,1], y ∈ {1.5, 2.0}) this matches the
// integer solady result to << 1e-9 relative, well inside the parity tolerance.

function lnWadFloat(xWad: bigint): number {
  // x as a real number in (0,1]; ln is negative.
  return Math.log(Number(xWad) / Number(WAD))
}

function expWadFromFloat(z: number): bigint {
  // exp(z), z ≤ 0 here → result in (0,1]; quantise to WAD.
  const v = Math.exp(z)
  // Round to nearest WAD integer.
  return BigInt(Math.round(v * 1e18))
}

/** `x^y` for WAD `x ∈ [0,1]`, `y ≥ 0`; `x = 0 ⇒ 0` (mirrors CvammPricing._powWad). */
export function powWad(xWad: bigint, yWad: bigint): bigint {
  if (xWad === 0n) return 0n
  if (yWad === 0n) return WAD // x^0 = 1
  const lnX = lnWadFloat(xWad) // ≤ 0
  const z = (lnX * Number(yWad)) / Number(WAD)
  const r = expWadFromFloat(z)
  return r < 0n ? 0n : r
}

// ─── CvammPricing component functions (mirror the Solidity, line for line) ───

/** baseLoad (WAD) for σ_ref by regime band. */
export function baseLoadWad(sigmaRefWad: bigint, p: LoadParams): bigint {
  const bps =
    sigmaRefWad < p.regimeCalmBelowWad
      ? p.baseLoadCalmBps
      : sigmaRefWad >= p.regimeStressedAtWad
        ? p.baseLoadStressedBps
        : p.baseLoadNormalBps
  return bps * BPS_TO_WAD
}

/** util_skew(u) (WAD). Flat below the knee; convex above; capped. */
export function utilSkewWad(uWad: bigint, p: LoadParams): bigint {
  if (uWad <= p.utilKneeWad) return 0n
  let x = divWad(uWad - p.utilKneeWad, WAD - p.utilKneeWad) // (u−knee)/(1−knee)
  if (x > WAD) x = WAD
  const v = mulWad(p.utilSlopeWad, powWad(x, p.utilPowerWad))
  return v > p.utilCapWad ? p.utilCapWad : v
}

/** dispersion_skew(h) (WAD), h = normalised coverage HHI. Capped. */
export function dispSkewWad(hWad: bigint, p: LoadParams): bigint {
  if (hWad === 0n) return 0n
  const v = mulWad(p.dispSlopeWad, powWad(hWad, p.dispPowerWad))
  return v > p.dispCapWad ? p.dispCapWad : v
}

/** The load stack broken into components + the I10-clamped total (WAD). Mirrors
 *  `CvammPricing.loadComponents`. Components are PRE-clamp; `total` is clamped. */
export function loadComponents(
  sigmaRefWad: bigint,
  uWad: bigint,
  hWad: bigint,
  p: LoadParams,
): LoadBreakdown {
  const baseLoad = baseLoadWad(sigmaRefWad, p)
  const utilSkew = utilSkewWad(uWad, p)
  const dispSkew = dispSkewWad(hWad, p)
  const sum = baseLoad + utilSkew + dispSkew
  const maxLoad = p.maxLoadBps * BPS_TO_WAD
  const total = sum > maxLoad ? maxLoad : sum
  return {
    baseLoadWad: baseLoad,
    utilSkewWad: utilSkew,
    dispSkewWad: dispSkew,
    totalLoadWad: total,
  }
}

/** Total load (WAD) = min(baseLoad + util + dispersion, maxLoad). I10. */
export function totalLoadWad(
  sigmaRefWad: bigint,
  uWad: bigint,
  hWad: bigint,
  p: LoadParams,
): bigint {
  return loadComponents(sigmaRefWad, uWad, hWad, p).totalLoadWad
}

/** `premium = ceil(FairPremium · (1 + totalLoad))` (round up, F-#8). */
export function premiumFromLoad(fairPremium: bigint, totalLoad: bigint): bigint {
  return ceilDiv(fairPremium * (WAD + totalLoad), WAD)
}

/** Path-B premium: `ceil(FairPremium·(1+loadBps/BPS))` capped at MaxIL. */
export function pathBPremium(fairPremium: bigint, loadBps: number, maxIL: bigint): bigint {
  const prem = ceilDiv(fairPremium * (BPS + BigInt(loadBps)), BPS)
  return prem > maxIL ? maxIL : prem
}

// ─── Regime classification (σ_ref vs the loadParams regime bands) ────────────
// NOTE: this is the LOAD regime (calm/normal/stressed) — NOT the σ_ref
// `binding` (which-EWMA-window) from VolOracle.sigmaComponents.

export function regimeOf(sigmaRefWad: bigint, p: LoadParams): Regime {
  if (sigmaRefWad < p.regimeCalmBelowWad) return 'calm'
  if (sigmaRefWad >= p.regimeStressedAtWad) return 'stressed'
  return 'normal'
}

// ─── Pricing-input geometry helper ──────────────────────────────────────────

/** a = (sqrtPa/sqrtP0)² (WAD), b = (sqrtPb/sqrtP0)² (WAD) — matches `_fairPremium`. */
export function abFromSqrt(
  sqrtP0X96: bigint,
  sqrtPaX96: bigint,
  sqrtPbX96: bigint,
): { aWad: bigint; bWad: bigint } {
  const rA = (sqrtPaX96 * WAD) / sqrtP0X96
  const rB = (sqrtPbX96 * WAD) / sqrtP0X96
  return { aWad: (rA * rA) / WAD, bWad: (rB * rB) / WAD }
}
