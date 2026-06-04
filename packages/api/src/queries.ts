/**
 * The GraphQL query SHAPES the API runs against @inflexion/subgraph, one per moat
 * signal (+ the directory / pool / MM / swap surfaces). These are wired-and-ready:
 * the subgraph is not deployed yet, so today the handlers return a typed `pending`
 * body that EMBEDS the exact query it will run at the redeploy. Keeping them here
 * (not inline) makes them testable and self-documenting.
 *
 * Mapping to docs/ACCESS_LAYER_ARCHITECTURE.md §5 signals:
 *   Signal 1 (realized clearing load) ........ Q_BUCKET_AGGREGATES (load over σ_ref)
 *   Signal 2 (pool-vs-MM spread + win-rate) .. Q_BUCKET_AGGREGATES + Q_MARKET_MAKERS
 *                                              + the OFF-CHAIN competition telemetry
 *   Signal 3 (term structure slope) .......... Q_TERM_STRUCTURE (7/30/90d per range)
 *   Signal 4 (moneyness / demand skew) ....... Q_GEOMETRY_DEMAND (realized) + OFF-CHAIN
 *                                              demand telemetry (latent)
 *   Signal 5 (net gamma supply) .............. Q_ACTIVE_SWAPS + Q_NET_GAMMA snapshots
 */

// ─── Signal 1 & 2 — realized clearing LOAD + pool-vs-MM spread (bucketed) ──────
// EXCLUDES cap-bound fills by construction (BucketAggregate accumulates non-capped
// fills only). The API derives means from the running sums + counts (the subgraph
// store has no median operator; medians are computed by the API over Swap rows when
// a true median is required — see Q_BUCKET_FILLS).
export const Q_BUCKET_AGGREGATES = /* GraphQL */ `
  query BucketAggregates($first: Int = 1000) {
    bucketAggregates(first: $first, orderBy: lastFillTimestamp, orderDirection: desc) {
      id
      widthBucket
      distanceBucket
      durationBucket
      countPoolFills
      countMMFills
      countMMWins
      totalNonCappedFills
      sumMMLoadBps
      sumPoolLoadWad
      sumSpreadWad
      sumSigmaRefWad
      sigmaRefFloor
      v0Volume
      lastFillTimestamp
    }
  }
`

// Per-fill rows for an exact median / distribution (Signal 1/2 fine-grain). Joins
// SwapPriced (pool baseline) + QuoteFilled (MM load) on the Swap entity; the
// cappedAtMaxIL filter removes load-bearing-cap fills.
export const Q_BUCKET_FILLS = /* GraphQL */ `
  query BucketFills($width: String!, $distance: String!, $duration: String!, $first: Int = 1000) {
    swaps(
      first: $first
      where: {
        widthBucket: $width
        distanceBucket: $distance
        durationBucket: $duration
        priced: true
        cappedAtMaxIL: false
      }
      orderBy: createdAtTimestamp
      orderDirection: desc
    ) {
      id
      path
      poolLoadWad
      mmLoadBps
      spreadWad
      sigmaRefWad
      fairPremium
      v0
      createdAtTimestamp
    }
  }
`

// ─── Signal 3 — TERM STRUCTURE of convexity (slope across durations per range) ─
// The 7/30/90d rows of one (width, distance) pair. The slope of medianMMLoadBps
// across durationBucket IS the signal (Path B behavioral; Path A is duration-flat).
export const Q_TERM_STRUCTURE = /* GraphQL */ `
  query TermStructure($width: String!, $distance: String!, $first: Int = 100) {
    bucketAggregates(
      first: $first
      where: { widthBucket: $width, distanceBucket: $distance }
      orderBy: durationBucket
      orderDirection: asc
    ) {
      durationBucket
      countMMFills
      countMMWins
      totalNonCappedFills
      sumMMLoadBps
      sumPoolLoadWad
      sumSpreadWad
      sumSigmaRefWad
    }
  }
`

// ─── Signal 4 — MONEYNESS / DEMAND SKEW (realized half) ───────────────────────
// The latent half (unfilled / previewed-but-not-bought) is OFF-CHAIN telemetry,
// served by /data/demand-requests from the engine DEMAND_LOG — NOT this query.
export const Q_GEOMETRY_DEMAND = /* GraphQL */ `
  query GeometryDemand($first: Int = 1000) {
    geometryDemandBuckets(first: $first, orderBy: realizedFillCount, orderDirection: desc) {
      id
      widthBucket
      distanceBucket
      durationBucket
      realizedFillCount
      realizedV0
      firstSeen
      lastSeen
    }
  }
`

// ─── Signal 5 — NET CONVEXITY / GAMMA SUPPLY ──────────────────────────────────
// The active-swap set the API sums off-chain Greeks over (finite-difference the
// deployed ILMath / FairValueOracle). NetGammaSnapshot holds the written-back sums.
export const Q_ACTIVE_SWAPS = /* GraphQL */ `
  query ActiveSwaps($first: Int = 1000, $skip: Int = 0) {
    swaps(
      first: $first
      skip: $skip
      where: { isActive: true }
      orderBy: createdAtTimestamp
      orderDirection: asc
    ) {
      id
      market {
        id
        oracleToken
        durationSeconds
      }
      tokenId
      v0
      maxIL
      tickLower
      tickUpper
      liquidity
      sigmaRefWad
      poolLoadWad
      mmLoadBps
      path
    }
  }
`

export const Q_NET_GAMMA = /* GraphQL */ `
  query NetGamma($first: Int = 90) {
    netGammaSnapshots(first: $first, orderBy: bucketStart, orderDirection: desc) {
      id
      bucketStart
      activeSwapCount
      totalV0
      totalMaxIL
      aggGammaWad
      aggVegaWad
      volumeWeightedLoadWad
    }
    protocolState(id: "global") {
      activeSwapCount
      totalActiveV0
      totalActiveMaxIL
    }
  }
`

// ─── Directory + market state (PUB-2, PUB-1, MM-11) ───────────────────────────
export const Q_MARKETS = /* GraphQL */ `
  query Markets($first: Int = 100) {
    markets(first: $first, orderBy: createdAtTimestamp, orderDirection: asc) {
      id
      token0
      token1
      fee
      durationSeconds
      durationBucket
      oracleToken
      active
      cvammEnabled
      totalSwaps
      totalSettled
      totalV0
      totalPremium
      totalPayout
      pathBFills
    }
  }
`

export const Q_MARKET_BY_ID = /* GraphQL */ `
  query MarketById($id: ID!) {
    market(id: $id) {
      id
      token0
      token1
      fee
      durationSeconds
      oracleToken
      active
      cvammEnabled
      totalSwaps
      totalSettled
      totalV0
      totalPremium
      totalPayout
      pathBFills
    }
  }
`

export const Q_MARKET_STATE = /* GraphQL */ `
  query MarketState($market: String!, $first: Int = 365) {
    marketStateSnapshots(
      first: $first
      where: { market: $market }
      orderBy: dayStart
      orderDirection: desc
    ) {
      dayStart
      lockedByMarket
      utilWad
      concWad
      sigmaRefWad
      baseLoadWad
      utilSkewWad
      dispSkewWad
      totalLoadWad
      fillCount
      v0Volume
      pathBFills
    }
  }
`

// ─── Pool NAV / util / premium time series (DEP-8/DEP-9, claim B) ─────────────
export const Q_POOL_DAY_SNAPSHOTS = /* GraphQL */ `
  query PoolDaySnapshots($first: Int = 365) {
    poolDaySnapshots(first: $first, orderBy: dayStart, orderDirection: desc) {
      id
      dayStart
      seniorAssets
      juniorAssets
      totalLocked
      utilWad
      concWad
      premiumAccrued
      payouts
      juniorLoss
      seniorLoss
    }
  }
`

export const Q_POOL_HOUR_SNAPSHOTS = /* GraphQL */ `
  query PoolHourSnapshots($first: Int = 720) {
    poolHourSnapshots(first: $first, orderBy: hourStart, orderDirection: desc) {
      id
      hourStart
      seniorAssets
      juniorAssets
      totalLocked
      utilWad
      concWad
      premiumAccrued
      payouts
      juniorLoss
      seniorLoss
    }
  }
`

// ─── MM fills / PnL (MM-10) ───────────────────────────────────────────────────
export const Q_MARKET_MAKER = /* GraphQL */ `
  query MarketMaker($id: ID!, $first: Int = 1000) {
    marketMaker(id: $id) {
      id
      fills
      exposureV0
      exposureMaxIL
      cumulativePremium
      cumulativePayout
      pnl
      cumulativeWinCount
      cumulativeQuoteFillCount
    }
    swaps(first: $first, where: { mm: $id }, orderBy: createdAtTimestamp, orderDirection: desc) {
      id
      status
      path
      v0
      maxIL
      premium
      payout
      pnlForMm
      mmLoadBps
      createdAtTimestamp
      settledAtTimestamp
    }
  }
`

export const Q_MARKET_MAKERS = /* GraphQL */ `
  query MarketMakers($first: Int = 100) {
    marketMakers(first: $first, orderBy: pnl, orderDirection: desc) {
      id
      fills
      cumulativePremium
      cumulativePayout
      pnl
      cumulativeWinCount
      cumulativeQuoteFillCount
    }
  }
`

// ─── Recent swaps list (directory; optional status / mm / market filters) ─────
// The `where` is interpolated by the handler from validated, optional filters so a
// single query shape serves /swaps, /swaps?status=active, /swaps?mm=…, /swaps?market=….
export const Q_SWAPS = /* GraphQL */ `
  query Swaps($first: Int = 100, $where: Swap_filter) {
    swaps(first: $first, where: $where, orderBy: createdAtTimestamp, orderDirection: desc) {
      id
      market {
        id
      }
      status
      isActive
      lp
      mm
      tokenId
      v0
      maxIL
      premium
      path
      mmLoadBps
      cappedAtMaxIL
      realisedIL
      payout
      pnlForMm
      createdAtTimestamp
      expiryTimestamp
      durationSeconds
    }
  }
`

// ─── Single swap (live IL via cached settlePreview overlaid by the handler) ───
export const Q_SWAP_BY_ID = /* GraphQL */ `
  query SwapById($id: ID!) {
    swap(id: $id) {
      id
      market {
        id
      }
      status
      isActive
      lp
      mm
      tokenId
      v0
      maxIL
      premium
      path
      mmLoadBps
      poolLoadWad
      spreadWad
      cappedAtMaxIL
      fairPremium
      sigmaRefWad
      realisedIL
      payout
      settlementPrice
      createdAtTimestamp
      expiryTimestamp
      durationSeconds
      pnlForMm
    }
  }
`

// ─── σ_ref history (PUB-2; includes the SwapPriced backfill points) ───────────
export const Q_SIGMA_HISTORY = /* GraphQL */ `
  query SigmaHistory($token: Bytes!, $first: Int = 1000) {
    sigmaPoints(first: $first, where: { token: $token }, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      blockNumber
      priceWad
      dtSeconds
      sigmaShortWad
      sigmaLongWad
      sigmaRefWad
      source
    }
  }
`

/** All query strings, keyed by their logical name (handy for diagnostics / tests). */
export const QUERIES = {
  bucketAggregates: Q_BUCKET_AGGREGATES,
  bucketFills: Q_BUCKET_FILLS,
  termStructure: Q_TERM_STRUCTURE,
  geometryDemand: Q_GEOMETRY_DEMAND,
  activeSwaps: Q_ACTIVE_SWAPS,
  netGamma: Q_NET_GAMMA,
  markets: Q_MARKETS,
  marketById: Q_MARKET_BY_ID,
  marketState: Q_MARKET_STATE,
  poolDaySnapshots: Q_POOL_DAY_SNAPSHOTS,
  poolHourSnapshots: Q_POOL_HOUR_SNAPSHOTS,
  marketMaker: Q_MARKET_MAKER,
  marketMakers: Q_MARKET_MAKERS,
  swaps: Q_SWAPS,
  swapById: Q_SWAP_BY_ID,
  sigmaHistory: Q_SIGMA_HISTORY,
} as const

export type QueryName = keyof typeof QUERIES
