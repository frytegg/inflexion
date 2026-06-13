/**
 * `DataClient` — the public DATA surface (§3.4 of the access-layer architecture).
 *
 * ─── THE SDK ↔ API/SUBGRAPH BOUNDARY (read this before adding a method) ───────
 *
 * The architecture splits the data-moat surfaces into TWO classes:
 *
 *   (1) HISTORY / AGGREGATE  → served by the SUBGRAPH, consumed via the public
 *       cached API. These are NOT live RPC reads — the contracts store *current*
 *       state only and emit events for the rest. The subgraph + API are DEPLOYED
 *       (hosted backend; subgraph indexed from the redeploy block). So each method
 *       here GETs `${apiBaseUrl}${endpoint}?${query}` and parses the typed body
 *       when an `apiBaseUrl` is configured; with no `apiBaseUrl`, a non-OK
 *       response, or an unreachable API it degrades to a typed `ApiPending`
 *       (`reason:'no-history-source'`, `endpoint`, `query`). It NEVER throws and
 *       NEVER fabricates data.
 *
 *   (2) THE ONE LIVE EXCEPTION — the CURRENT pool LOAD SURFACE. This is a live,
 *       uncached read: exactly the same multicall the MM `getMarketPricing` does
 *       (fairPremium + inventory + sigmaRef + loadParams, finished with the
 *       CvammPricing TS port), fanned out across a set of markets. It is reachable
 *       TODAY from public getters (§4), so `getCurrentLoadSurface` is implemented
 *       here against live RPC. The HISTORICAL evolution of this same surface
 *       (`getLoadSurfaceHistory`) is class (1) — subgraph/API.
 *
 * This boundary is deliberate: the SDK is "instant freshness + transactions"; the
 * API is "frictionless cached public read over the subgraph". `DataClient` is the
 * only SDK module that is *mostly* a thin forward-declaration of the API — it
 * exists now so callers can code against stable typed shapes and get graceful
 * degradation until the API ships, at which point the same degraded path becomes
 * the tested fallback when the API/subgraph is unreachable or stale.
 *
 * GRACEFUL DEGRADATION is a first-class property here: an unwired/unreachable API
 * (the rich events `QuoteFilled`/`SwapPriced` are LIVE on-chain since the
 * 2026-06-05 deploy and the subgraph indexes them; the hosted API serves them), a
 * reverting oracle on one market in the live surface — all return typed degraded
 * results, never throw.
 *
 * Pricing rule (inherited from CLAUDE.md / §2): the live surface reads the fair
 * value from the on-chain `FairValueOracle` closed form — NEVER reimplements the
 * Φ-sum. It MAY re-evaluate the deterministic `pure` load stack client-side (the
 * CvammPricing TS port, parity-tested against the deployed lib) — that is the only
 * permitted duplication.
 */
import type { Address, Hex, PublicClient } from 'viem'

import { core as coreAddrs, stylus as stylusAddrs } from './addresses.js'
import { convexityVaultAbi, fairValueOracleAbi, inflexionCoreAbi, volOracleAbi } from './abis.js'
import { decodeLoadParams } from './decode.js'
import { loadComponents, premiumFromLoad, regimeOf } from './math.js'
import type { Degraded, LoadParams, MarketConfig, MarketPricing } from './types.js'

// ─── Future API routes (the SDK ↔ API contract, named here so callers can read
//     them and so the Integrate phase wires the same strings) ──────────────────

/** The public API routes the history/aggregate methods will forward to once the
 *  subgraph + API ship. Stated here verbatim as the SDK-side half of the contract. */
export const DATA_API_ROUTES = {
  /** PUB-1: clearing-load surface time series (subgraph `MarketStateSnapshot[]`). */
  loadSurface: '/data/load-surface',
  /** PUB-5: pool-vs-MM load spread + MM win-rate (subgraph `SwapPriced`/`QuoteFilled`). */
  quoteCompetition: '/data/quote-competition',
  /** PUB-5 (latent half): off-chain `/quote` + `previewPremium` telemetry. */
  demandRequests: '/data/demand-requests',
  /** PUB-2 / DEP-8: per-tranche NAV day-by-day (subgraph `PoolDaySnapshot[]`). */
  navHistory: '/pool/nav-history',
  /** PUB-4 / Signal 5: protocol-wide net-gamma supply (off-chain Greeks over open set). */
  netGamma: '/data/net-gamma',
} as const

export type DataApiRoute = (typeof DATA_API_ROUTES)[keyof typeof DATA_API_ROUTES]

// ─── Degraded envelope specialisation for the API-backed methods ──────────────

/** Extra metadata every API-backed degraded result carries: the future endpoint
 *  + the query that WOULD be sent, so a caller can wire the API later with zero
 *  re-derivation, and a UI can show "coming from <route>" today. */
export interface ApiPending {
  /** Always false here — the API/subgraph is not wired yet. */
  available: false
  /** Typed reason (always `'no-history-source'` for these — the source is absent). */
  reason: 'no-history-source'
  /** The FUTURE public API route this method forwards to once the API ships. */
  endpoint: DataApiRoute
  /** The query params that will be sent to `endpoint` (echoed back for the caller). */
  query: Record<string, string>
  /** Human-readable note (the maturity / build-gap disclaimer). */
  detail: string
}

/** A history/aggregate result: the rich `T` once the API is wired, else `ApiPending`. */
export type ApiBacked<T> = ({ available: true } & T) | ApiPending

// ─── NAV history (the one history surface wired to the public API today) ──────

/** One per-tranche NAV time bucket — a subgraph `PoolDay/HourSnapshot`, normalised
 *  to bigint on-chain units. Claim (B): these are depositor-risk figures (junior is
 *  first-loss; senior is systemic-tail exposed), NEVER the LP payout claim (A). */
export interface NavSnapshot {
  /** Unix seconds at the start of the bucket (day or hour). */
  bucketStart: number
  /** Senior tranche NAV at the close of the bucket (USDC raw, 6-dec). */
  seniorAssets: bigint
  /** Junior tranche NAV at the close of the bucket (USDC raw, 6-dec). */
  juniorAssets: bigint
  /** Collateral locked backing open swaps (USDC raw). */
  totalLocked: bigint
  /** Utilization = totalLocked / (senior+junior) (WAD). */
  utilWad: bigint
  /** Concentration / HHI of per-market locked coverage (WAD). */
  concWad: bigint
  /** Premium credited to the pool DURING the bucket (USDC raw). */
  premiumAccrued: bigint
  /** Settlement payouts paid to LPs DURING the bucket (USDC raw). */
  payouts: bigint
  /** Loss absorbed by the junior (first-loss) tranche DURING the bucket (USDC raw). */
  juniorLoss: bigint
  /** Loss absorbed by senior — only in a systemic tail — DURING the bucket (USDC raw). */
  seniorLoss: bigint
}

/** Per-tranche NAV history (claim B): a `NavSnapshot[]` ordered oldest → newest. */
export interface NavHistory {
  /** Buckets ordered oldest → newest (ready to plot left-to-right). */
  snapshots: NavSnapshot[]
  /** The bucket size the series is in. */
  bucket: '1d' | '1h'
  /** Claim-(B) disclosure carried verbatim from the API (NEVER merged with claim A). */
  disclosure?: string
}

// ─── The other four API-backed signal shapes (Signals 1/3, 2, 4, 5) ───────────

/** One day-bucketed market load snapshot (subgraph `MarketStateSnapshot`). */
export interface LoadSurfacePoint {
  /** Unix seconds at the start of the day bucket. */
  bucketStart: number
  lockedByMarket: bigint
  utilWad: bigint
  concWad: bigint
  sigmaRefWad: bigint
  baseLoadWad: bigint
  utilSkewWad: bigint
  dispSkewWad: bigint
  totalLoadWad: bigint
  fillCount: number
  v0Volume: bigint
  pathBFills: number
}

/** Historical clearing-load surface for one market (PUB-1, Signals 1 & 3). */
export interface LoadSurfaceHistory {
  /** Buckets ordered oldest → newest. */
  snapshots: LoadSurfacePoint[]
  disclosure?: string
}

/** One aggregated quote-competition row per MM (Signal 2, dynamic half). */
export interface QuoteCompetitionRow {
  marketId: string
  mm: string
  quotes: number
  accepted: number
  rejected: number
  minLoadBps: number
  maxLoadBps: number
  avgLoadBps: number
  lastSeen: number
}

/** Pool-vs-MM quote competition (Signal 2). `enabled` = the engine COMPETITION_LOG sink is wired. */
export interface QuoteCompetition {
  competition: QuoteCompetitionRow[]
  enabled: boolean
  disclosure?: string
}

/** A realized (on-chain) geometry-demand bucket (Signal 4, realized half). */
export interface RealizedDemandBucket {
  id: string
  widthBucket: string
  distanceBucket: string
  durationBucket: string
  realizedFillCount: number
  realizedV0: bigint
  firstSeen: number
  lastSeen: number
}

/** A latent (off-chain telemetry) demand bucket — priced-but-not-bought interest. */
export interface LatentDemandBucket {
  marketId: string
  widthBucket: string
  distanceBucket: string
  durationBucket: string
  count: number
  previews: number
  quoteRequests: number
  firstSeen: number
  lastSeen: number
}

/** Demand skew (Signal 4): on-chain realized fills + off-chain latent interest. */
export interface DemandRequests {
  /** On-chain realized fills per geometry bucket (empty if the subgraph half is unavailable). */
  realized: RealizedDemandBucket[]
  /** Whether the realized (subgraph) half resolved. */
  realizedAvailable: boolean
  /** Off-chain latent interest per bucket (engine telemetry). */
  latent: LatentDemandBucket[]
  /** Whether the latent telemetry sink (DEMAND_LOG) is wired. */
  latentEnabled: boolean
  disclosure?: string
}

/** One net-gamma time bucket (subgraph `NetGammaSnapshot`). */
export interface NetGammaPoint {
  bucketStart: number
  activeSwapCount: number
  totalV0: bigint
  totalMaxIL: bigint
  aggGammaWad: bigint
  aggVegaWad: bigint
  volumeWeightedLoadWad: bigint
}

/** The current protocol-wide active-swap aggregate (NetGamma `protocolState`). */
export interface NetGammaState {
  activeSwapCount: number
  totalActiveV0: bigint
  totalActiveMaxIL: bigint
}

/** Net convexity / gamma supply (Signal 5). */
export interface NetGamma {
  /** Buckets ordered oldest → newest. */
  snapshots: NetGammaPoint[]
  protocolState: NetGammaState
  disclosure?: string
}

// ─── Live "current pool load surface" types (the ONE non-degraded method) ─────

/** Per-market geometry inputs for the live fair-premium read. If omitted for a
 *  market, a neutral reference geometry is used (the LOAD multiplier is geometry-
 *  independent; only `fairPremium`/`poolPremium` scale with a/b/maxIL — see note). */
export interface SurfaceGeometryInput {
  /** a = (Pa/P0)² (WAD). */
  aWad: bigint
  /** b = (Pb/P0)² (WAD). */
  bWad: bigint
  /** MaxIL (USDC raw) — the cap the pool premium is clamped to. */
  maxIL: bigint
}

/** A single market's live pricing row, or a typed "could not price" envelope.
 *  Discriminate on `available`: the oracle can revert per-market (stale feed /
 *  sequencer down) or the market can be unknown/inactive. */
export type SurfaceRow =
  | ({ available: true } & MarketPricing)
  | {
      available: false
      marketId: Hex
      reason: 'oracle-degraded' | 'market-unknown'
      detail: string
    }

/** The live load surface across a set of markets (one multicall + per-row decode). */
export interface LoadSurface {
  /** Per-market rows (degraded rows are inlined, never dropped — caller sees gaps). */
  rows: SurfaceRow[]
  /** Block the surface was read at (for the caller's freshness accounting). */
  blockNumber?: bigint
  /** Verbatim: this is a LIVE uncached read; the historical surface is the API. */
  note: string
}

export interface CurrentLoadSurfaceArgs {
  /** Markets to read. Each is a marketId; optional per-market geometry override. */
  markets: ReadonlyArray<{ marketId: Hex; geometry?: SurfaceGeometryInput }>
}

// ─── Neutral reference geometry (used when a market supplies none) ────────────
// The pool LOAD stack (baseLoad+util+disp) is geometry-INDEPENDENT — it is a
// function of (σ_ref, util, conc) only. So for a load *surface* the geometry only
// affects the absolute `fairPremium`/`poolPremium` dollar figures, not the load %.
// A centered a<1<b with a $1k MaxIL gives a well-formed in-range fairPremium read;
// callers wanting dollar-accurate premiums pass real geometry per market.
const REF_A_WAD = 810_000_000_000_000_000n // a = 0.81  (Pa/P0 = 0.9)
const REF_B_WAD = 1_210_000_000_000_000_000n // b = 1.21  (Pb/P0 = 1.1)
const REF_MAXIL = 1_000_000_000n // $1,000 (6-dec) reference cap

/** Detect the OracleManager / FairValueOracle "not priceable" revert set. The FVO
 *  reads the last-poked σ_ref and computes fairPremium; if the underlying oracle is
 *  stale / sequencer-down / σ_ref uninitialised the call reverts. We classify ALL
 *  call failures here as oracle-degraded (the surface row is inlined, not thrown). */
function isOracleDegraded(_err: unknown): boolean {
  // Conservative: any failure of the fairPremium leg is treated as degraded so a
  // single bad market never throws the whole surface. (The deployed contracts use
  // typed errors; this classifier can be tightened to match their exact selectors.)
  return true
}

/**
 * DataClient — thin typed wrappers for the public data surfaces.
 *
 * - ONE live method (`getCurrentLoadSurface`) — multicall over public getters.
 * - The rest forward-declare the FUTURE API/subgraph routes and return typed
 *   `ApiPending` results today (graceful degradation; never throw).
 */
export class DataClient {
  constructor(
    private readonly client: PublicClient,
    private readonly opts: {
      coreAddress?: Address
      convexityVaultAddress?: Address
      fairValueOracleAddress?: Address
      volOracleAddress?: Address
      /** Public REST API base URL (e.g. the hosted backend). Absent ⇒ history/
       *  aggregate surfaces return the same typed `ApiPending` as before (graceful). */
      apiBaseUrl?: string
      /** Injected fetch (tests / non-browser). Defaults to global fetch when present. */
      fetchImpl?: typeof fetch
    } = {},
  ) {}

  private get core(): Address {
    return this.opts.coreAddress ?? coreAddrs.inflexionCore
  }
  private get convexityVault(): Address {
    return this.opts.convexityVaultAddress ?? coreAddrs.convexityVault
  }
  private get fvo(): Address {
    return this.opts.fairValueOracleAddress ?? stylusAddrs.fairValueOracle
  }
  private get vol(): Address {
    return this.opts.volOracleAddress ?? coreAddrs.volOracle
  }
  /** The configured API base (trailing slashes trimmed), or undefined if unwired. */
  private get apiBaseUrl(): string | undefined {
    const base = this.opts.apiBaseUrl
    return base === undefined || base === '' ? undefined : base.replace(/\/+$/, '')
  }
  /** The fetch to use for API calls: injected first, else the global if present. */
  private get fetchImpl(): typeof fetch | undefined {
    if (this.opts.fetchImpl !== undefined) return this.opts.fetchImpl
    return typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
      ? globalThis.fetch
      : undefined
  }

  // ───────────────────────────────────────────────────────────────────────────
  // (2) THE ONE LIVE SURFACE — current pool load across markets.
  //     Same read set as MM `getMarketPricing`, fanned out. Live + uncached.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Read the CURRENT pool load surface across a set of markets — the live,
   * uncached "price-to-beat" snapshot. This is the only `DataClient` method that
   * hits live RPC instead of the (not-yet-built) API; the historical evolution of
   * the same surface is `getLoadSurfaceHistory` (API-backed, degraded today).
   *
   * Read set per market (one multicall over all markets + a shared loadParams):
   *   - `InflexionCore.markets(marketId)`            → config (oracleToken, duration)
   *   - `FairValueOracle.fairPremium(token,a,b,T,maxIL)` → (premium, fairRate, σ_ref)
   *   - `ConvexityVault.inventory()`                 → (total, locked, free, util, conc)
   *   - `InflexionCore.loadParams()`                 → load-stack params (read ONCE)
   * then the load stack (baseLoad/util/disp/total) is finished client-side via the
   * CvammPricing TS port and `poolPremium = ceil(fairPremium·(1+totalLoad))` capped.
   *
   * Per-market graceful degradation: an unknown/inactive market or a reverting
   * oracle yields an inlined degraded `SurfaceRow`, never a thrown call.
   *
   * NOTE: the on-chain `CvammPricing.loadComponents` IS deployed but is a
   * DELEGATECALL-ONLY library — a direct eth_call to it reverts (Solidity guards
   * deployed libraries; confirmed on the 2026-06-05 deploy) — so this method
   * PERMANENTLY uses the parity-locked TS port (byte-equal to the deployed Solidity
   * in math.parity.test.ts). The lib runs on-chain only via the core's delegatecall
   * during pricing; switching this read to an on-chain call would revert.
   */
  async getCurrentLoadSurface(args: CurrentLoadSurfaceArgs): Promise<LoadSurface> {
    const note =
      'LIVE uncached pool-load surface (one multicall over public getters); the ' +
      'historical evolution is served by the subgraph/API via getLoadSurfaceHistory.'

    if (args.markets.length === 0) {
      return { rows: [], note }
    }

    // ── 1. Shared reads: loadParams + inventory (one read each, market-agnostic) ──
    // These are pool-wide and immutable-ish; read once and reuse across rows.
    let params: LoadParams
    let inv: { util: bigint; conc: bigint }
    try {
      const [loadParamsTuple, inventory] = await Promise.all([
        this.client.readContract({
          address: this.core,
          abi: inflexionCoreAbi,
          functionName: 'loadParams',
          args: [],
        }),
        this.client.readContract({
          address: this.convexityVault,
          abi: convexityVaultAbi,
          functionName: 'inventory',
          args: [],
        }),
      ])
      params = decodeLoadParams(loadParamsTuple)
      inv = { util: inventory[3], conc: inventory[4] }
    } catch {
      // Pool-wide reads failed (no RPC / core unreachable) → every row degrades.
      const rows: SurfaceRow[] = args.markets.map((m) => ({
        available: false,
        marketId: m.marketId,
        reason: 'oracle-degraded',
        detail: 'pool-wide loadParams()/inventory() read failed (RPC unreachable?)',
      }))
      return { rows, note }
    }

    // ── 2. Per-market configs (multicall — markets are independent) ──
    const cfgCalls = args.markets.map((m) => ({
      address: this.core,
      abi: inflexionCoreAbi,
      functionName: 'markets' as const,
      args: [m.marketId] as const,
    }))
    const cfgResults = await this.client.multicall({ contracts: cfgCalls, allowFailure: true })

    // Build the set of priceable markets + their fairPremium calls.
    type Pending = {
      idx: number
      marketId: Hex
      config: MarketConfig
      geometry: SurfaceGeometryInput
    }
    const rows: SurfaceRow[] = new Array<SurfaceRow>(args.markets.length)
    const priceable: Pending[] = []

    for (let i = 0; i < args.markets.length; i++) {
      const m = args.markets[i]!
      const cfgRes = cfgResults[i]
      if (cfgRes === undefined || cfgRes.status !== 'success') {
        rows[i] = {
          available: false,
          marketId: m.marketId,
          reason: 'market-unknown',
          detail: 'markets(marketId) read failed',
        }
        continue
      }
      const cfg: MarketConfig = {
        marketId: m.marketId,
        token0: cfgRes.result[0],
        token1: cfgRes.result[1],
        fee: cfgRes.result[2],
        durationSeconds: cfgRes.result[3],
        oracleToken: cfgRes.result[4],
        token0Decimals: cfgRes.result[5],
        token1Decimals: cfgRes.result[6],
        oracleDecimals: cfgRes.result[7],
        active: cfgRes.result[8],
      }
      // An unregistered marketId returns the zero tuple; treat zero oracleToken /
      // inactive as unknown so the row is honestly degraded (not a $0 fair price).
      if (
        cfg.oracleToken === '0x0000000000000000000000000000000000000000' ||
        cfg.durationSeconds === 0
      ) {
        rows[i] = {
          available: false,
          marketId: m.marketId,
          reason: 'market-unknown',
          detail: 'market not registered (zero config tuple)',
        }
        continue
      }
      const geometry = m.geometry ?? { aWad: REF_A_WAD, bWad: REF_B_WAD, maxIL: REF_MAXIL }
      priceable.push({ idx: i, marketId: m.marketId, config: cfg, geometry })
    }

    // ── 3. fairPremium per priceable market (multicall; oracle can revert per row) ──
    if (priceable.length > 0) {
      const fpCalls = priceable.map((p) => ({
        address: this.fvo,
        abi: fairValueOracleAbi,
        functionName: 'fairPremium' as const,
        args: [
          p.config.oracleToken,
          p.geometry.aWad,
          p.geometry.bWad,
          BigInt(p.config.durationSeconds),
          p.geometry.maxIL,
        ] as const,
      }))
      const fpResults = await this.client.multicall({ contracts: fpCalls, allowFailure: true })

      for (let j = 0; j < priceable.length; j++) {
        const p = priceable[j]!
        const fp = fpResults[j]
        if (fp === undefined || fp.status !== 'success') {
          rows[p.idx] = {
            available: false,
            marketId: p.marketId,
            reason: 'oracle-degraded',
            detail:
              fp !== undefined && fp.status === 'failure' && isOracleDegraded(fp.error)
                ? 'FairValueOracle.fairPremium reverted (stale feed / sequencer down / σ_ref uninitialised)'
                : 'FairValueOracle.fairPremium call failed',
          }
          continue
        }
        const fairPremium = fp.result[0]
        const fairRateWad = fp.result[1]
        const sigmaRefWad = fp.result[2]

        // Finish the load stack client-side (CvammPricing TS port, parity-tested).
        const load = loadComponents(sigmaRefWad, inv.util, inv.conc, params)
        const poolPremiumUncapped = premiumFromLoad(fairPremium, load.totalLoadWad)
        const poolPremium =
          poolPremiumUncapped > p.geometry.maxIL ? p.geometry.maxIL : poolPremiumUncapped

        const pricing: MarketPricing = {
          marketId: p.marketId,
          fairPremium,
          fairRateWad,
          sigmaRefWad,
          poolPremium,
          maxIL: p.geometry.maxIL,
          load,
          util: inv.util,
          conc: inv.conc,
          regime: regimeOf(sigmaRefWad, params),
        }
        rows[p.idx] = { available: true, ...pricing }
      }
    }

    // Best-effort block number for freshness (non-fatal if it fails).
    let blockNumber: bigint | undefined
    try {
      blockNumber = await this.client.getBlockNumber()
    } catch {
      blockNumber = undefined
    }

    return blockNumber === undefined ? { rows, note } : { rows, blockNumber, note }
  }

  /** Read the σ_ref the load surface was/ would be priced against for one token —
   *  a live convenience used to annotate the surface. Returns a typed degraded
   *  result if the VolOracle is uninitialised for the token (never throws). */
  async getSurfaceSigmaRef(
    token: Address,
  ): Promise<Degraded<{ sigmaRefWad: bigint; regime: ReturnType<typeof regimeOf> }>> {
    try {
      const [sigmaRefWad, loadParamsTuple] = await Promise.all([
        this.client.readContract({
          address: this.vol,
          abi: volOracleAbi,
          functionName: 'sigmaRef',
          args: [token],
        }),
        this.client.readContract({
          address: this.core,
          abi: inflexionCoreAbi,
          functionName: 'loadParams',
          args: [],
        }),
      ])
      const params = decodeLoadParams(loadParamsTuple)
      return { available: true, sigmaRefWad, regime: regimeOf(sigmaRefWad, params) }
    } catch {
      return {
        available: false,
        reason: 'VolOracle.sigmaRef reverted (token not initialised) — poke it first',
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // (1) HISTORY / AGGREGATE SURFACES — subgraph-backed via the public API.
  //     The subgraph + API are DEPLOYED (hosted backend). Each method fetches
  //     `endpoint?<query>` via `fetchHistory` when `apiBaseUrl` is configured and
  //     parses the typed body; with no `apiBaseUrl` / a non-OK / an unreachable
  //     response it degrades to a typed `ApiPending` naming the route + query.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * PUB-1 — clearing-load surface time series (the alpha signal): util/conc time-
   * buckets + `totalLoadWad` per bucket, per-fill realized load reconstructed.
   *
   * History/aggregate → API (`GET /data/load-surface`). Served live: the
   * subgraph indexes `MarketStateSnapshot` and joins `SwapPriced`/`QuoteFilled`
   * (the rich per-fill load events, LIVE on-chain since the 2026-06-05 deploy);
   * sparse until volume. For the CURRENT (non-historical) load surface, use
   * `getCurrentLoadSurface` (live RPC).
   */
  async getLoadSurfaceHistory(args: {
    marketId: Hex
    from?: number
    to?: number
    bucket?: '1h' | '1d'
  }): Promise<ApiBacked<LoadSurfaceHistory>> {
    const query: Record<string, string> = {
      marketId: args.marketId,
      ...(args.from !== undefined ? { from: String(args.from) } : {}),
      ...(args.to !== undefined ? { to: String(args.to) } : {}),
      bucket: args.bucket ?? '1d',
    }
    return this.fetchHistory(DATA_API_ROUTES.loadSurface, query, parseLoadSurfaceHistory)
  }

  /**
   * PUB-5 (Signal 2) — pool-vs-MM load SPREAD + MM win-rate / win-depth.
   *
   * History/aggregate → API (`GET /data/quote-competition`). Served live: joins
   * the now-live `SwapPriced` (mechanical pool baseline = the price-to-beat) +
   * `QuoteFilled.loadBps` (behavioral MM load) — both emitted on-chain since the
   * 2026-06-05 deploy — per swap from the subgraph, plus the off-chain engine
   * quote-competition telemetry for the dynamic half. The maturity caveat
   * (structural at launch; dynamic only with ≥3 competing MMs) is carried verbatim.
   */
  async getQuoteCompetition(args: {
    marketId?: Hex
    from?: number
    to?: number
  }): Promise<ApiBacked<QuoteCompetition>> {
    const query: Record<string, string> = {
      ...(args.marketId !== undefined ? { marketId: args.marketId } : {}),
      ...(args.from !== undefined ? { from: String(args.from) } : {}),
      ...(args.to !== undefined ? { to: String(args.to) } : {}),
    }
    return this.fetchHistory(DATA_API_ROUTES.quoteCompetition, query, parseQuoteCompetition)
  }

  /**
   * PUB-5 (Signal 4 latent half) — demand requests including UNFILLED interest
   * (geometries LPs priced but did not buy).
   *
   * History/aggregate → API (`GET /data/demand-requests`). Served live; the latent
   * half is OFF-CHAIN by design: it NEVER reaches the chain (I7 — an unchosen quote
   * touches no nonce/capacity), so it is engine/relayer telemetry surfaced by the
   * API. The realized half is on-chain (subgraph); the latent half is only ever
   * telemetry.
   */
  async getDemandRequests(args: {
    marketId?: Hex
    from?: number
    to?: number
  }): Promise<ApiBacked<DemandRequests>> {
    const query: Record<string, string> = {
      ...(args.marketId !== undefined ? { marketId: args.marketId } : {}),
      ...(args.from !== undefined ? { from: String(args.from) } : {}),
      ...(args.to !== undefined ? { to: String(args.to) } : {}),
    }
    return this.fetchHistory(DATA_API_ROUTES.demandRequests, query, parseDemandRequests)
  }

  /**
   * PUB-2 / DEP-8 — per-tranche NAV day-by-day stress history.
   *
   * History/aggregate → API (`GET /pool/nav-history`). Served live: the
   * subgraph computes `PoolDaySnapshot` from `Deposited`/`Withdrawn`/
   * `PremiumAccrued`/`SettlementReleased`/`JuniorLoss`. Carries claim (B): depositor
   * capital is NOT guaranteed — NAV history is a depositor-risk surface, distinct
   * from the qualified claim (A) "LPs are always paid (no bad debt, FULL, I1)".
   */
  async getNavHistory(args: {
    from?: number
    to?: number
    bucket?: '1d' | '1h'
  }): Promise<ApiBacked<NavHistory>> {
    const bucket = args.bucket ?? '1d'
    // The API param is `day|hour` (app.ts); translate from the SDK's `1d|1h`.
    const apiBucket = bucket === '1h' ? 'hour' : 'day'
    const query: Record<string, string> = {
      ...(args.from !== undefined ? { from: String(args.from) } : {}),
      ...(args.to !== undefined ? { to: String(args.to) } : {}),
      bucket: apiBucket,
    }
    return this.fetchHistory(
      DATA_API_ROUTES.navHistory,
      query,
      (body) => parseNavHistory(body, bucket),
      // Claim (B) disclosure folded into the detail — NEVER merged with claim (A).
      'depositor NAV history (claim B: depositor capital is NOT guaranteed — ' +
        'junior is first-loss, senior is systemic-tail exposed).',
    )
  }

  /**
   * PUB-4 (Signal 5) — protocol-wide NET CONVEXITY / GAMMA supply: total gamma the
   * protocol is short (pool + all MMs) at what aggregate load, plus Σfree/Σlocked.
   *
   * History/aggregate → API (`GET /data/net-gamma`). Served live: OFF-CHAIN
   * compute over the subgraph-tracked open swap set (`SwapCreated` opens,
   * `SwapSettled` closes), summing per-swap Greeks finite-differenced from the
   * deployed `ILMath.computeIL` / `FairValueOracle.fairRate` (§5.5 — no parallel
   * model). NOT a contract event; the API runs the aggregator over the open set.
   */
  async getNetGamma(args: { marketId?: Hex } = {}): Promise<ApiBacked<NetGamma>> {
    const query: Record<string, string> = {
      ...(args.marketId !== undefined ? { marketId: args.marketId } : {}),
    }
    return this.fetchHistory(DATA_API_ROUTES.netGamma, query, parseNetGamma)
  }

  // ─── Internal: fetch an API-backed surface, degrading to ApiPending ───────────

  /**
   * GET `${apiBaseUrl}${endpoint}?${query}` and parse the `{ available:true }`
   * body via `parse`. GRACEFUL by construction — returns the SAME typed
   * `ApiPending` envelope (never throws) when:
   *   - no API base URL / no fetch is wired (the historical default behaviour),
   *   - the request fails / the response is non-OK,
   *   - the API itself returns its own `{ available:false }` pending body
   *     (e.g. the subgraph is unreachable) — its `detail` is surfaced.
   * This is the SDK ↔ API boundary the module's header describes: once an
   * `apiBaseUrl` is configured, the previously-stubbed pending path becomes a
   * real fetch with the exact same degraded fallback.
   */
  private async fetchHistory<T>(
    endpoint: DataApiRoute,
    query: Record<string, string>,
    parse: (body: Record<string, unknown>) => T,
    pendingExtra?: string,
  ): Promise<ApiBacked<T>> {
    const base = this.apiBaseUrl
    const doFetch = this.fetchImpl
    if (base === undefined || doFetch === undefined) {
      // Unwired → identical typed pending as before (zero behavioural change).
      return this.pending(endpoint, query, pendingExtra)
    }
    const url = `${base}${endpoint}${toQueryString(query)}`
    try {
      const res = await doFetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) {
        return this.pending(
          endpoint,
          query,
          joinDetail(pendingExtra, `API responded HTTP ${res.status}.`),
        )
      }
      const body = (await res.json()) as Record<string, unknown>
      if (body['available'] === true) {
        return { available: true, ...parse(body) }
      }
      // The API returned its OWN typed pending (subgraph down, etc.) — surface it.
      const apiDetail = typeof body['detail'] === 'string' ? (body['detail'] as string) : undefined
      return this.pending(endpoint, query, apiDetail ?? pendingExtra)
    } catch (e) {
      return this.pending(
        endpoint,
        query,
        joinDetail(pendingExtra, `API unreachable: ${errMsg(e)}`),
      )
    }
  }

  // ─── Internal: build the typed `ApiPending` envelope ──────────────────────────

  private pending(
    endpoint: DataApiRoute,
    query: Record<string, string>,
    extra?: string,
  ): ApiPending {
    const base =
      `the subgraph + public API are not wired yet (build gap, ACCESS_LAYER §8.1); ` +
      `this surface will be served by '${endpoint}'. Returning a typed degraded ` +
      `result — the SDK never fabricates history.`
    return {
      available: false,
      reason: 'no-history-source',
      endpoint,
      query,
      detail: extra === undefined ? base : `${extra} ${base}`,
    }
  }
}

// ─── Module helpers (pure) ────────────────────────────────────────────────────

/** Encode a flat string map as a `?k=v&…` query string (empty → ''). */
function toQueryString(query: Record<string, string>): string {
  const entries = Object.entries(query)
  if (entries.length === 0) return ''
  return (
    '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  )
}

/** Join an optional prefix detail with a suffix (em-dash separated). */
function joinDetail(prefix: string | undefined, suffix: string): string {
  return prefix === undefined || prefix === '' ? suffix : `${prefix} — ${suffix}`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Coerce a wire value (decimal string / number / bigint) to bigint; 0n on garbage. */
function toBigint(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return 0n
}

/** Map one wire snapshot (`PoolDay/HourSnapshot`) to a normalised `NavSnapshot`,
 *  or undefined if it has no usable bucket timestamp. */
function toNavSnapshot(s: Record<string, unknown>): NavSnapshot | undefined {
  const start = s['dayStart'] ?? s['hourStart'] ?? s['bucketStart']
  const bucketStart = Number(start)
  if (!Number.isFinite(bucketStart)) return undefined
  return {
    bucketStart,
    seniorAssets: toBigint(s['seniorAssets']),
    juniorAssets: toBigint(s['juniorAssets']),
    totalLocked: toBigint(s['totalLocked']),
    utilWad: toBigint(s['utilWad']),
    concWad: toBigint(s['concWad']),
    premiumAccrued: toBigint(s['premiumAccrued']),
    payouts: toBigint(s['payouts']),
    juniorLoss: toBigint(s['juniorLoss']),
    seniorLoss: toBigint(s['seniorLoss']),
  }
}

/** Parse the `/pool/nav-history` body into a typed `NavHistory` (oldest→newest). */
function parseNavHistory(body: Record<string, unknown>, bucket: '1d' | '1h'): NavHistory {
  const raw = Array.isArray(body['snapshots'])
    ? (body['snapshots'] as Record<string, unknown>[])
    : []
  const snapshots = raw
    .map(toNavSnapshot)
    .filter((s): s is NavSnapshot => s !== undefined)
    .sort((a, b) => a.bucketStart - b.bucketStart)
  const disclosure =
    typeof body['disclosure'] === 'string' ? (body['disclosure'] as string) : undefined
  return disclosure !== undefined ? { snapshots, bucket, disclosure } : { snapshots, bucket }
}

/** Attach the API's `disclosure` string to a parsed result, if present (exactOptional-safe). */
function withDisclosure<T extends object>(
  value: T,
  body: Record<string, unknown>,
): T & { disclosure?: string } {
  const disclosure =
    typeof body['disclosure'] === 'string' ? (body['disclosure'] as string) : undefined
  return disclosure !== undefined ? { ...value, disclosure } : value
}

/** Parse `/data/load-surface` → typed `LoadSurfaceHistory` (oldest→newest). */
function parseLoadSurfaceHistory(body: Record<string, unknown>): LoadSurfaceHistory {
  const raw = Array.isArray(body['snapshots'])
    ? (body['snapshots'] as Record<string, unknown>[])
    : []
  const snapshots: LoadSurfacePoint[] = raw
    .map((s) => ({
      bucketStart: Number(s['dayStart']),
      lockedByMarket: toBigint(s['lockedByMarket']),
      utilWad: toBigint(s['utilWad']),
      concWad: toBigint(s['concWad']),
      sigmaRefWad: toBigint(s['sigmaRefWad']),
      baseLoadWad: toBigint(s['baseLoadWad']),
      utilSkewWad: toBigint(s['utilSkewWad']),
      dispSkewWad: toBigint(s['dispSkewWad']),
      totalLoadWad: toBigint(s['totalLoadWad']),
      fillCount: Number(s['fillCount'] ?? 0),
      v0Volume: toBigint(s['v0Volume']),
      pathBFills: Number(s['pathBFills'] ?? 0),
    }))
    .filter((s) => Number.isFinite(s.bucketStart))
    .sort((a, b) => a.bucketStart - b.bucketStart)
  return withDisclosure({ snapshots }, body)
}

/** Parse `/data/quote-competition` → typed `QuoteCompetition`. */
function parseQuoteCompetition(body: Record<string, unknown>): QuoteCompetition {
  const raw = Array.isArray(body['competition'])
    ? (body['competition'] as Record<string, unknown>[])
    : []
  const competition: QuoteCompetitionRow[] = raw.map((c) => ({
    marketId: String(c['marketId'] ?? ''),
    mm: String(c['mm'] ?? ''),
    quotes: Number(c['quotes'] ?? 0),
    accepted: Number(c['accepted'] ?? 0),
    rejected: Number(c['rejected'] ?? 0),
    minLoadBps: Number(c['minLoadBps'] ?? 0),
    maxLoadBps: Number(c['maxLoadBps'] ?? 0),
    avgLoadBps: Number(c['avgLoadBps'] ?? 0),
    lastSeen: Number(c['lastSeen'] ?? 0),
  }))
  return withDisclosure({ competition, enabled: body['enabled'] === true }, body)
}

/** Parse `/data/demand-requests` → typed `DemandRequests` (realized flattened). */
function parseDemandRequests(body: Record<string, unknown>): DemandRequests {
  const realizedEnv = (body['realized'] ?? {}) as Record<string, unknown>
  const realizedAvailable = realizedEnv['available'] === true
  const realizedRaw = Array.isArray(realizedEnv['buckets'])
    ? (realizedEnv['buckets'] as Record<string, unknown>[])
    : []
  const realized: RealizedDemandBucket[] = realizedRaw.map((b) => ({
    id: String(b['id'] ?? ''),
    widthBucket: String(b['widthBucket'] ?? ''),
    distanceBucket: String(b['distanceBucket'] ?? ''),
    durationBucket: String(b['durationBucket'] ?? ''),
    realizedFillCount: Number(b['realizedFillCount'] ?? 0),
    realizedV0: toBigint(b['realizedV0']),
    firstSeen: Number(b['firstSeen'] ?? 0),
    lastSeen: Number(b['lastSeen'] ?? 0),
  }))
  const latentRaw = Array.isArray(body['latent'])
    ? (body['latent'] as Record<string, unknown>[])
    : []
  const latent: LatentDemandBucket[] = latentRaw.map((b) => ({
    marketId: String(b['marketId'] ?? ''),
    widthBucket: String(b['widthBucket'] ?? ''),
    distanceBucket: String(b['distanceBucket'] ?? ''),
    durationBucket: String(b['durationBucket'] ?? ''),
    count: Number(b['count'] ?? 0),
    previews: Number(b['previews'] ?? 0),
    quoteRequests: Number(b['quoteRequests'] ?? 0),
    firstSeen: Number(b['firstSeen'] ?? 0),
    lastSeen: Number(b['lastSeen'] ?? 0),
  }))
  return withDisclosure(
    { realized, realizedAvailable, latent, latentEnabled: body['latentEnabled'] === true },
    body,
  )
}

/** Parse `/data/net-gamma` → typed `NetGamma` (snapshots oldest→newest + protocolState). */
function parseNetGamma(body: Record<string, unknown>): NetGamma {
  const raw = Array.isArray(body['snapshots'])
    ? (body['snapshots'] as Record<string, unknown>[])
    : []
  const snapshots: NetGammaPoint[] = raw
    .map((s) => ({
      bucketStart: Number(s['bucketStart']),
      activeSwapCount: Number(s['activeSwapCount'] ?? 0),
      totalV0: toBigint(s['totalV0']),
      totalMaxIL: toBigint(s['totalMaxIL']),
      aggGammaWad: toBigint(s['aggGammaWad']),
      aggVegaWad: toBigint(s['aggVegaWad']),
      volumeWeightedLoadWad: toBigint(s['volumeWeightedLoadWad']),
    }))
    .filter((s) => Number.isFinite(s.bucketStart))
    .sort((a, b) => a.bucketStart - b.bucketStart)
  const ps = (body['protocolState'] ?? {}) as Record<string, unknown>
  const protocolState: NetGammaState = {
    activeSwapCount: Number(ps['activeSwapCount'] ?? 0),
    totalActiveV0: toBigint(ps['totalActiveV0']),
    totalActiveMaxIL: toBigint(ps['totalActiveMaxIL']),
  }
  return withDisclosure({ snapshots, protocolState }, body)
}

/** Convenience constructor matching the other surface modules' factory style. */
export function makeDataClient(
  client: PublicClient,
  opts?: ConstructorParameters<typeof DataClient>[1],
): DataClient {
  return new DataClient(client, opts ?? {})
}
