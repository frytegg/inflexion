/**
 * Shared SDK types. The surface modules (LpClient/DepositorClient/MmClient/
 * DataClient/GreeksEngine) import these so every result has a concrete shape.
 *
 * GRACEFUL DEGRADATION is a first-class property: reads that can fail (a reverting
 * oracle, an absent rich event, a missing subgraph/API) return a typed degraded
 * result — `Degraded<T>` or a `{ priceable:false, reason }` / `{ available:false,
 * reason }` shape — never throw the whole call.
 */
import type { Address, Hex } from 'viem'

// ─── WAD / units note ───────────────────────────────────────────────────────
// `*Wad` = 1e18-scaled fixed point (1e18 = 1.0). USDC amounts are 6-decimal
// raw integers (bigint). Prices are oracle-feed-decimal raw integers unless a
// field says `Wad`. sqrtPriceX96 is the Uniswap Q64.96 sqrt price.

// ─── Degradation envelopes ──────────────────────────────────────────────────

/** A value that may be degraded (rich source absent). Discriminate on `available`. */
export type Degraded<T> = ({ available: true } & T) | { available: false; reason: string }

/** Reasons a degraded result can carry (typed so callers can branch). */
export type DegradeReason =
  /** The on-chain OracleManager.getPrice reverted (stale feed / sequencer down). */
  | 'oracle-degraded'
  /** No RPC transport was reachable (env unset, network error). */
  | 'no-rpc'
  /** The rich QuoteFilled/SwapPriced events are live on-chain but not yet indexed
   *  (the subgraph that would give precise attribution is not yet deployed). */
  | 'rich-events-absent'
  /** The subgraph / API endpoint is not wired. */
  | 'no-history-source'
  /** The VolOracle has not been initialized for this token. */
  | 'vol-uninitialized'
  /** The market id is unknown / not registered / inactive. */
  | 'market-unknown'
  /** The token id is not a recognised/active position for this surface. */
  | 'position-unknown'

/** A typed "this read could not be priced" envelope (LP/MM reads needing P0). */
export interface NotPriceable {
  priceable: false
  reason: DegradeReason
  detail?: string
}

/** A successfully priced result wrapper. */
export type Priceable<T> = ({ priceable: true } & T) | NotPriceable

// ─── On-chain config mirrors ────────────────────────────────────────────────

/** Decoded `InflexionCore.markets(marketId)` tuple. */
export interface MarketConfig {
  marketId: Hex
  token0: Address
  token1: Address
  fee: number
  durationSeconds: number
  oracleToken: Address
  token0Decimals: number
  token1Decimals: number
  oracleDecimals: number
  active: boolean
}

/** Decoded `InflexionCore.loadParams()` / `CvammPricing.LoadParams`. All bps are
 *  integers; all `*Wad` are 1e18-scaled. */
export interface LoadParams {
  baseLoadCalmBps: bigint
  baseLoadNormalBps: bigint
  baseLoadStressedBps: bigint
  regimeCalmBelowWad: bigint
  regimeStressedAtWad: bigint
  utilKneeWad: bigint
  utilSlopeWad: bigint
  utilPowerWad: bigint
  utilCapWad: bigint
  dispSlopeWad: bigint
  dispPowerWad: bigint
  dispCapWad: bigint
  maxLoadBps: bigint
}

/** Pool inventory snapshot — `ConvexityVault.inventory()`. */
export interface Inventory {
  totalAssets: bigint
  locked: bigint
  free: bigint
  utilWad: bigint
  concWad: bigint
}

/** Vol regime derived from σ_ref vs the loadParams regime bands (NOT sigmaComponents.binding). */
export type Regime = 'calm' | 'normal' | 'stressed'

/** σ_ref components — `VolOracle.sigmaComponents()`. `binding` is which EWMA window
 *  binds (0=short,1=long,2=floor) — distinct from the load `regime`. */
export interface SigmaComponents {
  sigmaShortWad: bigint
  sigmaLongWad: bigint
  floorWad: bigint
  /** Which input binds σ_ref: 0=short EWMA, 1=long EWMA, 2=floor. */
  binding: 0 | 1 | 2
}

// ─── Pricing ────────────────────────────────────────────────────────────────

/** The cvAMM load stack broken into components + I10-clamped total (all WAD). */
export interface LoadBreakdown {
  baseLoadWad: bigint
  utilSkewWad: bigint
  dispSkewWad: bigint
  /** I10-clamped sum (≤ maxLoadBps in WAD). */
  totalLoadWad: bigint
}

/** Live market pricing — the MM/LP "fair + pool floor" composite (one multicall). */
export interface MarketPricing {
  marketId: Hex
  /** FairPremium (USDC raw) for the supplied geometry — from the Stylus FVO. */
  fairPremium: bigint
  /** fairRate (WAD) — `FairPremium / MaxIL`. */
  fairRateWad: bigint
  /** σ_ref (WAD) the fair value was computed against. */
  sigmaRefWad: bigint
  /** Path-A pool premium = ceil(FairPremium·(1+totalLoad)), capped at MaxIL (USDC raw). */
  poolPremium: bigint
  /** MaxIL (USDC raw) for the geometry. */
  maxIL: bigint
  /** Pool load stack (the price-to-beat decomposition). */
  load: LoadBreakdown
  util: bigint
  conc: bigint
  /** Vol regime (calm/normal/stressed) from σ_ref vs the loadParams bands. */
  regime: Regime
}

/** Position geometry → pricing inputs (the helper every surface depends on). */
export interface PositionGeometry {
  tokenId: bigint
  token0: Address
  token1: Address
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  sqrtPaX96: bigint
  sqrtPbX96: bigint
  /** Entry sqrt price pinned from the oracle (only present when priceable). */
  sqrtP0X96: bigint
  /** a = (sqrtPa/sqrtP0)² (WAD). */
  aWad: bigint
  /** b = (sqrtPb/sqrtP0)² (WAD). */
  bWad: bigint
  /** Entry token amounts at P0 (raw wei). */
  amount0Entry: bigint
  amount1Entry: bigint
  maxIL: bigint
  /** Position value in token1 (numéraire) units at entry. */
  V0: bigint
}

/** LP premium preview — best of {pool A, MM B}. `premiumB`/`path` present iff an MM quote was used. */
export interface PreviewResult {
  marketId: Hex
  maxIL: bigint
  fairPremium: bigint
  fairRateWad: bigint
  sigmaRefWad: bigint
  premiumA: bigint
  premiumB?: bigint
  /** The cheaper of the two (the LP-facing price). */
  best: bigint
  /** Which rail won. */
  path: 'A' | 'B'
}

// ─── Vault / depositor ──────────────────────────────────────────────────────

export type Tranche = 'senior' | 'junior'

/** `ConvexityVault.Tranche` on-chain enum value for a tranche label. */
export const TRANCHE_ENUM: Record<Tranche, number> = { senior: 0, junior: 1 }

/** Fine pool state — the DEP-1/DEP-6 composite (claim B surface). */
export interface VaultState {
  totalAssets: bigint
  seniorAssets: bigint
  juniorAssets: bigint
  totalLocked: bigint
  freeAssets: bigint
  utilWad: bigint
  concWad: bigint
  /** Both skews separately (the DEP-6 ask), from the TS load-stack port. */
  baseLoadWad: bigint
  utilSkewWad: bigint
  dispSkewWad: bigint
  totalLoadWad: bigint
  lockedByMarket: Record<string, bigint>
  sigmaRefWad: bigint
  regime: Regime
  /** Annualised instantaneous yield — needs subgraph; `undefined` from live SDK. */
  instYieldWad?: bigint
  /** CLAIM (B): depositor capital is NOT guaranteed (junior first-loss; senior systemic-tail). */
  capitalNotGuaranteed: true
}

/** A pending withdrawal request. */
export interface WithdrawRequest {
  shares: bigint
  unlockAt: bigint
  secondsRemaining: bigint
}

/** Depositor position — shares/assets/withdrawal queue per tranche. */
export interface DepositorPosition {
  seniorShares: bigint
  juniorShares: bigint
  seniorAssets: bigint
  juniorAssets: bigint
  seniorWithdraw?: WithdrawRequest
  juniorWithdraw?: WithdrawRequest
  capitalNotGuaranteed: true
}

// ─── Protection status (LP) ─────────────────────────────────────────────────

/** Live protection status of an active/settled swap. */
export interface ProtectionStatus {
  swapId: bigint
  lp: Address
  mm: Address
  /** True iff `mm == convexityVault` (Path A pool) — else Path B (an MM). */
  isPathA: boolean
  premiumPaid: bigint
  maxIL: bigint
  V0: bigint
  createdAt: bigint
  expiry: bigint
  secondsToExpiry: bigint
  /** 0=UNINITIALIZED,1=ACTIVE,2=SETTLED. */
  status: number
  /** IL to date (settlePreview at the live price) — degraded if oracle reverts. */
  ilToDate: Priceable<{ il: bigint; payout: bigint; capHit: boolean }>
  /** CLAIM (A): LPs are always paid (no bad debt in FULL, I1) — qualified. */
  noBadDebtFull: true
}

// ─── Payoff curve / greeks (LP + MM) ────────────────────────────────────────

export interface PayoffPoint {
  priceWad: bigint
  sqrtPTX96: bigint
  /** Capped payout at this terminal price (USDC raw). */
  payout: bigint
  /** Uncapped realised IL at this terminal price (USDC raw). */
  il: bigint
}

export interface PayoffCurve {
  points: PayoffPoint[]
  maxIL: bigint
  /** Lower range edge price (Pa) in WAD. */
  edgeLowWad: bigint
  /** Upper range edge price (Pb) in WAD. */
  edgeHighWad: bigint
  /** Entry price P0 in WAD. */
  p0Wad: bigint
}

/** Position greeks of the capped IL claim (the MM is short this convexity). */
export interface Greeks {
  /** ∂Payout/∂P0 (per unit price). */
  delta: number
  /** ∂²Payout/∂P0². */
  gamma: number
  /** ∂Payout/∂σ (per unit vol). */
  vega: number
  /** ∂Payout/∂T (per year). */
  theta: number
}

// ─── Hedging (MM, read-only analytics) ──────────────────────────────────────

export interface HedgeLeg {
  strike: number
  type: 'call' | 'put'
  notional: number
}

export interface OnChainInverse {
  venue: 'panoptic' | 'gammaswap'
  direction: 'long-gamma'
  rangeLow: number
  rangeHigh: number
  sizeL: number
  note: string
}

export interface DeltaOverlay {
  instrument: 'perp' | 'spot'
  side: 'long' | 'short'
  size: number
}

export interface HedgeSuggestion {
  strip: HedgeLeg[]
  onChainInverse: OnChainInverse
  deltaOverlay: DeltaOverlay
  /** Always attached, verbatim — the hedge is APPROXIMATE and NOT relied on for I1. */
  caveat: string
}

// ─── MM fill attribution ────────────────────────────────────────────────────

/** Coarse fill status — `isNonceUsed` is true on BOTH fill and cancel, so the
 *  direct-on-chain read cannot distinguish them. */
export interface NonceStatus {
  mm: Address
  nonce: bigint
  /** True iff the bitmap bit is set — i.e. filled OR cancelled (cannot distinguish live). */
  spent: boolean
  /** Always 'coarse' from the direct on-chain read (`isNonceUsed`). Precise
   *  attribution (via the now-live `QuoteFilled`) becomes available once the
   *  subgraph is deployed to index it. */
  precision: 'coarse' | 'precise'
  detail: string
}
