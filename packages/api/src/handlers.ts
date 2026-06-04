/**
 * Endpoint handlers — pure functions from (deps, params) → ApiResult. The HTTP
 * layer (app.ts/server.ts) is a thin router over these; keeping the logic here
 * makes every endpoint unit-testable OFFLINE (mock subgraph + injected fetch +
 * injected telemetry reader; no live network).
 *
 * Three-layer rule in practice:
 *   - SUBGRAPH-backed (history/aggregate): runs a GraphQL query; today the subgraph
 *     is not deployed, so it returns `pending` with the EXACT query embedded.
 *   - LIVE RPC: reuses @inflexion/sdk DataClient.getCurrentLoadSurface — the SDK
 *     owns pricing; the API never re-derives the fair rate / load stack.
 *   - TELEMETRY: reads the engine JSONL sinks for the dynamic moat halves.
 */
import type { DataClient, DepositorClient } from '@inflexion/sdk'
import type { Hex } from 'viem'
import { SubgraphClient } from './subgraph.js'
import { TelemetryReader } from './telemetry.js'
import { TtlCache, TTL } from './cache.js'
import {
  type ApiResult,
  type Pending,
  available,
  pending,
  CLAIM_A_DISCLOSURE,
  CLAIM_B_DISCLOSURE,
  MATURITY_DISCLAIMER,
} from './types.js'
import { QUERIES } from './queries.js'

export interface HandlerDeps {
  subgraph: SubgraphClient
  telemetry: TelemetryReader
  cache: TtlCache
  /** SDK DataClient for the ONE live surface (current pool-load) + the cached
   *  pricing preview. Optional: if no RPC is wired the live endpoints degrade to
   *  `pending` rather than crash. */
  data?: DataClient
  /** SDK DepositorClient for the LIVE vault-state composite (`/pool`). Optional:
   *  absent ⇒ `/pool` degrades to `pending` (no RPC). Carries the claim-B flag. */
  depositor?: DepositorClient
}

/** Map a non-ok subgraph outcome to a typed Pending body, embedding the query. */
function subgraphPending(
  reason: 'not-configured' | 'unreachable' | 'graphql-error',
  detail: string,
  query: string,
): Pending {
  const r = reason === 'not-configured' ? 'subgraph-not-deployed' : 'subgraph-unreachable'
  return pending(r, detail, query)
}

// ─── Markets directory (PUB-2) ────────────────────────────────────────────────

export async function getMarkets(deps: HandlerDeps): Promise<ApiResult<{ markets: unknown[] }>> {
  return deps.cache.wrap('markets', TTL.markets, async () => {
    const res = await deps.subgraph.query<{ markets: unknown[] }>(QUERIES.markets)
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.markets)
    return available({ markets: res.data.markets })
  })
}

export async function getMarketById(
  deps: HandlerDeps,
  id: string,
): Promise<ApiResult<{ market: unknown }>> {
  return deps.cache.wrap(`market:${id}`, TTL.marketById, async () => {
    const res = await deps.subgraph.query<{ market: unknown }>(QUERIES.marketById, {
      id: id.toLowerCase(),
    })
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.marketById)
    return available({ market: res.data.market })
  })
}

// ─── THE LIVE SURFACE — current pool-load across markets (PUB-1 snapshot) ─────
// Reuses the SDK multicall. This works NOW (pre-redeploy) — it reads public
// getters, not the rich events. The HISTORICAL evolution is subgraph-backed below.

export async function getCurrentLoadSurface(
  deps: HandlerDeps,
  marketIds: Hex[],
): Promise<ApiResult<{ surface: unknown; note: string; disclosure: string }>> {
  const key = `load-surface-live:${marketIds.join(',')}`
  return deps.cache.wrap(key, TTL.poolState, async () => {
    if (deps.data === undefined) {
      return pending('rpc-unavailable', 'no RPC wired; live current-load surface unavailable')
    }
    try {
      const surface = await deps.data.getCurrentLoadSurface({
        markets: marketIds.map((marketId) => ({ marketId })),
      })
      return available({
        surface,
        note: 'LIVE uncached pool-load surface via the SDK multicall (price-to-beat).',
        disclosure: MATURITY_DISCLAIMER,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return pending('rpc-unavailable', `live load surface read failed: ${detail}`)
    }
  })
}

// ─── LIVE pool state composite (DEP-1/DEP-6) — SDK getVaultState, claim B ─────
// Reuses the SDK DepositorClient so the API never re-derives the load stack. The
// two depositor claims are NEVER merged: this is a depositor-risk (claim B) surface.

export async function getPoolState(
  deps: HandlerDeps,
  marketIds: Hex[] = [],
): Promise<ApiResult<{ pool: unknown; disclosure: string }>> {
  const key = `pool-state:${marketIds.join(',')}`
  return deps.cache.wrap(key, TTL.poolState, async () => {
    if (deps.depositor === undefined) {
      return pending('rpc-unavailable', 'no RPC wired; live pool state unavailable')
    }
    try {
      const state = await deps.depositor.getVaultState(
        marketIds.length > 0 ? { marketIds } : undefined,
      )
      // getVaultState returns a typed Degraded<VaultState> — surface it as-is, never throw.
      if (!state.available) {
        return pending('rpc-unavailable', `pool state degraded: ${state.reason}`)
      }
      return available({ pool: state, disclosure: CLAIM_B_DISCLOSURE })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return pending('rpc-unavailable', `pool state read failed: ${detail}`)
    }
  })
}

// ─── LIVE pricing preview (PUB-2 / LP-8) — cached SDK current-load surface ─────
// The SDK owns the fair rate + load stack; the API only forwards a single-market
// read of the live surface (which already returns fairPremium + poolPremium). The
// API NEVER re-derives the Φ-sum fair rate (CLAUDE.md hard rule).

export interface PricingPreviewArgs {
  marketId: Hex
  /** a = (Pa/P0)² (WAD). Omit ⇒ the SDK neutral reference geometry is used. */
  aWad?: bigint
  /** b = (Pb/P0)² (WAD). */
  bWad?: bigint
  /** MaxIL (raw) the pool premium is clamped to. */
  maxIL?: bigint
}

export async function getPricingPreview(
  deps: HandlerDeps,
  args: PricingPreviewArgs,
): Promise<ApiResult<{ pricing: unknown; note: string }>> {
  const key = `pricing-preview:${args.marketId}:${args.aWad ?? ''}:${args.bWad ?? ''}:${args.maxIL ?? ''}`
  return deps.cache.wrap(key, TTL.pricingPreview, async () => {
    if (deps.data === undefined) {
      return pending('rpc-unavailable', 'no RPC wired; live pricing preview unavailable')
    }
    // Build the per-market geometry override only when ALL three are supplied
    // (a partial geometry is ambiguous; fall back to the SDK neutral reference).
    const hasGeometry =
      args.aWad !== undefined && args.bWad !== undefined && args.maxIL !== undefined
    try {
      const surface = await deps.data.getCurrentLoadSurface({
        markets: [
          hasGeometry
            ? {
                marketId: args.marketId,
                geometry: { aWad: args.aWad!, bWad: args.bWad!, maxIL: args.maxIL! },
              }
            : { marketId: args.marketId },
        ],
      })
      const row = surface.rows[0]
      if (row === undefined) {
        return pending('rpc-unavailable', 'live pricing preview returned no row')
      }
      return available({
        pricing: row,
        note:
          'LIVE cached fair + pool premium via the SDK current-load surface ' +
          '(the SDK owns pricing; the API never re-derives the fair rate).',
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return pending('rpc-unavailable', `pricing preview read failed: ${detail}`)
    }
  })
}

// ─── Historical load surface evolution (PUB-1 series) — subgraph ──────────────

export async function getLoadSurfaceHistory(
  deps: HandlerDeps,
  marketId: string,
): Promise<ApiResult<{ snapshots: unknown[]; disclosure: string }>> {
  return deps.cache.wrap(`load-surface-hist:${marketId}`, TTL.loadSurface, async () => {
    const res = await deps.subgraph.query<{ marketStateSnapshots: unknown[] }>(
      QUERIES.marketState,
      {
        market: marketId.toLowerCase(),
      },
    )
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.marketState)
    return available({ snapshots: res.data.marketStateSnapshots, disclosure: MATURITY_DISCLAIMER })
  })
}

// ─── Signal 1 & 2 — clearing-load + pool-vs-MM spread (bucketed) ──────────────

export async function getConvexitySurface(
  deps: HandlerDeps,
): Promise<ApiResult<{ buckets: unknown[]; disclosure: string }>> {
  return deps.cache.wrap('convexity-surface', TTL.convexitySurface, async () => {
    const res = await deps.subgraph.query<{ bucketAggregates: unknown[] }>(QUERIES.bucketAggregates)
    if (!res.ok) {
      // Pre-redeploy the rich events (SwapPriced/QuoteFilled) never fire, so even a
      // deployed-but-quiet subgraph has empty buckets — flag the right reason.
      const body = subgraphPending(res.reason, res.detail, QUERIES.bucketAggregates)
      return body
    }
    return available({ buckets: res.data.bucketAggregates, disclosure: MATURITY_DISCLAIMER })
  })
}

// ─── Signal 3 — term structure of convexity (slope) ───────────────────────────

export async function getTermStructure(
  deps: HandlerDeps,
  width: string,
  distance: string,
): Promise<ApiResult<{ points: unknown[]; disclosure: string }>> {
  return deps.cache.wrap(`term-structure:${width}:${distance}`, TTL.convexitySurface, async () => {
    const res = await deps.subgraph.query<{ bucketAggregates: unknown[] }>(QUERIES.termStructure, {
      width,
      distance,
    })
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.termStructure)
    return available({ points: res.data.bucketAggregates, disclosure: MATURITY_DISCLAIMER })
  })
}

// ─── Signal 4 — moneyness / demand skew (realized + latent) ───────────────────

export async function getDemandRequests(
  deps: HandlerDeps,
  opts: { marketId?: string; since?: number } = {},
): Promise<
  ApiResult<{ realized: unknown; latent: unknown[]; latentEnabled: boolean; disclosure: string }>
> {
  // Realized half = subgraph (pending until deployed). Latent half = engine telemetry
  // (LIVE now). We surface both, each with its own availability.
  const realizedRes = await deps.subgraph.query<{ geometryDemandBuckets: unknown[] }>(
    QUERIES.geometryDemand,
  )
  const realized: unknown = realizedRes.ok
    ? { available: true, buckets: realizedRes.data.geometryDemandBuckets }
    : subgraphPending(realizedRes.reason, realizedRes.detail, QUERIES.geometryDemand)

  const latent = deps.telemetry.demandSurface(opts)
  return available({
    realized,
    latent,
    latentEnabled: deps.telemetry.demandEnabled,
    disclosure: MATURITY_DISCLAIMER,
  })
}

// ─── Signal 2 — quote competition (dynamic half from telemetry) ───────────────

export async function getQuoteCompetition(
  deps: HandlerDeps,
  opts: { marketId?: string; since?: number } = {},
): Promise<ApiResult<{ competition: unknown[]; enabled: boolean; disclosure: string }>> {
  if (!deps.telemetry.competitionEnabled) {
    return pending(
      'telemetry-sink-absent',
      'COMPETITION_LOG not configured on the engine; the dynamic half of Signal 2 is unavailable',
    )
  }
  const competition = deps.telemetry.competitionSurface(opts)
  return available({ competition, enabled: true, disclosure: MATURITY_DISCLAIMER })
}

// ─── Signal 5 — net gamma / supply depth ──────────────────────────────────────

export async function getNetGamma(
  deps: HandlerDeps,
): Promise<ApiResult<{ snapshots: unknown[]; protocolState: unknown; disclosure: string }>> {
  return deps.cache.wrap('net-gamma', TTL.netGamma, async () => {
    const res = await deps.subgraph.query<{ netGammaSnapshots: unknown[]; protocolState: unknown }>(
      QUERIES.netGamma,
    )
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.netGamma)
    return available({
      snapshots: res.data.netGammaSnapshots,
      protocolState: res.data.protocolState,
      disclosure: MATURITY_DISCLAIMER,
    })
  })
}

export async function getSupplyDepth(
  deps: HandlerDeps,
): Promise<ApiResult<{ activeSwaps: unknown[]; disclosure: string }>> {
  return deps.cache.wrap('supply-depth', TTL.supplyDepth, async () => {
    const res = await deps.subgraph.query<{ swaps: unknown[] }>(QUERIES.activeSwaps)
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.activeSwaps)
    return available({ activeSwaps: res.data.swaps, disclosure: MATURITY_DISCLAIMER })
  })
}

// ─── Pool NAV / timeseries (DEP-8/DEP-9, claim B) ─────────────────────────────

export async function getNavHistory(
  deps: HandlerDeps,
  bucket: 'day' | 'hour' = 'day',
): Promise<ApiResult<{ snapshots: unknown[]; disclosure: string }>> {
  const q = bucket === 'hour' ? QUERIES.poolHourSnapshots : QUERIES.poolDaySnapshots
  return deps.cache.wrap(`nav-history:${bucket}`, TTL.navHistory, async () => {
    const res = await deps.subgraph.query<Record<string, unknown[]>>(q)
    if (!res.ok) return subgraphPending(res.reason, res.detail, q)
    const key = bucket === 'hour' ? 'poolHourSnapshots' : 'poolDaySnapshots'
    return available({ snapshots: res.data[key] ?? [], disclosure: CLAIM_B_DISCLOSURE })
  })
}

// ─── MM fills / PnL (MM-10) ───────────────────────────────────────────────────

export async function getMmFills(
  deps: HandlerDeps,
  address: string,
): Promise<ApiResult<{ marketMaker: unknown; swaps: unknown[]; disclosure: string }>> {
  return deps.cache.wrap(`mm-fills:${address}`, TTL.mmFills, async () => {
    const res = await deps.subgraph.query<{ marketMaker: unknown; swaps: unknown[] }>(
      QUERIES.marketMaker,
      { id: address.toLowerCase() },
    )
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.marketMaker)
    return available({
      marketMaker: res.data.marketMaker,
      swaps: res.data.swaps,
      disclosure: CLAIM_A_DISCLOSURE,
    })
  })
}

// ─── Swaps list (subgraph; optional status / mm / market filters; claim A) ────

export interface SwapsFilter {
  status?: 'active' | 'settled'
  mm?: string
  market?: string
  first?: number
}

export async function getSwaps(
  deps: HandlerDeps,
  filter: SwapsFilter = {},
): Promise<ApiResult<{ swaps: unknown[]; disclosure: string }>> {
  const first = filter.first !== undefined ? Math.min(Math.max(filter.first, 1), 1000) : 100
  // Build the GraphQL `where` from validated filters (handler-side, not user-injected).
  const where: Record<string, unknown> = {}
  if (filter.status === 'active') where['isActive'] = true
  else if (filter.status === 'settled') where['status'] = 'SETTLED'
  if (filter.mm !== undefined) where['mm'] = filter.mm.toLowerCase()
  if (filter.market !== undefined) where['market'] = filter.market.toLowerCase()

  const key = `swaps:${filter.status ?? ''}:${filter.mm ?? ''}:${filter.market ?? ''}:${first}`
  return deps.cache.wrap(key, TTL.swapById, async () => {
    const res = await deps.subgraph.query<{ swaps: unknown[] }>(QUERIES.swaps, {
      first,
      where: Object.keys(where).length > 0 ? where : null,
    })
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.swaps)
    return available({ swaps: res.data.swaps, disclosure: CLAIM_A_DISCLOSURE })
  })
}

// ─── Single swap (subgraph + the claim-A payout disclosure) ───────────────────

export async function getSwapById(
  deps: HandlerDeps,
  swapId: string,
): Promise<ApiResult<{ swap: unknown; disclosure: string }>> {
  return deps.cache.wrap(`swap:${swapId}`, TTL.swapById, async () => {
    const res = await deps.subgraph.query<{ swap: unknown }>(QUERIES.swapById, { id: swapId })
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.swapById)
    return available({ swap: res.data.swap, disclosure: CLAIM_A_DISCLOSURE })
  })
}

// ─── σ_ref history (PUB-2) ────────────────────────────────────────────────────

export async function getSigmaHistory(
  deps: HandlerDeps,
  token: string,
): Promise<ApiResult<{ points: unknown[] }>> {
  return deps.cache.wrap(`sigma:${token}`, TTL.sigmaHistory, async () => {
    const res = await deps.subgraph.query<{ sigmaPoints: unknown[] }>(QUERIES.sigmaHistory, {
      token: token.toLowerCase(),
    })
    if (!res.ok) return subgraphPending(res.reason, res.detail, QUERIES.sigmaHistory)
    return available({ points: res.data.sigmaPoints })
  })
}
