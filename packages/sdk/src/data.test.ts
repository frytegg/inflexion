/**
 * `DataClient` tests.
 *
 * Two assertion paths (mirroring math.parity.test.ts):
 *  1. ALWAYS (offline) — the SDK ↔ API boundary: the history/aggregate methods
 *     return typed `ApiPending` envelopes naming the FUTURE route + echoing the
 *     query, NEVER throwing; the live load surface degrades gracefully on an empty
 *     set, a failed pool-wide read, an unknown market, and a reverting oracle —
 *     all via a MOCKED PublicClient (no RPC). This is the tested fallback path.
 *  2. WHEN AN RPC IS AVAILABLE — read the real demo market's load surface and
 *     assert the live row is well-formed (fairPremium > 0, load ≤ maxLoad, etc.).
 */
import { describe, expect, it } from 'vitest'
import type { Hex, PublicClient } from 'viem'

import { DataClient, DATA_API_ROUTES, makeDataClient } from './data.js'
import { makePublicClient, resolveRpcUrl } from './client.js'
import { demo, tokens } from './addresses.js'
import { WAD } from './math.js'

// ─── The live loadParams() tuple (mirrors math.parity.test.ts P) ──────────────
const LOAD_PARAMS_TUPLE = [
  2000n,
  3000n,
  5000n,
  600_000_000_000_000_000n,
  1_025_000_000_000_000_000n,
  450_000_000_000_000_000n,
  600_000_000_000_000_000n,
  2_000_000_000_000_000_000n,
  600_000_000_000_000_000n,
  500_000_000_000_000_000n,
  1_500_000_000_000_000_000n,
  500_000_000_000_000_000n,
  16_000n,
] as const

const ZERO = '0x0000000000000000000000000000000000000000' as const
const KNOWN_MARKET = demo.marketId_fee500_7d
const UNKNOWN_MARKET = ('0x' + 'ff'.repeat(32)) as Hex

/** A live-shaped markets() tuple for the demo market (oracleToken = dWETH, 7d). */
const DEMO_MARKET_TUPLE = [
  tokens.demoWeth,
  tokens.demoUsdc,
  500,
  604800,
  tokens.demoWeth,
  18,
  6,
  8,
  true,
] as const

/** The zero markets() tuple an unregistered marketId returns. */
const ZERO_MARKET_TUPLE = [ZERO, ZERO, 0, 0, ZERO, 0, 0, 0, false] as const

/** A mock fairPremium result (premium, fairRateWad, sigmaRefWad). */
const FAIR_PREMIUM_RESULT = [
  12_345_000n,
  17_500_000_000_000_000n,
  700_000_000_000_000_000n,
] as const

/**
 * Build a mock PublicClient that drives `getCurrentLoadSurface`. `behaviour`
 * controls each leg so we can exercise every degraded branch deterministically.
 */
function mockClient(behaviour: {
  poolReadsThrow?: boolean
  marketTuples?: ReadonlyArray<{ status: 'success' | 'failure'; result?: unknown }>
  fairPremiumResults?: ReadonlyArray<{ status: 'success' | 'failure'; result?: unknown }>
}): PublicClient {
  let multicallCall = 0
  const c = {
    async readContract(args: { functionName: string }): Promise<unknown> {
      if (behaviour.poolReadsThrow) throw new Error('RPC unreachable')
      if (args.functionName === 'loadParams') return LOAD_PARAMS_TUPLE
      if (args.functionName === 'inventory') {
        // total, locked, free, util, conc
        return [0n, 0n, 0n, 600_000_000_000_000_000n, 250_000_000_000_000_000n]
      }
      throw new Error(`unexpected readContract: ${args.functionName}`)
    },
    async multicall(): Promise<unknown> {
      // First multicall = markets(); second = fairPremium().
      const which = multicallCall++
      if (which === 0) return behaviour.marketTuples ?? []
      return behaviour.fairPremiumResults ?? []
    },
    async getBlockNumber(): Promise<bigint> {
      return 123n
    },
  }
  return c as unknown as PublicClient
}

describe('DataClient — API-backed history surfaces (offline, graceful degradation)', () => {
  const dc = makeDataClient(makePublicClient())

  it('getLoadSurfaceHistory returns a typed ApiPending naming /data/load-surface', async () => {
    const r = await dc.getLoadSurfaceHistory({
      marketId: KNOWN_MARKET,
      from: 1,
      to: 2,
      bucket: '1h',
    })
    expect(r.available).toBe(false)
    expect(r.reason).toBe('no-history-source')
    expect(r.endpoint).toBe(DATA_API_ROUTES.loadSurface)
    expect(r.query).toMatchObject({ marketId: KNOWN_MARKET, from: '1', to: '2', bucket: '1h' })
    expect(typeof r.detail).toBe('string')
  })

  it('getLoadSurfaceHistory defaults the bucket to 1d', async () => {
    const r = await dc.getLoadSurfaceHistory({ marketId: KNOWN_MARKET })
    expect(r.query['bucket']).toBe('1d')
  })

  it('getQuoteCompetition forwards to /data/quote-competition', async () => {
    const r = await dc.getQuoteCompetition({ marketId: KNOWN_MARKET })
    expect(r.endpoint).toBe(DATA_API_ROUTES.quoteCompetition)
    expect(r.available).toBe(false)
    expect(r.query['marketId']).toBe(KNOWN_MARKET)
  })

  it('getDemandRequests forwards to /data/demand-requests (off-chain telemetry)', async () => {
    const r = await dc.getDemandRequests({})
    expect(r.endpoint).toBe(DATA_API_ROUTES.demandRequests)
    expect(r.available).toBe(false)
    expect(r.query).toEqual({})
  })

  it('getNavHistory carries the claim-(B) disclosure and forwards to /pool/nav-history', async () => {
    const r = await dc.getNavHistory({ from: 100 })
    expect(r.endpoint).toBe(DATA_API_ROUTES.navHistory)
    expect(r.available).toBe(false)
    expect(r.query['from']).toBe('100')
    expect(r.query['bucket']).toBe('1d')
    // Claim (B) must be present and NOT merged with claim (A).
    expect(r.detail).toContain('NOT guaranteed')
    expect(r.detail).not.toContain('no bad debt')
  })

  it('getNetGamma forwards to /data/net-gamma', async () => {
    const r = await dc.getNetGamma()
    expect(r.endpoint).toBe(DATA_API_ROUTES.netGamma)
    expect(r.available).toBe(false)
  })

  it('every API route string is a stable, documented endpoint', () => {
    expect(DATA_API_ROUTES.loadSurface).toBe('/data/load-surface')
    expect(DATA_API_ROUTES.quoteCompetition).toBe('/data/quote-competition')
    expect(DATA_API_ROUTES.demandRequests).toBe('/data/demand-requests')
    expect(DATA_API_ROUTES.navHistory).toBe('/pool/nav-history')
    expect(DATA_API_ROUTES.netGamma).toBe('/data/net-gamma')
  })
})

describe('DataClient.getCurrentLoadSurface — live surface graceful degradation (mocked)', () => {
  it('returns an empty surface for an empty market set (no RPC touched)', async () => {
    const dc = new DataClient(mockClient({}))
    const s = await dc.getCurrentLoadSurface({ markets: [] })
    expect(s.rows).toEqual([])
    expect(s.note).toContain('LIVE uncached')
  })

  it('degrades EVERY row when the pool-wide reads fail', async () => {
    const dc = new DataClient(mockClient({ poolReadsThrow: true }))
    const s = await dc.getCurrentLoadSurface({
      markets: [{ marketId: KNOWN_MARKET }, { marketId: UNKNOWN_MARKET }],
    })
    expect(s.rows).toHaveLength(2)
    for (const row of s.rows) {
      expect(row.available).toBe(false)
      if (!row.available) expect(row.reason).toBe('oracle-degraded')
    }
  })

  it('flags an unregistered market as market-unknown (zero config tuple)', async () => {
    const dc = new DataClient(
      mockClient({
        marketTuples: [{ status: 'success', result: ZERO_MARKET_TUPLE }],
        fairPremiumResults: [],
      }),
    )
    const s = await dc.getCurrentLoadSurface({ markets: [{ marketId: UNKNOWN_MARKET }] })
    expect(s.rows).toHaveLength(1)
    const row = s.rows[0]!
    expect(row.available).toBe(false)
    if (!row.available) expect(row.reason).toBe('market-unknown')
  })

  it('flags a failed markets() read as market-unknown', async () => {
    const dc = new DataClient(
      mockClient({
        marketTuples: [{ status: 'failure' }],
        fairPremiumResults: [],
      }),
    )
    const s = await dc.getCurrentLoadSurface({ markets: [{ marketId: UNKNOWN_MARKET }] })
    const row = s.rows[0]!
    expect(row.available).toBe(false)
    if (!row.available) expect(row.reason).toBe('market-unknown')
  })

  it('inlines an oracle-degraded row when fairPremium reverts, keeping good rows', async () => {
    const dc = new DataClient(
      mockClient({
        marketTuples: [
          { status: 'success', result: DEMO_MARKET_TUPLE },
          { status: 'success', result: DEMO_MARKET_TUPLE },
        ],
        fairPremiumResults: [
          { status: 'success', result: FAIR_PREMIUM_RESULT },
          { status: 'failure' },
        ],
      }),
    )
    const s = await dc.getCurrentLoadSurface({
      markets: [{ marketId: KNOWN_MARKET }, { marketId: UNKNOWN_MARKET }],
    })
    expect(s.rows).toHaveLength(2)

    const good = s.rows[0]!
    expect(good.available).toBe(true)
    if (good.available) {
      expect(good.marketId).toBe(KNOWN_MARKET)
      expect(good.fairPremium).toBe(FAIR_PREMIUM_RESULT[0])
      expect(good.sigmaRefWad).toBe(FAIR_PREMIUM_RESULT[2])
      // load total never exceeds maxLoad (I10) and poolPremium ≥ fairPremium (load ≥ 0).
      const maxLoad = 16_000n * 100_000_000_000_000n
      expect(good.load.totalLoadWad).toBeLessThanOrEqual(maxLoad)
      expect(good.poolPremium).toBeGreaterThanOrEqual(good.fairPremium)
      // components present (the DEP-6 "two skews separately" requirement).
      expect(good.load.baseLoadWad).toBeGreaterThanOrEqual(0n)
      expect(typeof good.regime).toBe('string')
    }

    const bad = s.rows[1]!
    expect(bad.available).toBe(false)
    if (!bad.available) expect(bad.reason).toBe('oracle-degraded')

    expect(s.blockNumber).toBe(123n)
  })

  it('caps poolPremium at maxIL when the loaded premium would exceed the cap', async () => {
    // fairPremium == maxIL → any positive load would push poolPremium over the cap.
    const cap = 9_999n
    const dc = new DataClient(
      mockClient({
        marketTuples: [{ status: 'success', result: DEMO_MARKET_TUPLE }],
        fairPremiumResults: [
          { status: 'success', result: [cap, 5n * WAD, 700_000_000_000_000_000n] },
        ],
      }),
    )
    const s = await dc.getCurrentLoadSurface({
      markets: [
        {
          marketId: KNOWN_MARKET,
          geometry: { aWad: 9n * 10n ** 17n, bWad: 11n * 10n ** 17n, maxIL: BigInt(cap) },
        },
      ],
    })
    const row = s.rows[0]!
    expect(row.available).toBe(true)
    if (row.available) {
      expect(row.poolPremium).toBe(BigInt(cap))
      expect(row.maxIL).toBe(BigInt(cap))
    }
  })
})

describe('DataClient.getSurfaceSigmaRef (mocked)', () => {
  it('returns sigmaRef + regime when the VolOracle is initialised', async () => {
    const c = {
      async readContract(args: { functionName: string }): Promise<unknown> {
        if (args.functionName === 'sigmaRef') return 700_000_000_000_000_000n
        if (args.functionName === 'loadParams') return LOAD_PARAMS_TUPLE
        throw new Error('unexpected')
      },
    } as unknown as PublicClient
    const dc = new DataClient(c)
    const r = await dc.getSurfaceSigmaRef(tokens.demoWeth)
    expect(r.available).toBe(true)
    if (r.available) {
      expect(r.sigmaRefWad).toBe(700_000_000_000_000_000n)
      expect(r.regime).toBe('normal')
    }
  })

  it('degrades (never throws) when the VolOracle reverts (uninitialised token)', async () => {
    const c = {
      async readContract(): Promise<unknown> {
        throw new Error('sigmaRef: not initialised')
      },
    } as unknown as PublicClient
    const dc = new DataClient(c)
    const r = await dc.getSurfaceSigmaRef(tokens.demoWeth)
    expect(r.available).toBe(false)
    if (!r.available) expect(r.reason).toContain('not initialised')
  })
})

describe('DataClient.getCurrentLoadSurface — live on-chain (gated on RPC)', () => {
  const rpc = resolveRpcUrl()
  const maybe = rpc === undefined ? it.skip : it

  maybe('reads the demo market load surface and the row is well-formed', async () => {
    const dc = makeDataClient(makePublicClient())
    const s = await dc.getCurrentLoadSurface({ markets: [{ marketId: demo.marketId_fee500_7d }] })
    expect(s.rows).toHaveLength(1)
    const row = s.rows[0]!
    // If the oracle is live, the row prices; if degraded, it must be typed (never throw).
    if (row.available) {
      expect(row.fairPremium).toBeGreaterThan(0n)
      const maxLoad = 16_000n * 100_000_000_000_000n
      expect(row.load.totalLoadWad).toBeLessThanOrEqual(maxLoad)
      expect(row.poolPremium).toBeGreaterThanOrEqual(
        row.fairPremium > row.maxIL ? row.maxIL : row.fairPremium,
      )
    } else {
      expect(['oracle-degraded', 'market-unknown']).toContain(row.reason)
    }
  })
})
