/**
 * `LpClient` — the LP (liquidity-provider) surface: buying in-range IL protection.
 *
 * This is the **claim (A)** surface — every payout-bearing result carries
 * `noBadDebtFull: true` (qualified: capped payoff + solvent USDC + oracle/settlement
 * liveness). It NEVER merges that with the depositor claim (B) "capital not guaranteed".
 *
 * Design contracts (from docs/ACCESS_LAYER_ARCHITECTURE.md + CLAUDE.md, with the
 * documented corrections applied):
 *  - Pricing reads the on-chain Stylus `FairValueOracle.fairPremium` — the Φ-sum is
 *    NEVER reimplemented. The Path-A load stack is the deterministic `CvammPricing`
 *    TS port (math.js, parity-tested against the deployed lib) over the public inputs
 *    `(σ_ref, util, conc)` + `loadParams()` — exactly the inputs `_pricePathAFromFair`
 *    consumes on-chain. (The rich on-chain `loadComponents` path activates at the
 *    single redeploy; the TS port is the documented interim.)
 *  - `regime` is the σ_ref-vs-loadParams band (calm/normal/stressed) via `cvamm.regimeOf`
 *    — NOT `sigmaComponents.binding`.
 *  - Geometry mirrors `_prepareSwap`/`_fairPremium`: Pa/Pb via TickMath from the NFT
 *    ticks, P0 pinned by `oracleDerivedSqrtPriceX96`, `a/b` via `cvamm.abFromSqrt`,
 *    MaxIL via `ILMath.computeMaxIL`, entry amounts via `ILMath.getAmountsForLiquidity`.
 *  - `OracleManager.getPrice` REVERTS on stale feed / sequencer down — every read that
 *    needs P0 catches the revert set and returns a typed `NotPriceable`
 *    (`{ priceable:false, reason:'oracle-degraded' }`) for that position, never throwing
 *    the whole call (graceful degradation is first-class).
 *  - Path B (engine `GET /quote`) is best-effort: an absent/unreachable engine just makes
 *    `premiumB` undefined and `best/path` fall back to Path A — never an error.
 *  - `getPayoffCurve` for an UNPROTECTED position uses on-chain
 *    `ILMath.getAmountsForLiquidity` (no SwapMath port) then `ILMath.computeIL` over a
 *    P_T grid; for an active swap it reads stored amounts from `swaps(id)`.
 *  - `settlePreview` is NOT `view` (it returns) but the deployed `ILMath.computeIL` is
 *    `pure`, so it is called via `publicClient.simulateContract`, never `readContract`.
 */
import {
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {
  aggregatorV3Abi,
  convexityVaultAbi,
  erc20Abi,
  fairValueOracleAbi,
  ilMathAbi,
  inflexionCoreAbi,
  npmAbi,
  oracleManagerAbi,
  volOracleAbi,
} from './abis.js'
import { chainlink, core, libs, npm as npmAddr, stylus, tokens } from './addresses.js'
import { decodeMarketConfig, decodeSwapRecord, type SwapRecord } from './decode.js'
import { computeMarketId, resolveMarket, type ResolvedMarket } from './resolveMarket.js'
import * as cvamm from './math.js'
import type {
  LoadParams,
  MarketConfig,
  NotPriceable,
  PayoffCurve,
  PayoffPoint,
  PreviewResult,
  Priceable,
  ProtectionStatus,
} from './types.js'
import type { SignedQuote } from './quote.js'

// ─── TickMath (deployed library image) ──────────────────────────────────────
// Not part of the shared abis.ts subset — needed only here to reproduce the exact
// on-chain `getSqrtRatioAtTick(tick)` used in `_prepareSwap`. Calling the deployed
// lib (libs.tickMath) guarantees byte-identical Pa/Pb to the contract.
const tickMathAbi = [
  {
    type: 'function',
    name: 'getSqrtRatioAtTick',
    stateMutability: 'pure',
    inputs: [{ name: 'tick', type: 'int24' }],
    outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }],
  },
] as const

/** The `NPM.positions(tokenId)` return tuple (named, in ABI order). */
type PositionTuple = readonly [
  bigint, // nonce
  Address, // operator
  Address, // token0
  Address, // token1
  number, // fee
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity
  bigint, // feeGrowthInside0LastX128
  bigint, // feeGrowthInside1LastX128
  bigint, // tokensOwed0
  bigint, // tokensOwed1
]

// ─── Oracle-degradation detection ───────────────────────────────────────────
// OracleManager.getPrice reverts on stale feed / sequencer-down / lone-spike. We
// classify any revert from that call as 'oracle-degraded' and surface it as a typed
// NotPriceable rather than throwing. (We do not try to parse the specific custom
// error — any revert from getPrice means "not priceable right now".)

/** A typed degraded read for a position/market that could not be priced. */
function notPriceable(reason: NotPriceable['reason'], detail?: string): NotPriceable {
  return detail === undefined ? { priceable: false, reason } : { priceable: false, reason, detail }
}

/** True iff an error looks like a contract revert (vs an RPC/transport failure). */
function isRevert(e: unknown): boolean {
  const name = (e as { name?: string } | undefined)?.name ?? ''
  const msg = e instanceof Error ? e.message : String(e)
  return (
    name === 'ContractFunctionExecutionError' ||
    name === 'ContractFunctionRevertedError' ||
    name === 'CallExecutionError' ||
    /revert|execution reverted|getPrice|stale|sequencer/i.test(msg)
  )
}

// ─── Geometry (mirror of _prepareSwap / _fairPremium) ───────────────────────

/** Pricing-input geometry for a position, pinned at the live oracle price. */
export interface LpGeometry {
  tokenId: bigint
  token0: Address
  token1: Address
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  sqrtPaX96: bigint
  sqrtPbX96: bigint
  sqrtP0X96: bigint
  aWad: bigint
  bWad: bigint
  amount0Entry: bigint
  amount1Entry: bigint
  maxIL: bigint
  /** True iff Pa ≤ P0 ≤ Pb (the createSwap in-range gate). */
  inRange: boolean
}

export interface LpClientOptions {
  publicClient: PublicClient
  /** Optional signer for the write methods (buyProtection / settle). */
  walletClient?: WalletClient
  /** Engine base URL for Path-B quotes + the previewPremium telemetry ping. */
  engineBaseUrl?: string
  /** Override the telemetry endpoint (defaults to `${engineBaseUrl}/telemetry/preview`). */
  telemetryUrl?: string
  /** Injected fetch (tests). Defaults to global fetch when present. */
  fetchImpl?: typeof fetch
}

/** Claimable Uniswap v3 fees on a protected position (checkpointed `tokensOwed`). */
export interface ClaimableFees {
  swapId: bigint
  tokenId: bigint
  token0: Address
  token1: Address
  /** token0 fees — checkpointed `tokensOwed0` (under-states live-uncollected). */
  fee0: bigint
  /** token1 fees — checkpointed `tokensOwed1` (under-states live-uncollected). */
  fee1: bigint
  basis: 'checkpointed-tokensOwed'
}

/**
 * LP surface client. All reads are graceful: anything needing the live oracle price
 * returns a typed `NotPriceable` if `getPrice` reverts, rather than throwing.
 */
export class LpClient {
  readonly publicClient: PublicClient
  readonly walletClient?: WalletClient
  readonly engineBaseUrl?: string
  private readonly telemetryUrl?: string
  private readonly fetchImpl?: typeof fetch
  /** Cached immutable load params (the cvAMM block is frozen post-deploy). */
  private loadParamsCache?: LoadParams

  constructor(opts: LpClientOptions) {
    this.publicClient = opts.publicClient
    if (opts.walletClient !== undefined) this.walletClient = opts.walletClient
    if (opts.engineBaseUrl !== undefined) this.engineBaseUrl = opts.engineBaseUrl
    if (opts.telemetryUrl !== undefined) this.telemetryUrl = opts.telemetryUrl
    else if (opts.engineBaseUrl !== undefined)
      this.telemetryUrl = `${opts.engineBaseUrl.replace(/\/$/, '')}/telemetry/preview`
    if (opts.fetchImpl !== undefined) this.fetchImpl = opts.fetchImpl
    else if (typeof globalThis.fetch === 'function')
      this.fetchImpl = globalThis.fetch.bind(globalThis)
  }

  // ─── low-level reads ──────────────────────────────────────────────────────

  /** `NPM.positions(tokenId)` (viem-inferred named tuple), or `undefined` on failure. */
  private async readPosition(tokenId: bigint): Promise<PositionTuple | undefined> {
    try {
      return (await this.publicClient.readContract({
        address: npmAddr,
        abi: npmAbi,
        functionName: 'positions',
        args: [tokenId],
      })) as PositionTuple
    } catch {
      return undefined
    }
  }

  // ─── load params (cached) ─────────────────────────────────────────────────

  /** Read + cache `InflexionCore.loadParams()` (immutable post-deploy). */
  async getLoadParams(): Promise<LoadParams> {
    if (this.loadParamsCache !== undefined) return this.loadParamsCache
    const t = await this.publicClient.readContract({
      address: core.inflexionCore,
      abi: inflexionCoreAbi,
      functionName: 'loadParams',
      args: [],
    })
    const p: LoadParams = {
      baseLoadCalmBps: t[0],
      baseLoadNormalBps: t[1],
      baseLoadStressedBps: t[2],
      regimeCalmBelowWad: t[3],
      regimeStressedAtWad: t[4],
      utilKneeWad: t[5],
      utilSlopeWad: t[6],
      utilPowerWad: t[7],
      utilCapWad: t[8],
      dispSlopeWad: t[9],
      dispPowerWad: t[10],
      dispCapWad: t[11],
      maxLoadBps: t[12],
    }
    this.loadParamsCache = p
    return p
  }

  // ─── geometry ─────────────────────────────────────────────────────────────

  /**
   * Resolve the pricing geometry for `tokenId` against `marketId`, pinned at the
   * live oracle price. Returns a typed `NotPriceable` (never throws) when:
   *  - the oracle reverts (stale/sequencer-down) → `oracle-degraded`
   *  - the market is unknown/inactive → `market-unknown`
   *  - the marketId does not match the position's (token0,token1,fee,duration) →
   *    `position-unknown`
   */
  async resolveGeometry(
    tokenId: bigint,
    marketId: Hex,
  ): Promise<Priceable<{ geometry: LpGeometry }>> {
    // Market config first — needed for oracleToken + duration check.
    let cfg: MarketConfig
    try {
      const cfgTuple = await this.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'markets',
        args: [marketId],
      })
      cfg = decodeMarketConfig(marketId, cfgTuple)
    } catch (e) {
      return notPriceable('market-unknown', e instanceof Error ? e.message : String(e))
    }
    if (!cfg.active) return notPriceable('market-unknown', 'market inactive/unregistered')

    // Position geometry from the NFT (viem infers the named-tuple shape from npmAbi).
    const p = await this.readPosition(tokenId)
    if (p === undefined) return notPriceable('position-unknown', 'positions(tokenId) read failed')
    const token0 = p[2]
    const token1 = p[3]
    const fee = p[4]
    const tickLower = p[5]
    const tickUpper = p[6]
    const liquidity = p[7]

    // The marketId must match the position's pre-image (token0,token1,fee,duration).
    const derived = computeMarketId(token0, token1, fee, cfg.durationSeconds)
    if (derived.toLowerCase() !== marketId.toLowerCase()) {
      return notPriceable('position-unknown', 'position pair/fee does not match market')
    }

    // Pa/Pb via the deployed TickMath lib image (byte-identical to _prepareSwap).
    const [sqrtPaX96, sqrtPbX96] = (await Promise.all([
      this.publicClient.readContract({
        address: libs.tickMath,
        abi: tickMathAbi,
        functionName: 'getSqrtRatioAtTick',
        args: [tickLower],
      }),
      this.publicClient.readContract({
        address: libs.tickMath,
        abi: tickMathAbi,
        functionName: 'getSqrtRatioAtTick',
        args: [tickUpper],
      }),
    ])) as [bigint, bigint]

    // Live oracle price → P0 (this is the call that can revert when degraded).
    let oraclePrice: bigint
    try {
      oraclePrice = await this.publicClient.readContract({
        address: core.oracleManager,
        abi: oracleManagerAbi,
        functionName: 'getPrice',
        args: [cfg.oracleToken],
      })
    } catch (e) {
      if (isRevert(e))
        return notPriceable('oracle-degraded', e instanceof Error ? e.message : String(e))
      throw e
    }

    // P0 → sqrtP0 via the contract's exact conversion (no decimal guessing).
    const sqrtP0X96 = (await this.publicClient.readContract({
      address: core.inflexionCore,
      abi: inflexionCoreAbi,
      functionName: 'oracleDerivedSqrtPriceX96',
      args: [marketId, oraclePrice],
    })) as bigint

    const inRange = sqrtP0X96 >= sqrtPaX96 && sqrtP0X96 <= sqrtPbX96
    const { aWad, bWad } = cvamm.abFromSqrt(sqrtP0X96, sqrtPaX96, sqrtPbX96)

    // MaxIL + entry amounts from the deployed ILMath (pure).
    const [maxIL, amounts] = (await Promise.all([
      this.publicClient.readContract({
        address: core.ilMath,
        abi: ilMathAbi,
        functionName: 'computeMaxIL',
        args: [sqrtP0X96, sqrtPaX96, sqrtPbX96, liquidity],
      }),
      this.publicClient.readContract({
        address: core.ilMath,
        abi: ilMathAbi,
        functionName: 'getAmountsForLiquidity',
        args: [sqrtP0X96, sqrtPaX96, sqrtPbX96, liquidity],
      }),
    ])) as [bigint, readonly [bigint, bigint]]

    const geometry: LpGeometry = {
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
      inRange,
    }
    return { priceable: true, geometry }
  }

  // ─── LP-1: listEligiblePositions ─────────────────────────────────────────

  /**
   * Enumerate the owner's Uniswap v3 positions and return those eligible for
   * protection: a registered+active market exists for the pair/fee at one of the
   * known durations AND the position is in-range (Pa ≤ P0 ≤ Pb).
   *
   * The in-range gate needs the live oracle price; if the oracle is degraded for a
   * market, that position is returned with `priceable:false` (so the caller still
   * sees it exists but cannot be quoted right now) rather than dropped silently.
   *
   * `durations` defaults to the protocol's standard tenors (7/30/90d); pass the
   * exact `durationSeconds` you care about to widen/narrow the search.
   */
  async listEligiblePositions(
    owner: Address,
    opts?: { durations?: readonly number[] },
  ): Promise<EligiblePosition[]> {
    const durations = opts?.durations ?? DEFAULT_DURATIONS
    const out: EligiblePosition[] = []

    let balance: bigint
    try {
      balance = (await this.publicClient.readContract({
        address: npmAddr,
        abi: npmAbi,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint
    } catch {
      return out // no NPM reachable → empty (graceful)
    }

    for (let i = 0n; i < balance; i++) {
      let tokenId: bigint
      try {
        tokenId = (await this.publicClient.readContract({
          address: npmAddr,
          abi: npmAbi,
          functionName: 'tokenOfOwnerByIndex',
          args: [owner, i],
        })) as bigint
      } catch {
        continue
      }

      // Read the position once (pair/fee) to derive candidate market ids.
      const pos = await this.readPosition(tokenId)
      if (pos === undefined) continue
      const token0 = pos[2]
      const token1 = pos[3]
      const fee = pos[4]
      const liquidity = pos[7]
      if (liquidity === 0n) continue // closed position — not protectable

      for (const dur of durations) {
        const marketId = computeMarketId(token0, token1, fee, dur)
        // Is the market active?
        let cfg: MarketConfig
        try {
          const cfgTuple = await this.publicClient.readContract({
            address: core.inflexionCore,
            abi: inflexionCoreAbi,
            functionName: 'markets',
            args: [marketId],
          })
          cfg = decodeMarketConfig(marketId, cfgTuple)
        } catch {
          continue
        }
        if (!cfg.active) continue

        // In-range gate needs the geometry (live oracle). Degraded → keep the row
        // with priceable:false so the UI can still show "market exists, not quotable".
        const g = await this.resolveGeometry(tokenId, marketId)
        if (!g.priceable) {
          out.push({ tokenId, marketId, durationSeconds: dur, inRange: undefined, geometry: g })
          continue
        }
        if (!g.geometry.inRange) continue // out-of-range entries are rejected at creation
        out.push({
          tokenId,
          marketId,
          durationSeconds: dur,
          inRange: true,
          geometry: g,
        })
      }
    }
    return out
  }

  // ─── LP-2: previewPremium ────────────────────────────────────────────────

  /**
   * Dollar premium for THIS position on `marketId`, best-of {Path A pool, Path B MM}.
   *
   * Path A: on-chain `FairValueOracle.fairPremium` (the Φ-sum, never reimplemented)
   * → `CvammPricing` TS load stack over `(σ_ref, util, conc)` + `loadParams` →
   * `premiumFromLoad`, capped at MaxIL — exactly `_pricePathAFromFair`.
   *
   * Path B (best-effort): `GET ${engineBaseUrl}/quote?marketId=…` for a signed MM
   * quote; `premiumB = ceil(fairPremium·(1+loadBps/BPS))` capped at MaxIL from the
   * SAME fairPremium. An absent/unreachable engine just leaves `premiumB` undefined
   * and routes Path A (never an error).
   *
   * `{poke:true}` sends a `volOracle.poke` tx first for a signer-grade σ_ref (needs a
   * wallet client; silently skipped — with the staler last-poked σ_ref — if none).
   *
   * Returns a typed `NotPriceable` when the oracle is degraded.
   *
   * Fires a best-effort telemetry ping (the latent-demand signal, §5.4/§5.6) — never
   * awaited into the result, never throws.
   */
  async previewPremium(
    tokenId: bigint,
    marketId: Hex,
    opts?: { poke?: boolean; engineBaseUrl?: string },
  ): Promise<Priceable<PreviewResult>> {
    // Optional signer-grade freshness: poke before pricing.
    if (opts?.poke === true && this.walletClient !== undefined) {
      try {
        const cfgTuple = await this.publicClient.readContract({
          address: core.inflexionCore,
          abi: inflexionCoreAbi,
          functionName: 'markets',
          args: [marketId],
        })
        const cfg = decodeMarketConfig(marketId, cfgTuple)
        await this.poke(cfg.oracleToken)
      } catch {
        // poke is a permissionless optimisation; failing it must not block the read.
      }
    }

    const g = await this.resolveGeometry(tokenId, marketId)
    if (!g.priceable) return g
    const geom = g.geometry
    if (!geom.inRange) return notPriceable('position-unknown', 'position out of range')

    // Path A — on-chain fair premium (the load-bearing on-chain read). oracleToken +
    // duration come from the market config (the marketId pre-image).
    const cfgTuple = await this.publicClient.readContract({
      address: core.inflexionCore,
      abi: inflexionCoreAbi,
      functionName: 'markets',
      args: [marketId],
    })
    const cfg = decodeMarketConfig(marketId, cfgTuple)
    const fp = (await this.publicClient.readContract({
      address: stylus.fairValueOracle,
      abi: fairValueOracleAbi,
      functionName: 'fairPremium',
      args: [cfg.oracleToken, geom.aWad, geom.bWad, BigInt(cfg.durationSeconds), geom.maxIL],
    })) as readonly [bigint, bigint, bigint]
    const fairPremium = fp[0]
    const fairRateWad = fp[1]
    const sigmaRefWad = fp[2]

    // Path-A load stack from the inventory + loadParams (TS port).
    const [inv, params] = await Promise.all([
      this.publicClient.readContract({
        address: core.convexityVault,
        abi: convexityVaultAbi,
        functionName: 'inventory',
        args: [],
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
      this.getLoadParams(),
    ])
    const utilWad = inv[3]
    const concWad = inv[4]
    const totalLoad = cvamm.totalLoadWad(sigmaRefWad, utilWad, concWad, params)
    let premiumA = cvamm.premiumFromLoad(fairPremium, totalLoad)
    if (premiumA > geom.maxIL) premiumA = geom.maxIL

    // Path B — best-effort engine quote.
    let premiumB: bigint | undefined
    const quote = await this.fetchEngineQuote(marketId, opts?.engineBaseUrl)
    if (quote !== undefined) {
      premiumB = cvamm.pathBPremium(fairPremium, quote.loadBps, geom.maxIL)
    }

    const best = premiumB !== undefined && premiumB < premiumA ? premiumB : premiumA
    const path: 'A' | 'B' = premiumB !== undefined && premiumB < premiumA ? 'B' : 'A'

    const result: PreviewResult =
      premiumB === undefined
        ? {
            marketId,
            maxIL: geom.maxIL,
            fairPremium,
            fairRateWad,
            sigmaRefWad,
            premiumA,
            best,
            path,
          }
        : {
            marketId,
            maxIL: geom.maxIL,
            fairPremium,
            fairRateWad,
            sigmaRefWad,
            premiumA,
            premiumB,
            best,
            path,
          }

    // Best-effort telemetry ping (latent-demand signal). Fire-and-forget.
    this.firePreviewTelemetry({ tokenId, marketId, durationSeconds: undefined, result })

    return { priceable: true, ...result }
  }

  // ─── LP-3: getPayoffCurve ────────────────────────────────────────────────

  /**
   * Payout-vs-terminal-price curve for `tokenId` on `marketId`, capped at MaxIL,
   * with the range edges + P0 marked.
   *
   * For an UNPROTECTED position the entry amounts come from on-chain
   * `ILMath.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L)` (no SwapMath port);
   * for each grid price the IL comes from on-chain `ILMath.computeIL`, then capped.
   *
   * The grid spans below Pa … inside … above Pb so the convexity + the cap plateau
   * are both visible. Returns a typed `NotPriceable` when the oracle is degraded.
   */
  async getPayoffCurve(
    tokenId: bigint,
    marketId: Hex,
    opts?: { points?: number },
  ): Promise<Priceable<PayoffCurve>> {
    const points = Math.max(8, opts?.points ?? 64)
    const g = await this.resolveGeometry(tokenId, marketId)
    if (!g.priceable) return g
    const geom = g.geometry

    // Build a sqrtP_T grid. Span [0.7·Pa, 1.3·Pb] in sqrt space so the curve shows
    // the below-range and above-range plateaus around the in-range convex region.
    const lo = (geom.sqrtPaX96 * 7n) / 10n
    const hi = (geom.sqrtPbX96 * 13n) / 10n
    const span = hi - lo
    const n = BigInt(points - 1)

    const sqrtGrid: bigint[] = []
    for (let i = 0; i < points; i++) {
      const t = (span * BigInt(i)) / n
      sqrtGrid.push(lo + t)
    }
    // Ensure the edges + P0 are represented exactly.
    for (const edge of [geom.sqrtPaX96, geom.sqrtP0X96, geom.sqrtPbX96]) {
      if (!sqrtGrid.some((s) => s === edge)) sqrtGrid.push(edge)
    }
    sqrtGrid.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    const curvePoints: PayoffPoint[] = []
    for (const sqrtPT of sqrtGrid) {
      const il = (await this.publicClient.readContract({
        address: core.ilMath,
        abi: ilMathAbi,
        functionName: 'computeIL',
        args: [
          sqrtPT,
          geom.sqrtPaX96,
          geom.sqrtPbX96,
          geom.liquidity,
          geom.amount0Entry,
          geom.amount1Entry,
        ],
      })) as bigint
      const payout = il > geom.maxIL ? geom.maxIL : il
      curvePoints.push({ priceWad: sqrtToPriceWad(sqrtPT), sqrtPTX96: sqrtPT, payout, il })
    }

    return {
      priceable: true,
      points: curvePoints,
      maxIL: geom.maxIL,
      edgeLowWad: sqrtToPriceWad(geom.sqrtPaX96),
      edgeHighWad: sqrtToPriceWad(geom.sqrtPbX96),
      p0Wad: sqrtToPriceWad(geom.sqrtP0X96),
    }
  }

  // ─── LP-4: buyProtection (write) ─────────────────────────────────────────

  /**
   * Buy protection. The default rail is `createSwapRouted` (best-of {pool, MM});
   * pass an explicit `{quote, signature}` to route a specific MM quote, or set
   * `{escapeHatch:'A'}` to force the always-on pool, or `{escapeHatch:'B'}` to force
   * a specific signed MM quote.
   *
   * Approvals (NFT + USDC) are handled when `{approve:true}` (default): the position
   * NFT is approved to InflexionCore and `maxPremium` USDC is approved to the core.
   *
   * Requires a wallet client; throws a clear error if none is configured (writes are
   * the one place a missing signer is a hard error, not a degraded read).
   */
  async buyProtection(params: BuyProtectionParams): Promise<Hex> {
    const wallet = this.requireWallet()
    const account = this.requireAccount(wallet)
    const { tokenId, marketId, maxPremium } = params

    if (params.approve !== false) {
      await this.ensureApprovals(account, tokenId, maxPremium)
    }

    const data = this.encodeBuyProtection(params)
    return wallet.sendTransaction({
      account,
      chain: wallet.chain ?? null,
      to: core.inflexionCore,
      data,
      value: 0n,
    })
  }

  /** Encode the chosen create call (routed default, or an A/B escape hatch). */
  encodeBuyProtection(params: BuyProtectionParams): Hex {
    const { tokenId, marketId, maxPremium } = params
    const hatch = params.escapeHatch

    if (hatch === 'A') {
      return encodeFunctionData({
        abi: inflexionCoreAbi,
        functionName: 'createSwapPathA',
        args: [marketId, tokenId, maxPremium],
      })
    }
    if (hatch === 'B') {
      const { quote, signature } = this.requireQuote(params)
      return encodeFunctionData({
        abi: inflexionCoreAbi,
        functionName: 'createSwap',
        args: [toQuoteTuple(quote), signature, tokenId, maxPremium],
      })
    }
    // Default: routed best-of. A missing quote → the "no MM quote" sentinel
    // (mm == address(0), empty signature) so the router falls back to the pool.
    const quote = params.quote ?? EMPTY_QUOTE(marketId)
    const signature = params.signature ?? '0x'
    return encodeFunctionData({
      abi: inflexionCoreAbi,
      functionName: 'createSwapRouted',
      args: [toQuoteTuple(quote), signature, tokenId, maxPremium],
    })
  }

  /** Approve the NFT + `maxPremium` USDC to InflexionCore (idempotent). */
  async ensureApprovals(account: Account, tokenId: bigint, maxPremium: bigint): Promise<void> {
    const wallet = this.requireWallet()
    // NFT approval (single-token approve to the core).
    const nftData = encodeFunctionData({
      abi: npmAbi,
      functionName: 'approve',
      args: [core.inflexionCore, tokenId],
    })
    await wallet.sendTransaction({
      account,
      chain: wallet.chain ?? null,
      to: npmAddr,
      data: nftData,
      value: 0n,
    })

    // USDC approval (premium is charged in the numéraire — demo dUSDC / USDC).
    const usdc = tokens.demoUsdc
    const current = (await this.publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, core.inflexionCore],
    })) as bigint
    if (current < maxPremium) {
      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [core.inflexionCore, maxPremium],
      })
      await wallet.sendTransaction({
        account,
        chain: wallet.chain ?? null,
        to: usdc,
        data: approveData,
        value: 0n,
      })
    }
  }

  // ─── LP-5: getProtectionStatus ───────────────────────────────────────────

  /**
   * Live protection status of a swap: premium paid, MaxIL, expiry countdown, and
   * IL-to-date computed from `settlePreview` at the live oracle price.
   *
   * `settlePreview` is NOT `view` but the deployed `ILMath.computeIL` is `pure`, so
   * it is called via `simulateContract` (eth_call), never `readContract`.
   *
   * `ilToDate` is itself a `Priceable`: if the oracle is degraded the swap fields are
   * still returned (premium/expiry/etc.) but `ilToDate` carries `priceable:false`.
   */
  async getProtectionStatus(
    swapId: bigint,
  ): Promise<ProtectionStatus | { available: false; reason: string }> {
    let swap: SwapRecord
    let resolved: ResolvedMarket
    try {
      const t = (await this.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'swaps',
        args: [swapId],
      })) as Parameters<typeof decodeSwapRecord>[0]
      swap = decodeSwapRecord(t)
      if (swap.status === 0) return { available: false, reason: 'swap-unknown' }
      resolved = await resolveMarket(this.publicClient, swap)
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : String(e) }
    }

    const now = BigInt(Math.floor(Date.now() / 1000))
    const secondsToExpiry = swap.expiry > now ? swap.expiry - now : 0n
    const isPathA = isAddressEqual(swap.mm, core.convexityVault)

    // IL to date — settlePreview at the live price (degraded-safe). settlePreview
    // reverts unless the swap is ACTIVE, so a SETTLED swap returns an inert typed
    // result (the full status is still returned).
    const ilToDate =
      swap.status === 1
        ? await this.ilToDate(swapId, resolved.config)
        : notPriceable('position-unknown', 'swap not active (settled) — no live IL-to-date')

    return {
      swapId,
      lp: swap.lp,
      mm: swap.mm,
      isPathA,
      premiumPaid: swap.premium,
      maxIL: swap.maxIL,
      V0: swap.V0,
      createdAt: swap.createdAt,
      expiry: swap.expiry,
      secondsToExpiry,
      status: swap.status,
      ilToDate,
      noBadDebtFull: true,
    }
  }

  /** IL-to-date via `settlePreview(swapId, sqrtP_live)` (eth_call). Degraded-safe. */
  private async ilToDate(
    swapId: bigint,
    cfg: MarketConfig,
  ): Promise<Priceable<{ il: bigint; payout: bigint; capHit: boolean }>> {
    let oraclePrice: bigint
    try {
      oraclePrice = (await this.publicClient.readContract({
        address: core.oracleManager,
        abi: oracleManagerAbi,
        functionName: 'getPrice',
        args: [cfg.oracleToken],
      })) as bigint
    } catch (e) {
      if (isRevert(e))
        return notPriceable('oracle-degraded', e instanceof Error ? e.message : String(e))
      throw e
    }
    const sqrtPTX96 = (await this.publicClient.readContract({
      address: core.inflexionCore,
      abi: inflexionCoreAbi,
      functionName: 'oracleDerivedSqrtPriceX96',
      args: [cfg.marketId, oraclePrice],
    })) as bigint

    // settlePreview returns (realisedIL, payout) — call via simulate (not view).
    // It reverts (SwapNotActive) if the swap settled between the status read and
    // here; treat any revert as a typed degraded result rather than throwing.
    try {
      const sim = await this.publicClient.simulateContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'settlePreview',
        args: [swapId, sqrtPTX96],
      })
      const [il, payout] = sim.result as readonly [bigint, bigint]
      // payout = min(il, maxIL); the cap bound iff the uncapped IL exceeds the payout.
      return { priceable: true, il, payout, capHit: payout < il }
    } catch (e) {
      if (isRevert(e))
        return notPriceable('position-unknown', e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  // ─── LP-5: getClaimableFees ──────────────────────────────────────────────

  /**
   * Uniswap v3 fees claimable on a protected position (the "fees earned vs
   * premium paid" half of LP-5). Returns the position's CHECKPOINTED
   * `tokensOwed0/1` from `NPM.positions`.
   *
   * NOTE: `tokensOwed` is only checkpointed on poke/collect/liquidity-modify, so
   * this UNDER-states live-uncollected fees. The exact live figure needs a
   * `collect` static-simulation from the ILVault custodian (or a `feeGrowthInside`
   * computation) — roadmap; historical fees come from the subgraph
   * (`FeesClaimed` + Uniswap `Collect`). Degraded-safe.
   */
  async getClaimableFees(
    swapId: bigint,
  ): Promise<ClaimableFees | { available: false; reason: string }> {
    let swap: SwapRecord
    try {
      const t = (await this.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'swaps',
        args: [swapId],
      })) as Parameters<typeof decodeSwapRecord>[0]
      swap = decodeSwapRecord(t)
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : String(e) }
    }
    if (swap.status === 0) return { available: false, reason: 'swap-unknown' }
    const p = await this.readPosition(swap.tokenId)
    if (p === undefined) return { available: false, reason: 'position-unreadable' }
    return {
      swapId,
      tokenId: swap.tokenId,
      token0: p[2] as Address,
      token1: p[3] as Address,
      fee0: p[10] as bigint,
      fee1: p[11] as bigint,
      basis: 'checkpointed-tokensOwed',
    }
  }

  // ─── LP-6: settle (write) ────────────────────────────────────────────────

  /**
   * Settle an expired swap. Computes `hintRoundId` (the Chainlink round whose
   * `updatedAt` brackets `expiry`) via a feed round-walk unless one is supplied,
   * then sends `settle(swapId, hintRoundId)`.
   *
   * Requires a wallet client.
   */
  async settle(swapId: bigint, opts?: { hintRoundId?: bigint }): Promise<Hex> {
    const wallet = this.requireWallet()
    const account = this.requireAccount(wallet)

    let hintRoundId = opts?.hintRoundId
    if (hintRoundId === undefined) {
      const t = (await this.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'swaps',
        args: [swapId],
      })) as Parameters<typeof decodeSwapRecord>[0]
      const swap = decodeSwapRecord(t)
      const resolved = await resolveMarket(this.publicClient, swap)
      hintRoundId = await this.findHintRoundId(resolved.config.oracleToken, swap.expiry)
    }

    const data = encodeFunctionData({
      abi: inflexionCoreAbi,
      functionName: 'settle',
      args: [swapId, hintRoundId],
    })
    return wallet.sendTransaction({
      account,
      chain: wallet.chain ?? null,
      to: core.inflexionCore,
      data,
      value: 0n,
    })
  }

  /**
   * Walk the Chainlink feed backwards from the latest round to find the round whose
   * `updatedAt` brackets `expiry` (the latest round with `updatedAt <= expiry`, i.e.
   * the round-at-T OracleManager.getSettlementPrice expects). Maps the oracle token
   * to its feed via the chainlink registry (demoWeth → ETH/USD).
   */
  async findHintRoundId(
    oracleToken: Address,
    expiry: bigint,
    opts?: { maxWalk?: number },
  ): Promise<bigint> {
    const feed = this.feedForToken(oracleToken)
    const maxWalk = opts?.maxWalk ?? 256
    const latest = (await this.publicClient.readContract({
      address: feed,
      abi: aggregatorV3Abi,
      functionName: 'latestRoundData',
      args: [],
    })) as readonly [bigint, bigint, bigint, bigint, bigint]

    let roundId = latest[0]
    let updatedAt = latest[3]
    // If even the latest round is at/before expiry, that's the bracket (settle at or
    // just after expiry on a slow feed).
    if (updatedAt <= expiry) return roundId

    // Walk back until updatedAt <= expiry, then return that round id.
    for (let i = 0; i < maxWalk; i++) {
      if (roundId === 0n) break
      const prev = roundId - 1n
      let r: readonly [bigint, bigint, bigint, bigint, bigint]
      try {
        r = (await this.publicClient.readContract({
          address: feed,
          abi: aggregatorV3Abi,
          functionName: 'getRoundData',
          args: [prev],
        })) as readonly [bigint, bigint, bigint, bigint, bigint]
      } catch {
        break // hit an un-fetchable (phase-boundary) round — return current best
      }
      if (r[3] === 0n) break // empty round
      if (r[3] <= expiry) return r[0]
      roundId = r[0]
      updatedAt = r[3]
    }
    return roundId
  }

  // ─── LP-7: autoProtect (keeper helper) ───────────────────────────────────

  /**
   * Keeper helper: scan the owner's eligible positions, filter by a minimum V0
   * (notional) threshold, exclude positions that already have an ACTIVE swap, and
   * buy protection on the rest. Returns one result row per candidate.
   *
   * "Already protected?" dedupe is best-effort on the live deploy: with no
   * `isTokenIdProtected` getter and no subgraph, the SDK enumerates `swaps` up to
   * `nextSwapId` and flags tokenIds with an ACTIVE swap. When `opts.protectedTokenIds`
   * is supplied (e.g. from the subgraph/API once wired) it is used directly and the
   * on-chain scan is skipped.
   *
   * Requires a wallet client (it submits buyProtection txs unless `dryRun:true`).
   */
  async autoProtect(opts: AutoProtectOptions): Promise<AutoProtectResult[]> {
    const owner = opts.owner
    const minV0 = opts.minV0 ?? 0n
    const eligible = await this.listEligiblePositions(
      owner,
      opts.durations !== undefined ? { durations: opts.durations } : undefined,
    )

    const protectedSet =
      opts.protectedTokenIds !== undefined
        ? new Set(opts.protectedTokenIds.map((t) => t.toString()))
        : await this.scanProtectedTokenIds(opts.scanLimit)

    const results: AutoProtectResult[] = []
    for (const pos of eligible) {
      // Skip un-priceable / out-of-range rows.
      if (!pos.geometry.priceable || pos.inRange !== true) {
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'skipped',
          reason: 'not-priceable',
        })
        continue
      }
      // V0 in numéraire units from the geometry's entry amounts at P0.
      const v0Numeraire = positionV0(pos.geometry.geometry)
      if (v0Numeraire < minV0) {
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'skipped',
          reason: 'below-min-v0',
        })
        continue
      }
      if (protectedSet.has(pos.tokenId.toString())) {
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'skipped',
          reason: 'already-protected',
        })
        continue
      }

      // Price it, then buy (unless dryRun).
      const preview = await this.previewPremium(pos.tokenId, pos.marketId)
      if (!preview.priceable) {
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'skipped',
          reason: preview.reason,
        })
        continue
      }
      const maxPremium = opts.maxPremium ?? withSlippage(preview.best, opts.slippageBps ?? 100)
      if (opts.dryRun === true) {
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'would-buy',
          premium: preview.best,
          maxPremium,
        })
        continue
      }
      try {
        const txHash = await this.buyProtection({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          maxPremium,
        })
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'bought',
          premium: preview.best,
          maxPremium,
          txHash,
        })
      } catch (e) {
        results.push({
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          action: 'error',
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }
    return results
  }

  /** Enumerate `swaps` up to `nextSwapId` and collect tokenIds with an ACTIVE swap. */
  private async scanProtectedTokenIds(scanLimit?: number): Promise<Set<string>> {
    const set = new Set<string>()
    let next: bigint
    try {
      next = (await this.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'nextSwapId',
        args: [],
      })) as bigint
    } catch {
      return set // can't enumerate → empty (dedupe degrades to "treat none as protected")
    }
    const limit = scanLimit ?? 1000
    const count = next < BigInt(limit) ? next : BigInt(limit)
    for (let id = 1n; id <= count; id++) {
      try {
        const t = (await this.publicClient.readContract({
          address: core.inflexionCore,
          abi: inflexionCoreAbi,
          functionName: 'swaps',
          args: [id],
        })) as Parameters<typeof decodeSwapRecord>[0]
        const s = decodeSwapRecord(t)
        if (s.status === 1) set.add(s.tokenId.toString()) // ACTIVE
      } catch {
        continue
      }
    }
    return set
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** Send a `volOracle.poke(token)` tx (signer-grade σ_ref freshness). */
  async poke(token: Address): Promise<Hex> {
    const wallet = this.requireWallet()
    const account = this.requireAccount(wallet)
    const data = encodeFunctionData({ abi: volOracleAbi, functionName: 'poke', args: [token] })
    return wallet.sendTransaction({
      account,
      chain: wallet.chain ?? null,
      to: core.volOracle,
      data,
      value: 0n,
    })
  }

  /** Map an oracle token to its Chainlink feed (the round-walk source for settle). */
  private feedForToken(oracleToken: Address): Address {
    // The demo volatile token (dWETH) is oracle-priced via the real Chainlink ETH/USD.
    if (isAddressEqual(oracleToken, tokens.demoWeth) || isAddressEqual(oracleToken, tokens.weth)) {
      return chainlink.ethUsd
    }
    if (isAddressEqual(oracleToken, tokens.usdc) || isAddressEqual(oracleToken, tokens.demoUsdc)) {
      return chainlink.usdcUsd
    }
    // Default to ETH/USD (the only volatile feed the demo markets use). A caller with
    // a non-demo market supplies `{hintRoundId}` directly.
    return chainlink.ethUsd
  }

  /** Best-effort Path-B quote fetch from the engine. `undefined` on any failure. */
  private async fetchEngineQuote(
    marketId: Hex,
    engineBaseUrl?: string,
  ): Promise<SignedQuote | undefined> {
    const base = engineBaseUrl ?? this.engineBaseUrl
    if (base === undefined || this.fetchImpl === undefined) return undefined
    try {
      const url = `${base.replace(/\/$/, '')}/quote?marketId=${marketId}`
      const res = await this.fetchImpl(url, { method: 'GET' })
      if (!res.ok) return undefined
      const json = (await res.json()) as { quote?: unknown; loadBps?: number } | undefined
      if (json === undefined) return undefined
      // Accept either a SignedQuote envelope ({quote}) or a bare quote object.
      const q = (json.quote ?? json) as Partial<SignedQuote> & { loadBps?: number }
      if (q.loadBps === undefined || q.marketId === undefined || q.mm === undefined)
        return undefined
      return q as SignedQuote
    } catch {
      return undefined
    }
  }

  /** Fire the previewPremium telemetry ping (latent-demand signal). Never throws. */
  private firePreviewTelemetry(payload: {
    tokenId: bigint
    marketId: Hex
    durationSeconds: number | undefined
    result: PreviewResult
  }): void {
    if (this.telemetryUrl === undefined || this.fetchImpl === undefined) return
    const body = JSON.stringify({
      ts: Math.floor(Date.now() / 1000),
      tokenId: payload.tokenId.toString(),
      marketId: payload.marketId,
      durationSeconds: payload.durationSeconds,
      premiumA: payload.result.premiumA.toString(),
      premiumB: payload.result.premiumB?.toString(),
      best: payload.result.best.toString(),
      path: payload.result.path,
      fairPremium: payload.result.fairPremium.toString(),
      sigmaRefWad: payload.result.sigmaRefWad.toString(),
    })
    // Fire and forget — swallow every error (telemetry must never affect the read).
    void Promise.resolve()
      .then(() =>
        this.fetchImpl!(this.telemetryUrl!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      )
      .catch(() => {})
  }

  private requireWallet(): WalletClient {
    if (this.walletClient === undefined) {
      throw new Error(
        'LpClient: a wallet client is required for write operations (no signer configured)',
      )
    }
    return this.walletClient
  }

  private requireAccount(wallet: WalletClient): Account {
    const account = wallet.account
    if (account === undefined) throw new Error('LpClient: wallet client has no account')
    return account
  }

  private requireQuote(params: BuyProtectionParams): { quote: SignedQuote; signature: Hex } {
    if (params.quote === undefined || params.signature === undefined) {
      throw new Error("LpClient: escapeHatch 'B' (createSwap) requires {quote, signature}")
    }
    return { quote: params.quote, signature: params.signature }
  }
}

// ─── public types for the surface ───────────────────────────────────────────

/** Standard protocol tenors (seconds): 7d / 30d / 90d. */
export const DEFAULT_DURATIONS: readonly number[] = [7 * 86400, 30 * 86400, 90 * 86400]

/** A position eligible (or near-eligible) for protection. */
export interface EligiblePosition {
  tokenId: bigint
  marketId: Hex
  durationSeconds: number
  /** True/false when priceable; `undefined` when the oracle was degraded for this market. */
  inRange: boolean | undefined
  /** The resolved geometry (or a NotPriceable when the oracle is degraded). */
  geometry: Priceable<{ geometry: LpGeometry }>
}

export interface BuyProtectionParams {
  tokenId: bigint
  marketId: Hex
  /** LP slippage guard (numéraire raw, e.g. 6-dec USDC). */
  maxPremium: bigint
  /** A signed MM quote to route (Path B); omit for pool-only routing. */
  quote?: SignedQuote
  signature?: Hex
  /** Force a specific rail: 'A' = createSwapPathA, 'B' = createSwap (needs quote+sig). */
  escapeHatch?: 'A' | 'B'
  /** Handle NFT + USDC approvals automatically (default true). */
  approve?: boolean
}

export interface AutoProtectOptions {
  owner: Address
  /** Only protect positions whose V0 (numéraire) ≥ this. Default 0. */
  minV0?: bigint
  /** Tenors to consider (default 7/30/90d). */
  durations?: readonly number[]
  /** Explicit per-position max premium (overrides slippage-derived). */
  maxPremium?: bigint
  /** Slippage over `best` when deriving maxPremium (bps, default 100 = 1%). */
  slippageBps?: number
  /** Known already-protected tokenIds (from subgraph/API) — skips the on-chain scan. */
  protectedTokenIds?: readonly bigint[]
  /** Cap on the on-chain `swaps` enumeration for dedupe (default 1000). */
  scanLimit?: number
  /** Compute the plan without submitting any tx. */
  dryRun?: boolean
}

export interface AutoProtectResult {
  tokenId: bigint
  marketId: Hex
  action: 'bought' | 'would-buy' | 'skipped' | 'error'
  reason?: string
  premium?: bigint
  maxPremium?: bigint
  txHash?: Hex
}

// ─── module-private helpers ─────────────────────────────────────────────────

/** The "no MM quote" sentinel for createSwapRouted (mm == 0 ⇒ pool-only routing). */
function EMPTY_QUOTE(marketId: Hex): SignedQuote {
  return {
    mm: zeroAddress,
    marketId,
    loadBps: 0,
    minMaxILRatioBps: 0,
    maxMaxILRatioBps: 0,
    quotePrice: 0n,
    priceBandBps: 0,
    model: 0,
    partialRatioBps: 0,
    maxNotionalV0: 0n,
    validUntil: 0n,
    quoteId: ('0x' + '00'.repeat(32)) as Hex,
    nonce: 0n,
  }
}

/** SignedQuote → the on-chain tuple order (matches the createSwap* ABI components). */
function toQuoteTuple(q: SignedQuote): {
  mm: Address
  marketId: Hex
  loadBps: number
  minMaxILRatioBps: number
  maxMaxILRatioBps: number
  quotePrice: bigint
  priceBandBps: number
  model: number
  partialRatioBps: number
  maxNotionalV0: bigint
  validUntil: bigint
  quoteId: Hex
  nonce: bigint
} {
  return {
    mm: q.mm,
    marketId: q.marketId,
    loadBps: q.loadBps,
    minMaxILRatioBps: q.minMaxILRatioBps,
    maxMaxILRatioBps: q.maxMaxILRatioBps,
    quotePrice: q.quotePrice,
    priceBandBps: q.priceBandBps,
    model: q.model,
    partialRatioBps: q.partialRatioBps,
    maxNotionalV0: q.maxNotionalV0,
    validUntil: q.validUntil,
    quoteId: q.quoteId,
    nonce: q.nonce,
  }
}

/** sqrtPriceX96 → price (WAD) = (sqrtP/2^96)^2 · 1e18 (token1-per-token0, raw decimals). */
export function sqrtToPriceWad(sqrtPX96: bigint): bigint {
  const Q96 = 1n << 96n
  // (sqrtP/Q96)^2 in WAD: ((sqrtP^2) * 1e18) / (Q96^2).
  return (sqrtPX96 * sqrtPX96 * cvamm.WAD) / (Q96 * Q96)
}

/** V0 in token1 (numéraire) units at entry: amount0·P0 + amount1. */
export function positionV0(g: LpGeometry): bigint {
  const Q96 = 1n << 96n
  // amount0 · P0, P0 = (sqrtP0/Q96)^2. Use mulDiv-style staging to limit overflow.
  const p0num = g.sqrtP0X96 * g.sqrtP0X96
  const amount0InToken1 = (g.amount0Entry * p0num) / (Q96 * Q96)
  return amount0InToken1 + g.amount1Entry
}

/** Add a bps slippage buffer to a premium (round up). */
export function withSlippage(premium: bigint, slippageBps: number): bigint {
  return (premium * (10_000n + BigInt(slippageBps))) / 10_000n + 1n
}
