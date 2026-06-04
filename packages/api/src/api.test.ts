/**
 * Offline tests — NO live network, NO RPC, NO filesystem dependence. The subgraph
 * GraphQL client is driven by an injected fetch; the telemetry reader by an
 * injected JSONL reader; the live surface by an injected fake DataClient. This is
 * the CI-safety contract: `pnpm -r test` runs these fully offline.
 */
import { describe, it, expect } from 'vitest'
import { TtlCache, TTL } from './cache.js'
import { SubgraphClient } from './subgraph.js'
import { TelemetryReader } from './telemetry.js'
import { QUERIES } from './queries.js'
import { buildDeps } from './index.js'
import {
  getMarkets,
  getConvexitySurface,
  getDemandRequests,
  getQuoteCompetition,
  getCurrentLoadSurface,
  getNavHistory,
  getPoolState,
  getPricingPreview,
  getSwaps,
  type HandlerDeps,
} from './handlers.js'
import { OPENAPI_DOCUMENT, DOCS_HTML } from './openapi.js'

// ─── TtlCache ─────────────────────────────────────────────────────────────────

describe('TtlCache', () => {
  it('returns a hit before expiry and a miss after', () => {
    let t = 1000
    const cache = new TtlCache(() => t)
    cache.set('k', 42, 100)
    expect(cache.get<number>('k')).toBe(42)
    t = 1101
    expect(cache.get<number>('k')).toBeUndefined()
  })

  it('wrap() memoises the producer for the TTL window', async () => {
    let t = 0
    let calls = 0
    const cache = new TtlCache(() => t)
    const produce = async () => {
      calls += 1
      return calls
    }
    expect(await cache.wrap('k', 100, produce)).toBe(1)
    expect(await cache.wrap('k', 100, produce)).toBe(1) // cached
    t = 200
    expect(await cache.wrap('k', 100, produce)).toBe(2) // expired → re-run
  })

  it('exposes the spec TTLs', () => {
    expect(TTL.convexitySurface).toBe(300_000)
    expect(TTL.quote).toBe(1_000)
  })
})

// ─── SubgraphClient graceful degradation ───────────────────────────────────────

describe('SubgraphClient', () => {
  it('degrades to not-configured with no url', async () => {
    const sg = new SubgraphClient({})
    expect(sg.configured).toBe(false)
    const out = await sg.query('{ markets { id } }')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('not-configured')
  })

  it('degrades to unreachable on a network failure', async () => {
    const sg = new SubgraphClient({
      url: 'https://example.invalid/graphql',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    const out = await sg.query('{ markets { id } }')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unreachable')
  })

  it('surfaces graphql-error payloads', async () => {
    const sg = new SubgraphClient({
      url: 'https://x/graphql',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ errors: [{ message: 'bad field' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    const out = await sg.query('{ x }')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toBe('graphql-error')
      expect(out.detail).toContain('bad field')
    }
  })

  it('returns data on success', async () => {
    const sg = new SubgraphClient({
      url: 'https://x/graphql',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { markets: [{ id: '0xabc' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    const out = await sg.query<{ markets: { id: string }[] }>('{ markets { id } }')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data.markets[0]!.id).toBe('0xabc')
  })
})

// ─── TelemetryReader aggregation (Signals 2 & 4 dynamic halves) ────────────────

const DEMAND_JSONL = [
  JSON.stringify({
    ts: 100,
    marketId: '0xaa',
    widthBucket: 'tight',
    distanceBucket: 'at-edge',
    durationBucket: 'week',
    previewedPremium: '777',
    filled: false,
    source: 'preview',
  }),
  JSON.stringify({
    ts: 200,
    marketId: '0xaa',
    widthBucket: 'tight',
    distanceBucket: 'at-edge',
    durationBucket: 'week',
    filled: false,
    source: 'quote-request',
  }),
  '   ', // blank line tolerated
  '{not valid json', // malformed line skipped
].join('\n')

const COMPETITION_JSONL = [
  JSON.stringify({
    ts: 10,
    marketId: '0xaa',
    mm: '0xm1',
    loadBps: 500,
    validUntil: '20',
    accepted: true,
  }),
  JSON.stringify({
    ts: 11,
    marketId: '0xaa',
    mm: '0xm1',
    loadBps: 300,
    validUntil: '21',
    accepted: false,
    reason: 'bad-signature',
  }),
].join('\n')

describe('TelemetryReader', () => {
  it('reports sinks disabled when no path configured', () => {
    const tr = new TelemetryReader({})
    expect(tr.demandEnabled).toBe(false)
    expect(tr.competitionEnabled).toBe(false)
    expect(tr.demandSurface()).toEqual([])
    expect(tr.competitionSurface()).toEqual([])
  })

  it('aggregates the latent-demand surface (skips blank/malformed lines)', () => {
    const tr = new TelemetryReader({
      demandLogPath: '/fake/demand.jsonl',
      readJsonl: () => DEMAND_JSONL,
    })
    const surf = tr.demandSurface()
    expect(surf).toHaveLength(1)
    expect(surf[0]!.count).toBe(2)
    expect(surf[0]!.previews).toBe(1)
    expect(surf[0]!.quoteRequests).toBe(1)
    expect(surf[0]!.firstSeen).toBe(100)
    expect(surf[0]!.lastSeen).toBe(200)
  })

  it('aggregates quote competition per MM with min/max/avg load', () => {
    const tr = new TelemetryReader({
      competitionLogPath: '/fake/comp.jsonl',
      readJsonl: () => COMPETITION_JSONL,
    })
    const surf = tr.competitionSurface()
    expect(surf).toHaveLength(1)
    expect(surf[0]!.quotes).toBe(2)
    expect(surf[0]!.accepted).toBe(1)
    expect(surf[0]!.rejected).toBe(1)
    expect(surf[0]!.minLoadBps).toBe(300)
    expect(surf[0]!.maxLoadBps).toBe(500)
    expect(surf[0]!.avgLoadBps).toBe(400)
  })

  it('filters by marketId and since', () => {
    const tr = new TelemetryReader({
      demandLogPath: '/fake/demand.jsonl',
      readJsonl: () => DEMAND_JSONL,
    })
    expect(tr.demandRecords({ marketId: '0xbb' })).toHaveLength(0)
    expect(tr.demandRecords({ since: 150 })).toHaveLength(1)
  })
})

// ─── Handlers — graceful degradation + telemetry-backed live data ──────────────

function depsWithMockSubgraph(data: Record<string, unknown>): HandlerDeps {
  const subgraph = new SubgraphClient({
    url: 'https://x/graphql',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  })
  return { subgraph, telemetry: new TelemetryReader({}), cache: new TtlCache() }
}

describe('handlers — graceful degradation (no backings)', () => {
  const deps = buildDeps({})

  it('markets returns pending subgraph-not-deployed with the embedded query', async () => {
    const r = await getMarkets(deps)
    expect(r.available).toBe(false)
    if (!r.available) {
      expect(r.reason).toBe('subgraph-not-deployed')
      expect(r.query).toBe(QUERIES.markets)
    }
  })

  it('convexity-surface (Signal 1/2) pends with the bucketAggregates query', async () => {
    const r = await getConvexitySurface(deps)
    expect(r.available).toBe(false)
    if (!r.available) expect(r.query).toBe(QUERIES.bucketAggregates)
  })

  it('live load surface pends with rpc-unavailable when no RPC wired', async () => {
    const r = await getCurrentLoadSurface(deps, [])
    expect(r.available).toBe(false)
    if (!r.available) expect(r.reason).toBe('rpc-unavailable')
  })

  it('quote-competition pends when the sink is absent', async () => {
    const r = await getQuoteCompetition(deps)
    expect(r.available).toBe(false)
    if (!r.available) expect(r.reason).toBe('telemetry-sink-absent')
  })

  it('nav-history pends with the claim-B-bearing day query', async () => {
    const r = await getNavHistory(deps, 'day')
    expect(r.available).toBe(false)
    if (!r.available) expect(r.query).toBe(QUERIES.poolDaySnapshots)
  })
})

describe('handlers — available paths', () => {
  it('markets returns subgraph data when reachable', async () => {
    const deps = depsWithMockSubgraph({ markets: [{ id: '0x01' }] })
    const r = await getMarkets(deps)
    expect(r.available).toBe(true)
    if (r.available) expect(r.markets).toHaveLength(1)
  })

  it('demand-requests merges realized(subgraph) + latent(telemetry)', async () => {
    const subgraph = new SubgraphClient({
      url: 'https://x/graphql',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ data: { geometryDemandBuckets: [{ id: 'tight-mid-week' }] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )) as unknown as typeof fetch,
    })
    const telemetry = new TelemetryReader({
      demandLogPath: '/fake/demand.jsonl',
      readJsonl: () => DEMAND_JSONL,
    })
    const deps: HandlerDeps = { subgraph, telemetry, cache: new TtlCache() }
    const r = await getDemandRequests(deps)
    expect(r.available).toBe(true)
    if (r.available) {
      expect(r.latentEnabled).toBe(true)
      expect(r.latent).toHaveLength(1)
      // realized half present (subgraph returned data)
      expect((r.realized as { available: boolean }).available).toBe(true)
    }
  })

  it('live load surface uses an injected DataClient (no real RPC)', async () => {
    const fakeData = {
      getCurrentLoadSurface: async () => ({ rows: [], note: 'fake' }),
    } as unknown as import('@inflexion/sdk').DataClient
    const deps = buildDeps({ data: fakeData })
    const r = await getCurrentLoadSurface(deps, ['0x' + 'ab'.repeat(32)] as `0x${string}`[])
    expect(r.available).toBe(true)
  })
})

// ─── Query strings — sanity (the deliverable the API documents per signal) ─────

describe('GraphQL query shapes', () => {
  it('every query is a non-empty GraphQL string', () => {
    for (const [name, q] of Object.entries(QUERIES)) {
      expect(typeof q, name).toBe('string')
      expect(q.length, name).toBeGreaterThan(10)
      expect(q, name).toContain('query')
    }
  })

  it('Signal 1/2 bucket query excludes cap-bound fills in the per-fill join', () => {
    expect(QUERIES.bucketFills).toContain('cappedAtMaxIL: false')
  })

  it('Signal 5 active-swap query filters the open set', () => {
    expect(QUERIES.activeSwaps).toContain('isActive: true')
  })

  it('the swaps-list query is present and orders by recency', () => {
    expect(QUERIES.swaps).toContain('swaps(')
    expect(QUERIES.swaps).toContain('orderBy: createdAtTimestamp')
  })
})

// ─── LIVE pool state (/pool) — SDK DepositorClient, claim B ────────────────────

describe('getPoolState (/pool)', () => {
  it('pends rpc-unavailable when no depositor (RPC) is wired', async () => {
    const deps = buildDeps({})
    const r = await getPoolState(deps)
    expect(r.available).toBe(false)
    if (!r.available) expect(r.reason).toBe('rpc-unavailable')
  })

  it('surfaces the vault state + claim-B disclosure via an injected DepositorClient', async () => {
    const fakeDepositor = {
      getVaultState: async () => ({
        available: true,
        totalAssets: 1000n,
        seniorAssets: 600n,
        juniorAssets: 400n,
        capitalNotGuaranteed: true,
      }),
    } as unknown as import('@inflexion/sdk').DepositorClient
    const deps: HandlerDeps = {
      subgraph: new SubgraphClient({}),
      telemetry: new TelemetryReader({}),
      cache: new TtlCache(),
      depositor: fakeDepositor,
    }
    const r = await getPoolState(deps)
    expect(r.available).toBe(true)
    if (r.available) {
      expect((r.pool as { seniorAssets: bigint }).seniorAssets).toBe(600n)
      expect(r.disclosure).toContain('NOT guaranteed')
    }
  })

  it('forwards a degraded vault state as pending (never throws)', async () => {
    const fakeDepositor = {
      getVaultState: async () => ({ available: false, reason: 'vol-uninitialized' }),
    } as unknown as import('@inflexion/sdk').DepositorClient
    const deps: HandlerDeps = {
      subgraph: new SubgraphClient({}),
      telemetry: new TelemetryReader({}),
      cache: new TtlCache(),
      depositor: fakeDepositor,
    }
    const r = await getPoolState(deps)
    expect(r.available).toBe(false)
    if (!r.available) {
      expect(r.reason).toBe('rpc-unavailable')
      expect(r.detail).toContain('vol-uninitialized')
    }
  })
})

// ─── LIVE pricing preview (/pricing/preview) — SDK current-load surface ────────

describe('getPricingPreview (/pricing/preview)', () => {
  const MARKET = ('0x' + 'ab'.repeat(32)) as `0x${string}`

  it('pends rpc-unavailable when no DataClient is wired', async () => {
    const deps = buildDeps({})
    const r = await getPricingPreview(deps, { marketId: MARKET })
    expect(r.available).toBe(false)
    if (!r.available) expect(r.reason).toBe('rpc-unavailable')
  })

  it('returns the first surface row (reuses the SDK; no re-derivation)', async () => {
    const fakeData = {
      getCurrentLoadSurface: async () => ({
        rows: [{ available: true, marketId: MARKET, fairPremium: 777n, poolPremium: 800n }],
        note: 'fake',
      }),
    } as unknown as import('@inflexion/sdk').DataClient
    const deps = buildDeps({ data: fakeData })
    const r = await getPricingPreview(deps, { marketId: MARKET })
    expect(r.available).toBe(true)
    if (r.available) {
      expect((r.pricing as { fairPremium: bigint }).fairPremium).toBe(777n)
    }
  })

  it('passes a full geometry override through to the SDK', async () => {
    let captured: unknown
    const fakeData = {
      getCurrentLoadSurface: async (args: unknown) => {
        captured = args
        return { rows: [{ available: true, marketId: MARKET }], note: 'fake' }
      },
    } as unknown as import('@inflexion/sdk').DataClient
    const deps = buildDeps({ data: fakeData })
    await getPricingPreview(deps, { marketId: MARKET, aWad: 81n, bWad: 121n, maxIL: 1000n })
    const markets = (captured as { markets: Array<{ geometry?: unknown }> }).markets
    expect(markets[0]!.geometry).toEqual({ aWad: 81n, bWad: 121n, maxIL: 1000n })
  })
})

// ─── Swaps list (/swaps) — subgraph, claim A ───────────────────────────────────

describe('getSwaps (/swaps)', () => {
  it('pends subgraph-not-deployed with no backing', async () => {
    const deps = buildDeps({})
    const r = await getSwaps(deps)
    expect(r.available).toBe(false)
    if (!r.available) {
      expect(r.reason).toBe('subgraph-not-deployed')
      expect(r.query).toBe(QUERIES.swaps)
    }
  })

  it('returns swaps + the claim-A disclosure when the subgraph is reachable', async () => {
    const deps = depsWithMockSubgraph({ swaps: [{ id: '1' }, { id: '2' }] })
    const r = await getSwaps(deps, { status: 'active' })
    expect(r.available).toBe(true)
    if (r.available) {
      expect(r.swaps).toHaveLength(2)
      expect(r.disclosure).toContain('no bad debt in FULL')
    }
  })
})

// ─── OpenAPI document + docs shell ─────────────────────────────────────────────

describe('OpenAPI', () => {
  it('is a valid-shaped 3.1 document covering the task endpoints', () => {
    expect(OPENAPI_DOCUMENT.openapi).toBe('3.1.0')
    const paths = Object.keys(OPENAPI_DOCUMENT.paths)
    for (const p of [
      '/health',
      '/markets',
      '/markets/{id}',
      '/pool',
      '/pool/nav-history',
      '/swaps',
      '/swaps/{swapId}',
      '/pricing/preview',
      '/data/load-surface',
      '/data/quote-competition',
      '/data/demand-requests',
      '/data/term-structure',
      '/data/net-gamma',
    ]) {
      expect(paths, p).toContain(p)
    }
  })

  it('serves a docs HTML shell referencing the spec', () => {
    expect(DOCS_HTML).toContain('/openapi.json')
    expect(DOCS_HTML).toContain('swagger-ui')
  })
})
