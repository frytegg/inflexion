/**
 * `MmClient` — the market-maker surface (MM-1 … MM-9). First-class, streamable,
 * graceful-degrading. Built ENTIRELY on the foundation (addresses, abis, client,
 * types, decode, resolveMarket, math) + the re-exported EIP-712 quote helpers.
 *
 * Design rules honoured (from CLAUDE.md + docs/ACCESS_LAYER_ARCHITECTURE.md, with
 * the documented corrections applied):
 *
 *  - Pricing: `fairPremium`/`fairRate`/`sigmaRef` are READ from the on-chain
 *    Stylus `FairValueOracle` + `VolOracle`. The Φ-sum is NEVER reimplemented.
 *  - The pool "load to beat" is `CvammPricing.totalLoadWad(sigmaRef, util, conc,
 *    loadParams)`. The geometry-INDEPENDENT total load (in bps) is THE first-class
 *    streamable signal — `streamPoolLoadToBeat`. The canonical total AND the
 *    per-component skews (baseLoad / utilSkew / dispSkew) come from the parity-
 *    locked TS port (`cvamm`), which is byte-equal to the deployed Solidity
 *    (math.parity.test.ts). The on-chain `CvammPricing` library IS deployed (with
 *    totalLoadWad/loadComponents) but is DELEGATECALL-ONLY — a direct eth_call to
 *    it reverts — so the TS port is the PERMANENT off-chain mirror, not an interim;
 *    the lib runs on-chain only via the core's delegatecall during pricing.
 *  - regime = σ_ref vs `loadParams.regimeCalmBelowWad`/`regimeStressedAtWad`
 *    (NOT `sigmaComponents.binding`, which is which-EWMA-window-binds).
 *  - resolveMarket(swapId): SwapRecord has NO marketId — recovered via the shared
 *    `resolveMarket` helper.
 *  - `signQuote` is re-exported from `@inflexion/engine/quote` (never reimplemented)
 *    and asserts `loadBps ≤ maxLoadBps` (I10) AND `loadBps < live pool-load-bps`.
 *  - MM fill attribution from the DIRECT on-chain read is COARSE:
 *    `SwapCreated`/`SwapRouted` do NOT carry quoteId/nonce, and `isNonceUsed` is
 *    true on BOTH fill and cancel → `isQuoteFilled` returns a typed `NonceStatus`
 *    with `precision:'coarse'`, never a precise filled/cancelled distinction. The
 *    precise path is the now-live `QuoteFilled` event (emitted on-chain since the
 *    2026-06-05 deploy), but it needs indexing — available once the subgraph is
 *    deployed. Path is inferable everywhere via `mm == convexityVault` (Path A)
 *    else Path B.
 *
 * GRACEFUL DEGRADATION is first-class: every method that needs a reverting read
 * (oracle stale / vol-uninitialized / out-of-range geometry / absent WS) returns a
 * typed degraded result (`{ priceable:false, reason }` / `{ available:false,
 * reason }` / `precision:'coarse'`), NEVER throws on a missing event/getter/API.
 */
import {
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {
  convexityVaultAbi,
  fairValueOracleAbi,
  ilMathAbi,
  inflexionCoreAbi,
  npmAbi,
  oracleManagerAbi,
  underwriterVaultAbi,
  volOracleAbi,
} from './abis.js'
import { core, libs, npm as npmAddr, stylus } from './addresses.js'
import { decodeLoadParams, decodeSwapRecord, type SwapRecord } from './decode.js'
import { computeMarketId, resolveMarket, type ResolvedMarket } from './resolveMarket.js'
import * as cvamm from './math.js'
import type {
  Greeks,
  LoadBreakdown,
  LoadParams,
  MarketConfig,
  NonceStatus,
  PositionGeometry,
  Regime,
  SigmaComponents,
} from './types.js'
import { signQuote as engineSignQuote } from './quote.js'
import type { QuoteEnvelope, SignedQuote } from './quote.js'

// ─── Re-export (MM-6 escape hatch) ──────────────────────────────────────────
// The raw engine `signQuote` under a distinct name so MM code can reach the
// unguarded EIP-712 signer from the MM surface directly (the class method
// `MmClient.signQuote` adds the I10 + below-pool guards). NEVER reimplemented —
// single source of truth in `@inflexion/engine/quote`. The unaliased quote
// helpers (`signQuote`, `verifyQuote`, `SignedQuote`, …) are already re-exported
// by the SDK index via `./quote.js`, so we do NOT duplicate them here (avoids a
// name collision when the Integrate phase folds this module into the index).
export { signQuote as signQuoteRaw } from './quote.js'
export type { SignedQuote, QuoteEnvelope } from './quote.js'

// ─── Units helpers (WAD ⇄ bps) ───────────────────────────────────────────────

const WAD = cvamm.WAD // 1e18
const BPS = 10_000n
/** WAD → bps (floor). `0.05e18` → `500`. */
export function wadToBps(wad: bigint): bigint {
  return (wad * BPS) / WAD
}

// ─── Result envelopes specific to the MM surface ─────────────────────────────

/** A market-pricing snapshot (MM-1) or a typed reason it could not be priced. */
export type MarketPricingResult =
  | ({ available: true; marketId: Hex } & MmMarketPricing)
  | { available: false; marketId: Hex; reason: PricingDegradeReason; detail?: string }

export type PricingDegradeReason =
  | 'no-rpc'
  | 'market-unknown'
  | 'vol-uninitialized'
  | 'fair-premium-revert'
  | 'inventory-revert'

/** MM-1 pricing snapshot — fair value + the pool "load to beat", decomposed.
 *  (Named `MmMarketPricing` to avoid colliding with the foundation's
 *  `MarketPricing` type when this module is folded into the SDK index.) */
export interface MmMarketPricing {
  /** FairPremium (USDC raw, 6-dec) for the supplied geometry — Stylus FVO view. */
  fairPremium: bigint
  /** fairRate (WAD) = FairPremium / MaxIL — Stylus FVO view. */
  fairRateWad: bigint
  /** σ_ref (WAD) the fair value was computed against — VolOracle. */
  sigmaRefWad: bigint
  /** Path-A pool premium = ceil(FairPremium·(1+totalLoad)), capped at MaxIL. */
  poolPremium: bigint
  /** MaxIL (USDC raw) the geometry was priced against (the caller's input). */
  maxIL: bigint
  /** Pool load stack broken into components + I10-clamped total (WAD). */
  load: LoadBreakdown
  /** Total pool load in bps (the geometry-INDEPENDENT "load to beat"). */
  totalLoadBps: bigint
  baseLoadWad: bigint
  utilSkewWad: bigint
  dispSkewWad: bigint
  /** Pool utilization (WAD) — ConvexityVault.inventory. */
  util: bigint
  /** Pool concentration / HHI (WAD) — ConvexityVault.inventory. */
  conc: bigint
  /** Vol regime from σ_ref vs the loadParams bands (NOT sigmaComponents.binding). */
  regime: Regime
}

/** The geometry inputs the FairValueOracle consumes (a/b WAD + duration + MaxIL). */
export interface PricingGeometry {
  /** a = (sqrtPa/sqrtP0)² (WAD). */
  aWad: bigint
  /** b = (sqrtPb/sqrtP0)² (WAD). */
  bWad: bigint
  /** Protection duration (seconds). */
  durationSeconds: bigint
  /** MaxIL (USDC raw) the premium is priced against / capped at. */
  maxIL: bigint
  /** The oracle token (defaults to `market.oracleToken` when resolved). */
  oracleToken?: Address
}

/** Geometry-independent "load to beat" tick — the first-class streamable signal. */
export interface PoolLoadTick {
  marketId: Hex
  /** Snapshot timestamp (ms, client clock). */
  ts: number
  available: boolean
  /** σ_ref (WAD) — only present when available. */
  sigmaRefWad?: bigint
  util?: bigint
  conc?: bigint
  load?: LoadBreakdown
  /** The headline number: total pool load in bps. */
  totalLoadBps?: bigint
  regime?: Regime
  reason?: PricingDegradeReason | 'load-revert'
  detail?: string
}

/** A handle to a running stream (poll loop or WS). Call `stop()` to tear down. */
export interface StreamHandle {
  stop: () => void
}

// ─── MmClient options + construction ─────────────────────────────────────────

export interface MmClientOptions {
  /** viem public (read) client. Required for any on-chain read. */
  publicClient: PublicClient
  /** Optional wallet (write) client for cancelNonces (MM-9). */
  walletClient?: WalletClient
  /** Override core address (defaults to the registry). */
  coreAddress?: Address
  /** Override NPM address. */
  npmAddress?: Address
  /** Chain id for EIP-712 quote signing (defaults to the live chain). */
  chainId?: number
}

const DEFAULT_CHAIN_ID = 421614

export class MmClient {
  private readonly pub: PublicClient
  private readonly wallet?: WalletClient
  private readonly coreAddress: Address
  private readonly npmAddress: Address
  private readonly chainId: number

  /** loadParams is immutable post-freeze → cache after the first read. */
  private loadParamsCache?: LoadParams
  /** market configs are immutable → cache per marketId. */
  private readonly marketCache = new Map<string, MarketConfig>()

  constructor(opts: MmClientOptions) {
    this.pub = opts.publicClient
    if (opts.walletClient !== undefined) this.wallet = opts.walletClient
    this.coreAddress = opts.coreAddress ?? core.inflexionCore
    this.npmAddress = opts.npmAddress ?? npmAddr
    this.chainId = opts.chainId ?? DEFAULT_CHAIN_ID
  }

  // ─── loadParams / markets caches (read once; immutable post-freeze) ─────────

  /** `InflexionCore.loadParams()` decoded → cached. */
  async getLoadParams(): Promise<LoadParams> {
    if (this.loadParamsCache !== undefined) return this.loadParamsCache
    const t = await this.pub.readContract({
      address: this.coreAddress,
      abi: inflexionCoreAbi,
      functionName: 'loadParams',
    })
    const p = decodeLoadParams(t as Parameters<typeof decodeLoadParams>[0])
    this.loadParamsCache = p
    return p
  }

  /** `InflexionCore.markets(marketId)` decoded → cached. Returns `undefined`
   *  when the market is not registered (`token0 == address(0)`). */
  async getMarketConfig(marketId: Hex): Promise<MarketConfig | undefined> {
    const cached = this.marketCache.get(marketId.toLowerCase())
    if (cached !== undefined) return cached
    const t = await this.pub.readContract({
      address: this.coreAddress,
      abi: inflexionCoreAbi,
      functionName: 'markets',
      args: [marketId],
    })
    const cfg: MarketConfig = {
      marketId,
      token0: t[0],
      token1: t[1],
      fee: t[2],
      durationSeconds: t[3],
      oracleToken: t[4],
      token0Decimals: t[5],
      token1Decimals: t[6],
      oracleDecimals: t[7],
      active: t[8],
    }
    // address(0) token0 ⇒ unregistered market.
    if (cfg.token0 === '0x0000000000000000000000000000000000000000') return undefined
    this.marketCache.set(marketId.toLowerCase(), cfg)
    return cfg
  }

  // ─── MM-1: getMarketPricing — ONE multicall ────────────────────────────────

  /**
   * Fair value + the pool "load to beat" for a market+geometry in ONE multicall.
   *
   * Reads (allowFailure → graceful): `FairValueOracle.fairPremium`,
   * `ConvexityVault.inventory`, `VolOracle.sigmaRef`. `loadParams`/`markets` are
   * cached (immutable). The per-component skews come from the parity-tested TS
   * port (`cvamm.loadComponents`); the canonical clamped total is taken from the
   * SAME port (asserted byte-equal to the deployed `totalLoadWad` in the parity
   * test). Returns a typed degraded result on any revert — never throws.
   */
  async getMarketPricing(marketId: Hex, geometry: PricingGeometry): Promise<MarketPricingResult> {
    let cfg: MarketConfig | undefined
    try {
      cfg = await this.getMarketConfig(marketId)
    } catch (e) {
      return { available: false, marketId, reason: 'no-rpc', detail: errMsg(e) }
    }
    if (cfg === undefined) {
      return { available: false, marketId, reason: 'market-unknown' }
    }
    const oracleToken = geometry.oracleToken ?? cfg.oracleToken

    let params: LoadParams
    try {
      params = await this.getLoadParams()
    } catch (e) {
      return { available: false, marketId, reason: 'no-rpc', detail: errMsg(e) }
    }

    // ONE multicall: fairPremium + inventory + sigmaRef (allowFailure for graceful).
    let results: Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>
    try {
      results = (await this.pub.multicall({
        allowFailure: true,
        contracts: [
          {
            address: stylus.fairValueOracle,
            abi: fairValueOracleAbi as Abi,
            functionName: 'fairPremium',
            args: [
              oracleToken,
              geometry.aWad,
              geometry.bWad,
              geometry.durationSeconds,
              geometry.maxIL,
            ],
          },
          {
            address: core.convexityVault,
            abi: convexityVaultAbi as Abi,
            functionName: 'inventory',
            args: [],
          },
          {
            address: core.volOracle,
            abi: volOracleAbi as Abi,
            functionName: 'sigmaRef',
            args: [oracleToken],
          },
        ],
      })) as Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>
    } catch (e) {
      return { available: false, marketId, reason: 'no-rpc', detail: errMsg(e) }
    }

    const fpRes = results[0]
    const invRes = results[1]
    const sigRes = results[2]

    if (fpRes === undefined || fpRes.status !== 'success') {
      // fairPremium reverts on out-of-range geometry / uninitialized vol.
      return {
        available: false,
        marketId,
        reason: 'fair-premium-revert',
        ...(fpRes?.error !== undefined ? { detail: errMsg(fpRes.error) } : {}),
      }
    }
    if (invRes === undefined || invRes.status !== 'success') {
      return {
        available: false,
        marketId,
        reason: 'inventory-revert',
        ...(invRes?.error !== undefined ? { detail: errMsg(invRes.error) } : {}),
      }
    }

    const fp = fpRes.result as readonly [bigint, bigint, bigint]
    const fairPremium = fp[0]
    const fairRateWad = fp[1]
    // Prefer the FVO-returned σ_ref (it priced against it); fall back to VolOracle.
    let sigmaRefWad = fp[2]
    if (sigmaRefWad === 0n && sigRes?.status === 'success') {
      sigmaRefWad = sigRes.result as bigint
    }

    const invTuple = invRes.result as readonly [bigint, bigint, bigint, bigint, bigint]
    const util = invTuple[3]
    const conc = invTuple[4]

    // Decompose the load with the parity-locked TS port (the deployed on-chain
    // loadComponents is delegatecall-only and cannot be eth_called — see header).
    const load: LoadBreakdown = cvamm.loadComponents(sigmaRefWad, util, conc, params)
    const poolPremium = capAt(cvamm.premiumFromLoad(fairPremium, load.totalLoadWad), geometry.maxIL)

    return {
      available: true,
      marketId,
      fairPremium,
      fairRateWad,
      sigmaRefWad,
      poolPremium,
      maxIL: geometry.maxIL,
      load,
      totalLoadBps: wadToBps(load.totalLoadWad),
      baseLoadWad: load.baseLoadWad,
      utilSkewWad: load.utilSkewWad,
      dispSkewWad: load.dispSkewWad,
      util,
      conc,
      regime: cvamm.regimeOf(sigmaRefWad, params),
    }
  }

  // ─── MM-1 (streamable): the geometry-independent "load to beat" ─────────────

  /**
   * Read the geometry-INDEPENDENT pool "load to beat" for a market right now:
   * `totalLoadWad(σ_ref, util, conc, loadParams)` in bps, with the per-component
   * decomposition. This needs NO position geometry — it is the pure pool floor an
   * MM must beat. Used by `streamPoolLoadToBeat`. Never throws (typed degrade).
   */
  async getPoolLoadToBeat(marketId: Hex): Promise<PoolLoadTick> {
    const ts = Date.now()
    let cfg: MarketConfig | undefined
    try {
      cfg = await this.getMarketConfig(marketId)
    } catch (e) {
      return { marketId, ts, available: false, reason: 'no-rpc', detail: errMsg(e) }
    }
    if (cfg === undefined) return { marketId, ts, available: false, reason: 'market-unknown' }

    let params: LoadParams
    try {
      params = await this.getLoadParams()
    } catch (e) {
      return { marketId, ts, available: false, reason: 'no-rpc', detail: errMsg(e) }
    }

    // ONE multicall: inventory + sigmaRef (no fairPremium → geometry-free).
    let results: Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>
    try {
      results = (await this.pub.multicall({
        allowFailure: true,
        contracts: [
          {
            address: core.convexityVault,
            abi: convexityVaultAbi as Abi,
            functionName: 'inventory',
            args: [],
          },
          {
            address: core.volOracle,
            abi: volOracleAbi as Abi,
            functionName: 'sigmaRef',
            args: [cfg.oracleToken],
          },
        ],
      })) as Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>
    } catch (e) {
      return { marketId, ts, available: false, reason: 'no-rpc', detail: errMsg(e) }
    }

    const invRes = results[0]
    const sigRes = results[1]
    if (invRes === undefined || invRes.status !== 'success') {
      return { marketId, ts, available: false, reason: 'inventory-revert' }
    }
    if (sigRes === undefined || sigRes.status !== 'success') {
      // VolOracle reverts when the token is not initialized.
      return { marketId, ts, available: false, reason: 'vol-uninitialized' }
    }

    const inv = invRes.result as readonly [bigint, bigint, bigint, bigint, bigint]
    const util = inv[3]
    const conc = inv[4]
    const sigmaRefWad = sigRes.result as bigint
    const load = cvamm.loadComponents(sigmaRefWad, util, conc, params)
    return {
      marketId,
      ts,
      available: true,
      sigmaRefWad,
      util,
      conc,
      load,
      totalLoadBps: wadToBps(load.totalLoadWad),
      regime: cvamm.regimeOf(sigmaRefWad, params),
    }
  }

  /**
   * Stream the geometry-independent "load to beat" for one or more markets on a
   * poll loop. The callback fires once per market per tick with the latest
   * `PoolLoadTick` (available OR typed-degraded). Returns a `StreamHandle` whose
   * `stop()` clears the interval. NEVER throws inside the loop.
   */
  streamPoolLoadToBeat(
    marketIds: readonly Hex[],
    onTick: (tick: PoolLoadTick) => void,
    opts: { intervalMs?: number } = {},
  ): StreamHandle {
    const intervalMs = opts.intervalMs ?? 4_000
    let stopped = false

    const poll = async (): Promise<void> => {
      for (const id of marketIds) {
        if (stopped) return
        try {
          const tick = await this.getPoolLoadToBeat(id)
          if (!stopped) onTick(tick)
        } catch (e) {
          // getPoolLoadToBeat already degrades; this is a belt-and-braces guard.
          if (!stopped) {
            onTick({
              marketId: id,
              ts: Date.now(),
              available: false,
              reason: 'no-rpc',
              detail: errMsg(e),
            })
          }
        }
      }
    }

    void poll()
    const handle = setInterval(() => void poll(), intervalMs)
    return {
      stop: () => {
        stopped = true
        clearInterval(handle)
      },
    }
  }

  // ─── MM-2: σ_ref / σ-components ─────────────────────────────────────────────

  /** `VolOracle.sigmaRef(token)`; degrades to `undefined` if the token is
   *  uninitialized (the getter reverts). */
  async getSigmaRef(token: Address): Promise<bigint | undefined> {
    try {
      return (await this.pub.readContract({
        address: core.volOracle,
        abi: volOracleAbi,
        functionName: 'sigmaRef',
        args: [token],
      })) as bigint
    } catch {
      return undefined
    }
  }

  /** `VolOracle.sigmaComponents(token)` — short/long/floor + which EWMA binds
   *  (NOT the load regime). Degrades to `undefined` if uninitialized. */
  async getSigmaComponents(token: Address): Promise<SigmaComponents | undefined> {
    try {
      const c = (await this.pub.readContract({
        address: core.volOracle,
        abi: volOracleAbi,
        functionName: 'sigmaComponents',
        args: [token],
      })) as readonly [bigint, bigint, bigint, number]
      return {
        sigmaShortWad: c[0],
        sigmaLongWad: c[1],
        floorWad: c[2],
        binding: c[3] as 0 | 1 | 2,
      }
    } catch {
      return undefined
    }
  }

  // ─── MM-3: getPositionGeometry — pricing inputs from a tokenId ──────────────

  /**
   * The exact geometry of a v3 position (MM-3) for pricing/quoting an incoming
   * fill. Reads `NPM.positions(tokenId)` for ticks+liquidity, derives the marketId
   * from (token0, token1, fee, durationSeconds) so the result is self-describing,
   * pins P0 from `InflexionCore.oracleDerivedSqrtPriceX96`, and computes a/b +
   * entry amounts + MaxIL ON-CHAIN (ILMath is public; no SwapMath port). Returns a
   * typed degraded result when the oracle reverts (stale/seq-down) or the position
   * is not recognised — never throws.
   *
   * `durationSeconds` is REQUIRED (a position alone has no expiry) — pass the
   * market's duration so the marketId and the FVO duration line up.
   */
  async getPositionGeometry(
    tokenId: bigint,
    durationSeconds: number,
  ): Promise<
    | { priceable: true; geometry: PositionGeometry; marketId: Hex; config: MarketConfig }
    | {
        priceable: false
        reason: PricingDegradeReason | 'oracle-degraded' | 'position-unknown'
        detail?: string
      }
  > {
    // 1. Position (ticks + liquidity + tokens).
    let pos: readonly [
      bigint,
      Address,
      Address,
      Address,
      number,
      number,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    try {
      pos = (await this.pub.readContract({
        address: this.npmAddress,
        abi: npmAbi,
        functionName: 'positions',
        args: [tokenId],
      })) as typeof pos
    } catch (e) {
      return { priceable: false, reason: 'position-unknown', detail: errMsg(e) }
    }
    const token0 = pos[2]
    const token1 = pos[3]
    const fee = pos[4]
    const tickLower = pos[5]
    const tickUpper = pos[6]
    const liquidity = pos[7]

    // 2. marketId from (token0, token1, fee, duration) → markets() config.
    const marketId = computeMarketId(token0, token1, fee, durationSeconds)
    let cfg: MarketConfig | undefined
    try {
      cfg = await this.getMarketConfig(marketId)
    } catch (e) {
      return { priceable: false, reason: 'no-rpc', detail: errMsg(e) }
    }
    if (cfg === undefined) return { priceable: false, reason: 'market-unknown' }

    // 3. Range edges (sqrtPa/sqrtPb) on-chain via TickMath.
    let sqrtPaX96: bigint
    let sqrtPbX96: bigint
    try {
      ;[sqrtPaX96, sqrtPbX96] = await this.tickEdges(tickLower, tickUpper)
    } catch (e) {
      return { priceable: false, reason: 'no-rpc', detail: errMsg(e) }
    }

    // 4. P0 from the oracle (REVERTS on stale/seq-down) → sqrtP0 via the exact
    //    on-chain conversion. Caught → typed oracle-degraded.
    let oraclePrice: bigint
    try {
      oraclePrice = (await this.pub.readContract({
        address: core.oracleManager,
        abi: oracleManagerAbi,
        functionName: 'getPrice',
        args: [cfg.oracleToken],
      })) as bigint
    } catch (e) {
      return { priceable: false, reason: 'oracle-degraded', detail: errMsg(e) }
    }
    let sqrtP0X96: bigint
    try {
      sqrtP0X96 = (await this.pub.readContract({
        address: this.coreAddress,
        abi: inflexionCoreAbi,
        functionName: 'oracleDerivedSqrtPriceX96',
        args: [marketId, oraclePrice],
      })) as bigint
    } catch (e) {
      return { priceable: false, reason: 'no-rpc', detail: errMsg(e) }
    }

    // 5. a/b (WAD) + entry amounts + MaxIL — entry amounts + MaxIL ON-CHAIN.
    const { aWad, bWad } = cvamm.abFromSqrt(sqrtP0X96, sqrtPaX96, sqrtPbX96)

    let amounts: readonly [bigint, bigint]
    let maxIL: bigint
    try {
      ;[amounts, maxIL] = await Promise.all([
        this.pub.readContract({
          address: core.ilMath,
          abi: ilMathAbi,
          functionName: 'getAmountsForLiquidity',
          args: [sqrtP0X96, sqrtPaX96, sqrtPbX96, liquidity],
        }) as Promise<readonly [bigint, bigint]>,
        this.pub.readContract({
          address: core.ilMath,
          abi: ilMathAbi,
          functionName: 'computeMaxIL',
          args: [sqrtP0X96, sqrtPaX96, sqrtPbX96, liquidity],
        }) as Promise<bigint>,
      ])
    } catch (e) {
      return { priceable: false, reason: 'no-rpc', detail: errMsg(e) }
    }

    // V0 in token1 (numéraire): amount1 + amount0 priced at P0 (oracle decimals).
    const v0 = numeraireValue(amounts[0], amounts[1], oraclePrice, cfg)

    const geometry: PositionGeometry = {
      tokenId,
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
      sqrtPaX96,
      sqrtPbX96,
      sqrtP0X96,
      aWad,
      bWad,
      amount0Entry: amounts[0],
      amount1Entry: amounts[1],
      maxIL,
      V0: v0,
    }
    return { priceable: true, geometry, marketId, config: cfg }
  }

  /** Read sqrtRatioAtTick for the two range edges (deployed TickMath lib). */
  private async tickEdges(tickLower: number, tickUpper: number): Promise<[bigint, bigint]> {
    const res = (await this.pub.multicall({
      allowFailure: false,
      contracts: [
        {
          address: libs.tickMath,
          abi: tickMathAbiInline as Abi,
          functionName: 'getSqrtRatioAtTick',
          args: [tickLower],
        },
        {
          address: libs.tickMath,
          abi: tickMathAbiInline as Abi,
          functionName: 'getSqrtRatioAtTick',
          args: [tickUpper],
        },
      ],
    })) as readonly [bigint, bigint]
    return [res[0], res[1]]
  }

  // ─── MM-4: getBook — active swaps for an MM + aggregate exposure ─────────────

  /**
   * The MM's book: every ACTIVE swap underwritten by `mm` + aggregate exposure.
   *
   * GRACEFUL: the live deploy has no on-chain `quoteId/nonce → swap` index and we
   * do NOT assume a subgraph, so the swap-id set is discovered by scanning
   * `swaps(id)` over `[fromSwapId, nextSwapId)` (bounded; caller can narrow the
   * range or inject a known id set). Each swap's path is inferred via
   * `mm == convexityVault` (Path A) else Path B — never throws. Greeks are
   * computed off-chain by finite-differencing the on-chain ILMath (see `greeks`).
   */
  async getBook(
    mm: Address,
    opts: { fromSwapId?: bigint; swapIds?: readonly bigint[]; withGreeks?: boolean } = {},
  ): Promise<BookResult> {
    let ids: bigint[]
    try {
      if (opts.swapIds !== undefined) {
        ids = [...opts.swapIds]
      } else {
        const next = (await this.pub.readContract({
          address: this.coreAddress,
          abi: inflexionCoreAbi,
          functionName: 'nextSwapId',
        })) as bigint
        const from = opts.fromSwapId ?? 1n
        ids = []
        for (let i = from; i < next; i++) ids.push(i)
      }
    } catch (e) {
      return { available: false, reason: 'no-rpc', detail: errMsg(e) }
    }

    const mmLower = mm.toLowerCase()
    const positions: BookPosition[] = []
    let exposureV0 = 0n
    let exposureMaxIL = 0n

    for (const id of ids) {
      let rec: SwapRecord
      try {
        const t = await this.pub.readContract({
          address: this.coreAddress,
          abi: inflexionCoreAbi,
          functionName: 'swaps',
          args: [id],
        })
        rec = decodeSwapRecord(t as Parameters<typeof decodeSwapRecord>[0])
      } catch {
        continue // skip an unreadable id rather than failing the whole book
      }
      if (rec.status !== 1) continue // only ACTIVE
      if (rec.mm.toLowerCase() !== mmLower) continue
      const isPathA = rec.mm.toLowerCase() === core.convexityVault.toLowerCase()
      positions.push({
        swapId: id,
        tokenId: rec.tokenId,
        lp: rec.lp,
        isPathA,
        V0: rec.V0,
        maxIL: rec.maxIL,
        collateral: rec.collateral,
        premium: rec.premium,
        liquidity: rec.liquidity,
        createdAt: rec.createdAt,
        expiry: rec.expiry,
      })
      exposureV0 += rec.V0
      exposureMaxIL += rec.maxIL
    }

    const out: BookResultOk = {
      available: true,
      mm,
      positions,
      exposureV0,
      exposureMaxIL,
      count: positions.length,
    }

    if (opts.withGreeks === true && positions.length > 0) {
      // Book-level Greeks = Σ per-position Greeks (finite-difference ILMath).
      let agg: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 }
      let anyPriced = false
      for (const p of positions) {
        const g = await this.greeksForSwap(p.swapId)
        if (g !== undefined) {
          anyPriced = true
          agg = {
            delta: agg.delta + g.delta,
            gamma: agg.gamma + g.gamma,
            vega: agg.vega + g.vega,
            theta: agg.theta + g.theta,
          }
        }
      }
      if (anyPriced) out.greeks = agg
      else out.greeksDegraded = 'oracle-degraded'
    }

    return out
  }

  /**
   * Price greeks (delta/gamma) of a single ACTIVE swap by finite-differencing the
   * on-chain `ILMath.computeIL` over a small P_T grid around the live oracle price.
   * Vega is left at 0 here (full vol-greeks finite-difference `FairValueOracle.
   * fairRate` and live in the GreeksEngine surface); this is the MM-book delta/gamma
   * fast path. Returns `undefined` if the swap cannot be priced (oracle degraded).
   */
  async greeksForSwap(swapId: bigint): Promise<Greeks | undefined> {
    let rec: SwapRecord
    try {
      const t = await this.pub.readContract({
        address: this.coreAddress,
        abi: inflexionCoreAbi,
        functionName: 'swaps',
        args: [swapId],
      })
      rec = decodeSwapRecord(t as Parameters<typeof decodeSwapRecord>[0])
    } catch {
      return undefined
    }
    if (rec.status === 0) return undefined

    // Recover geometry (ticks → sqrtPa/sqrtPb) + live oracle price for the bump.
    let resolved: ResolvedMarket
    try {
      resolved = await resolveMarket(this.pub, rec, {
        coreAddress: this.coreAddress,
        npmAddress: this.npmAddress,
      })
    } catch {
      return undefined
    }

    let oraclePrice: bigint
    try {
      oraclePrice = (await this.pub.readContract({
        address: core.oracleManager,
        abi: oracleManagerAbi,
        functionName: 'getPrice',
        args: [resolved.config.oracleToken],
      })) as bigint
    } catch {
      return undefined // oracle degraded → no live price-greeks
    }

    // Bump P0 ±1% via the on-chain oracle→sqrtP conversion, computeIL at each.
    const up = (oraclePrice * 101n) / 100n
    const dn = (oraclePrice * 99n) / 100n
    let sqrt0: bigint
    let sqrtUp: bigint
    let sqrtDn: bigint
    try {
      ;[sqrt0, sqrtUp, sqrtDn] = (await this.pub.multicall({
        allowFailure: false,
        contracts: [
          {
            address: this.coreAddress,
            abi: inflexionCoreAbi as Abi,
            functionName: 'oracleDerivedSqrtPriceX96',
            args: [resolved.marketId, oraclePrice],
          },
          {
            address: this.coreAddress,
            abi: inflexionCoreAbi as Abi,
            functionName: 'oracleDerivedSqrtPriceX96',
            args: [resolved.marketId, up],
          },
          {
            address: this.coreAddress,
            abi: inflexionCoreAbi as Abi,
            functionName: 'oracleDerivedSqrtPriceX96',
            args: [resolved.marketId, dn],
          },
        ],
      })) as readonly [bigint, bigint, bigint]
    } catch {
      return undefined
    }

    // Range edges for computeIL.
    let sqrtPa: bigint
    let sqrtPb: bigint
    try {
      const pos = (await this.pub.readContract({
        address: this.npmAddress,
        abi: npmAbi,
        functionName: 'positions',
        args: [rec.tokenId],
      })) as readonly [
        bigint,
        Address,
        Address,
        Address,
        number,
        number,
        number,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ]
      ;[sqrtPa, sqrtPb] = await this.tickEdges(pos[5], pos[6])
    } catch {
      return undefined
    }

    let il0: bigint
    let ilUp: bigint
    let ilDn: bigint
    try {
      const calls = [sqrt0, sqrtUp, sqrtDn].map((s) => ({
        address: core.ilMath,
        abi: ilMathAbi as Abi,
        functionName: 'computeIL',
        args: [s, sqrtPa, sqrtPb, rec.liquidity, rec.amount0Entry, rec.amount1Entry],
      }))
      const res = (await this.pub.multicall({
        allowFailure: false,
        contracts: calls,
      })) as unknown as readonly [bigint, bigint, bigint]
      ;[il0, ilUp, ilDn] = res
    } catch {
      return undefined
    }

    // Cap each at MaxIL (the MM is short the CAPPED claim).
    const cap = rec.maxIL
    const p0 = capAt(il0, cap)
    const pUp = capAt(ilUp, cap)
    const pDn = capAt(ilDn, cap)

    const dP = Number(oraclePrice) * 0.01 // ±1% in oracle-price units
    const f0 = Number(p0)
    const fUp = Number(pUp)
    const fDn = Number(pDn)
    const delta = (fUp - fDn) / (2 * dP)
    const gamma = (fUp - 2 * f0 + fDn) / (dP * dP)

    return { delta, gamma, vega: 0, theta: 0 }
  }

  // ─── MM-6: signQuote (re-export + I10 + below-pool-load assertion) ───────────

  /**
   * Sign an EIP-712 quote (MM-6). Delegates to `@inflexion/engine/quote.signQuote`
   * (NEVER reimplemented) and asserts, BEFORE returning, that:
   *   1. `loadBps ≤ loadParams.maxLoadBps`  (I10), and
   *   2. `loadBps < live pool-load-bps`     (the quote actually undercuts Path A).
   *
   * The live pool load is read via `getPoolLoadToBeat(quote.marketId)`. If the
   * pool load cannot be read (oracle/vol degraded) the below-pool check is SKIPPED
   * (and reported in the result) rather than blocking the signature — the on-chain
   * router still enforces best-of at execution. Set `requirePoolCheck:true` to
   * make a missing pool-load read a hard error instead.
   */
  async signQuote(
    privateKey: Hex,
    quote: SignedQuote,
    opts: { requirePoolCheck?: boolean; verifyingContract?: Address; chainId?: number } = {},
  ): Promise<SignQuoteResult> {
    const params = await this.getLoadParams()
    // 1. I10 — hard guard.
    if (BigInt(quote.loadBps) > params.maxLoadBps) {
      throw new MmQuoteError(
        `loadBps ${quote.loadBps} exceeds maxLoadBps ${params.maxLoadBps} (I10)`,
        'i10-exceeded',
      )
    }

    // 2. below-pool-load guard.
    const tick = await this.getPoolLoadToBeat(quote.marketId)
    let belowPoolChecked = false
    let poolLoadBps: bigint | undefined
    if (tick.available && tick.totalLoadBps !== undefined) {
      poolLoadBps = tick.totalLoadBps
      belowPoolChecked = true
      if (BigInt(quote.loadBps) >= tick.totalLoadBps) {
        throw new MmQuoteError(
          `loadBps ${quote.loadBps} does not undercut live pool load ${tick.totalLoadBps}bps`,
          'not-below-pool',
        )
      }
    } else if (opts.requirePoolCheck === true) {
      throw new MmQuoteError(
        `pool load unreadable (${tick.reason ?? 'unknown'}) and requirePoolCheck set`,
        'pool-load-unreadable',
      )
    }

    const verifyingContract = opts.verifyingContract ?? this.coreAddress
    const chainId = opts.chainId ?? this.chainId
    const envelope = await engineSignQuote(privateKey, quote, chainId, verifyingContract)

    return {
      envelope,
      belowPoolChecked,
      ...(poolLoadBps !== undefined ? { poolLoadBps } : {}),
      i10Ok: true,
    }
  }

  // ─── MM-7: quoteStream — auto-requote loop ──────────────────────────────────

  /**
   * Auto-requote loop (MM-7): on each tick, builds a fresh quote from the latest
   * pool-load-to-beat, signs it (via `signQuote`, which re-enforces I10 + below-
   * pool), and hands the envelope to `publish` (e.g. an injected WS `send`). The
   * `build` callback receives the live `PoolLoadTick` so the MM can set its load
   * relative to the pool floor and bump the nonce. Degrades silently per tick
   * (skips a tick whose pool load is unreadable or whose build/sign throws) and
   * reports via `onError`. Returns a `StreamHandle`.
   *
   * The transport is INJECTED (`publish`) so the SDK does not depend on `ws`; an
   * MM wires it to their engine WS connection. If no `publish` is given the loop
   * is inert except for `onQuote` callbacks — graceful, never throws.
   */
  quoteStream(opts: QuoteStreamOptions): StreamHandle {
    const intervalMs = opts.intervalMs ?? 5_000
    let stopped = false

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const load = await this.getPoolLoadToBeat(opts.marketId)
        if (stopped) return
        if (!load.available) {
          opts.onError?.(
            new MmQuoteError(`pool load unreadable: ${load.reason}`, 'pool-load-unreadable'),
          )
          return
        }
        const quote = await opts.build(load)
        if (quote === undefined) return // MM chose to skip this tick
        const signed = await this.signQuote(opts.privateKey, quote, {
          ...(opts.verifyingContract !== undefined
            ? { verifyingContract: opts.verifyingContract }
            : {}),
          ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {}),
        })
        opts.onQuote?.(signed.envelope, load)
        opts.publish?.(signed.envelope)
      } catch (e) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }

    void tick()
    const handle = setInterval(() => void tick(), intervalMs)
    return {
      stop: () => {
        stopped = true
        clearInterval(handle)
      },
    }
  }

  // ─── MM-8: isQuoteFilled (COARSE) + watchFills ──────────────────────────────

  /**
   * COARSE fill status (MM-8). `isNonceUsed(mm, nonce)` is set on BOTH a fill and a
   * cancel, and `SwapCreated`/`SwapRouted` carry NO quoteId/nonce, so the only
   * honest answer from a direct on-chain read is "nonce spent: filled-or-cancelled".
   * Returns a typed `NonceStatus` with `precision:'coarse'` — NEVER claims a
   * precise filled/cancelled distinction. The precise path is the now-live
   * `QuoteFilled` event (emitted on-chain since the 2026-06-05 deploy), which
   * becomes available once the subgraph is deployed to index it. Degrades to
   * `spent:false, precision:'coarse'` with a detail when the read fails — never throws.
   */
  async isQuoteFilled(mm: Address, nonce: bigint): Promise<NonceStatus> {
    try {
      const spent = (await this.pub.readContract({
        address: this.coreAddress,
        abi: inflexionCoreAbi,
        functionName: 'isNonceUsed',
        args: [mm, nonce],
      })) as boolean
      return {
        mm,
        nonce,
        spent,
        precision: 'coarse',
        detail: spent
          ? 'nonce bit set: FILLED-OR-CANCELLED (direct on-chain read cannot distinguish; precise via the now-live QuoteFilled event once the subgraph is deployed to index it)'
          : 'nonce bit clear: neither filled nor cancelled',
      }
    } catch (e) {
      return {
        mm,
        nonce,
        spent: false,
        precision: 'coarse',
        detail: `isNonceUsed read failed: ${errMsg(e)}`,
      }
    }
  }

  /**
   * Watch for fills against an MM by polling `SwapCreated` logs filtered by the
   * indexed `mm` topic (this event carries `mm` but NOT quoteId/nonce, so the
   * match to a specific quote is COARSE — joined by nonce via `isQuoteFilled`, or
   * precisely via the now-live `QuoteFilled` event once the subgraph is deployed to
   * index it). The callback fires per new
   * matching log. Returns a `StreamHandle`. Degrades silently on a failed poll
   * (reports via `onError`) — never throws inside the loop.
   */
  watchFills(
    mm: Address,
    onFill: (fill: FillLog) => void,
    opts: { intervalMs?: number; fromBlock?: bigint; onError?: (e: Error) => void } = {},
  ): StreamHandle {
    const intervalMs = opts.intervalMs ?? 6_000
    let stopped = false
    let cursor = opts.fromBlock

    const poll = async (): Promise<void> => {
      try {
        const latest = await this.pub.getBlockNumber()
        const from = cursor ?? latest
        if (from > latest) {
          cursor = latest + 1n
          return
        }
        const logs = await this.pub.getContractEvents({
          address: this.coreAddress,
          abi: inflexionCoreAbi,
          eventName: 'SwapCreated',
          args: { mm },
          fromBlock: from,
          toBlock: latest,
        })
        for (const log of logs) {
          if (stopped) return
          const a = log.args as {
            swapId?: bigint
            lp?: Address
            mm?: Address
            tokenId?: bigint
            V0?: bigint
            maxIL?: bigint
            premium?: bigint
          }
          onFill({
            swapId: a.swapId ?? 0n,
            lp: a.lp ?? ('0x0000000000000000000000000000000000000000' as Address),
            mm: a.mm ?? mm,
            tokenId: a.tokenId ?? 0n,
            V0: a.V0 ?? 0n,
            maxIL: a.maxIL ?? 0n,
            premium: a.premium ?? 0n,
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash ?? ('0x' as Hex),
            attribution: 'coarse',
          })
        }
        cursor = latest + 1n
      } catch (e) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }

    void poll()
    const handle = setInterval(() => void poll(), intervalMs)
    return {
      stop: () => {
        stopped = true
        clearInterval(handle)
      },
    }
  }

  // ─── MM-9: cancelNonces + nonce encode/decode + capacity-remaining ──────────

  /**
   * Cancel one or more quote nonces (MM-9). Requires a wallet client (throws a
   * typed error if none was injected — a write needs a signer). Returns the tx
   * hash. The nonce bitmap is keyed `(word<<8)|bit` — use `encodeNonce`/
   * `decodeNonce` to build them.
   */
  async cancelNonces(nonces: readonly bigint[]): Promise<Hex> {
    if (this.wallet === undefined) {
      throw new MmQuoteError(
        'cancelNonces requires a wallet client (no signer injected)',
        'no-signer',
      )
    }
    const account = this.wallet.account
    if (account === undefined) {
      throw new MmQuoteError('wallet client has no account', 'no-signer')
    }
    const data = encodeFunctionData({
      abi: inflexionCoreAbi,
      functionName: 'cancelNonces',
      args: [[...nonces]],
    })
    return this.wallet.sendTransaction({
      account,
      chain: this.wallet.chain ?? null,
      to: this.coreAddress,
      data,
      value: 0n,
    })
  }

  /** Build the cancelNonces tx WITHOUT sending (for an external signer / preview). */
  buildCancelNoncesTx(nonces: readonly bigint[]): { to: Address; data: Hex; value: bigint } {
    const data = encodeFunctionData({
      abi: inflexionCoreAbi,
      functionName: 'cancelNonces',
      args: [[...nonces]],
    })
    return { to: this.coreAddress, data, value: 0n }
  }

  /**
   * Capacity remaining on a quote (I7): `maxNotionalV0 − consumedNotional(quoteId)`,
   * clamped at 0. Returns `{ remaining, consumed, max }`. Degrades to
   * `{ available:false }` when the read fails — never throws.
   */
  async capacityRemaining(
    quoteId: Hex,
    maxNotionalV0: bigint,
  ): Promise<
    | {
        available: true
        quoteId: Hex
        remaining: bigint
        consumed: bigint
        max: bigint
        exhausted: boolean
      }
    | { available: false; quoteId: Hex; reason: 'no-rpc'; detail?: string }
  > {
    try {
      const consumed = (await this.pub.readContract({
        address: this.coreAddress,
        abi: inflexionCoreAbi,
        functionName: 'consumedNotional',
        args: [quoteId],
      })) as bigint
      const remaining = consumed >= maxNotionalV0 ? 0n : maxNotionalV0 - consumed
      return {
        available: true,
        quoteId,
        remaining,
        consumed,
        max: maxNotionalV0,
        exhausted: remaining === 0n,
      }
    } catch (e) {
      return { available: false, quoteId, reason: 'no-rpc', detail: errMsg(e) }
    }
  }

  /** Read available collateral for a Path-B MM (UnderwriterVault). Degrades to
   *  `undefined` on a failed read. */
  async getMmCollateral(
    mm: Address,
  ): Promise<{ deposited: bigint; locked: bigint; available: bigint } | undefined> {
    try {
      const [deposited, locked, available] = (await this.pub.multicall({
        allowFailure: false,
        contracts: [
          {
            address: core.underwriterVault,
            abi: underwriterVaultAbi as Abi,
            functionName: 'deposited',
            args: [mm],
          },
          {
            address: core.underwriterVault,
            abi: underwriterVaultAbi as Abi,
            functionName: 'locked',
            args: [mm],
          },
          {
            address: core.underwriterVault,
            abi: underwriterVaultAbi as Abi,
            functionName: 'availableBalance',
            args: [mm],
          },
        ],
      })) as readonly [bigint, bigint, bigint]
      return { deposited, locked, available }
    } catch {
      return undefined
    }
  }
}

// ─── Nonce codec (MM-9) — bitmap key (word<<8)|bit ───────────────────────────

/** Encode a (word, bit) bitmap slot to a nonce: `(word<<8)|bit`. `bit ∈ [0,255]`. */
export function encodeNonce(word: bigint, bit: number): bigint {
  if (bit < 0 || bit > 255) throw new MmQuoteError(`bit ${bit} out of range [0,255]`, 'bad-nonce')
  return (word << 8n) | BigInt(bit)
}

/** Decode a nonce to its (word, bit) bitmap slot. */
export function decodeNonce(nonce: bigint): { word: bigint; bit: number } {
  return { word: nonce >> 8n, bit: Number(nonce & 0xffn) }
}

// ─── Supporting types ────────────────────────────────────────────────────────

export interface BookPosition {
  swapId: bigint
  tokenId: bigint
  lp: Address
  /** True iff `mm == convexityVault` (Path A pool) — else Path B (an MM). */
  isPathA: boolean
  V0: bigint
  maxIL: bigint
  collateral: bigint
  premium: bigint
  liquidity: bigint
  createdAt: bigint
  expiry: bigint
}

export interface BookResultOk {
  available: true
  mm: Address
  positions: BookPosition[]
  exposureV0: bigint
  exposureMaxIL: bigint
  count: number
  /** Book-level Greeks (Σ position greeks) — present only when `withGreeks` and at
   *  least one position priced. */
  greeks?: Greeks
  /** Set when `withGreeks` was requested but the oracle was degraded for all. */
  greeksDegraded?: 'oracle-degraded'
}
export type BookResult = BookResultOk | { available: false; reason: 'no-rpc'; detail?: string }

export interface SignQuoteResult {
  envelope: QuoteEnvelope
  /** True iff the below-pool-load check actually ran (false if pool load unread). */
  belowPoolChecked: boolean
  /** The live pool load (bps) the quote was checked against, if read. */
  poolLoadBps?: bigint
  /** I10 was satisfied (always true here — a violation throws). */
  i10Ok: true
}

export interface QuoteStreamOptions {
  /** The MM's signer (raw key). */
  privateKey: Hex
  /** The market to quote. */
  marketId: Hex
  /** Build the next quote from the live pool load; return `undefined` to skip a tick. */
  build: (poolLoad: PoolLoadTick) => SignedQuote | undefined | Promise<SignedQuote | undefined>
  /** Optional transport — e.g. an engine WS `send`. The SDK does NOT depend on `ws`. */
  publish?: (envelope: QuoteEnvelope) => void
  /** Fired with each signed envelope + the pool load it beat. */
  onQuote?: (envelope: QuoteEnvelope, poolLoad: PoolLoadTick) => void
  onError?: (e: Error) => void
  intervalMs?: number
  verifyingContract?: Address
  chainId?: number
}

export interface FillLog {
  swapId: bigint
  lp: Address
  mm: Address
  tokenId: bigint
  V0: bigint
  maxIL: bigint
  premium: bigint
  blockNumber: bigint
  txHash: Hex
  /** 'coarse' from this SwapCreated watch (no quoteId/nonce on the event); precise
   *  attribution comes from the now-live `QuoteFilled` event once the subgraph is
   *  deployed to index it. */
  attribution: 'coarse' | 'precise'
}

export type MmQuoteErrorCode =
  | 'i10-exceeded'
  | 'not-below-pool'
  | 'pool-load-unreadable'
  | 'no-signer'
  | 'bad-nonce'

export class MmQuoteError extends Error {
  readonly code: MmQuoteErrorCode
  constructor(message: string, code: MmQuoteErrorCode) {
    super(message)
    this.name = 'MmQuoteError'
    this.code = code
  }
}

// ─── Small internal helpers ──────────────────────────────────────────────────

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function capAt(v: bigint, cap: bigint): bigint {
  return v > cap ? cap : v
}

/**
 * V0 in the numéraire (token1): amount1 + amount0 priced at the oracle P0.
 * The oracle price is in `oracleDecimals`-scaled units of token1 per token0; we
 * scale amount0 (token0Decimals) into token1Decimals via the oracle ratio. This
 * mirrors the contract's numéraire convention closely enough for an MM exposure
 * figure (exact V0 is stored on-chain at create; this is the pre-fill estimate).
 */
function numeraireValue(
  amount0: bigint,
  amount1: bigint,
  oraclePrice: bigint,
  cfg: MarketConfig,
): bigint {
  // value0_in_token1 = amount0 * oraclePrice / 10^oracleDecimals  (then decimal-adjust)
  const oracleScale = 10n ** BigInt(cfg.oracleDecimals)
  const dec0 = 10n ** BigInt(cfg.token0Decimals)
  const dec1 = 10n ** BigInt(cfg.token1Decimals)
  // amount0 (dec0) * price (token1/token0, oracleDecimals) → token1 raw (dec1)
  const value0InToken1 = (amount0 * oraclePrice * dec1) / (oracleScale * dec0)
  return amount1 + value0InToken1
}

// ─── Inline TickMath ABI (NOT exported by abis.ts; tight subset of the lib) ──
// OracleManager / ILMath are imported from the foundation (abis.ts). TickMath is
// the one read the foundation does not expose a named ABI for; this is a
// byte-identical subset of the deployed library image.

const tickMathAbiInline = [
  {
    type: 'function',
    name: 'getSqrtRatioAtTick',
    stateMutability: 'pure',
    inputs: [{ name: 'tick', type: 'int24' }],
    outputs: [{ type: 'uint160' }],
  },
] as const
