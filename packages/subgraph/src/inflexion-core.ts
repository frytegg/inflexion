/**
 * InflexionCore mappings — the heart of the indexer. Builds the Swap lifecycle
 * (SwapCreated → SwapPriced → QuoteFilled → SwapSettled), decodes range geometry
 * via NPM.positions, and maintains the moat aggregates (Signals 1–5 structural
 * halves) + the market directory + per-MM stats + the σ_ref backfill.
 *
 * NON-CIRCULAR rule baked in: the MM `loadBps` (QuoteFilled, Path B) is the
 * behavioral load datum; the pool `totalLoadWad` (SwapPriced) is the mechanical
 * baseline. Cap-bound fills (`cappedAtMaxIL`) are EXCLUDED from the load
 * aggregates — they carry zero load information.
 */
import { BigInt, Bytes, Address, log } from '@graphprotocol/graph-ts'
import {
  MarketRegistered,
  MarketDeactivated,
  TreasurySet,
  CvammConfigured,
  CvammFrozen,
  CvammEnabledSet,
  LoadParamsSet,
  SwapCreated,
  SwapPriced,
  QuoteFilled,
  SwapRouted,
  SwapSettled,
  NoncesCancelled,
  InflexionCore,
} from '../generated/InflexionCore/InflexionCore'
import { NonfungiblePositionManager } from '../generated/InflexionCore/NonfungiblePositionManager'
import { Market, Swap, SigmaPoint, Nonce } from '../generated/schema'
import {
  getProtocolState,
  getMarketMaker,
  getBucketAggregate,
  getGeometryDemandBucket,
} from './entities'
import {
  ZERO_BI,
  ONE_BI,
  WAD,
  UNKNOWN,
  PATH_UNKNOWN,
  PATH_POOL_A,
  PATH_MM_B,
  durationBucket,
  widthBucketFromTicks,
  distanceBucketFromTicks,
  eventUid,
  nonceId,
} from './helpers'

// The NPM the protocol is wired to (the position custody NFT). Read from the
// generated registry by the manifest; we bind it lazily here because the
// geometry decode is an enrichment eth_call, not an event.
const NPM_ADDRESS = Address.fromString('0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65')

// ─── Market directory ────────────────────────────────────────────────────────

export function handleMarketRegistered(event: MarketRegistered): void {
  const id = event.params.marketId.toHexString()
  let m = Market.load(id)
  if (m == null) {
    m = new Market(id)
    m.totalSwaps = 0
    m.totalSettled = 0
    m.totalV0 = ZERO_BI
    m.totalPremium = ZERO_BI
    m.totalPayout = ZERO_BI
    m.pathBFills = 0
  }
  m.token0 = event.params.token0
  m.token1 = event.params.token1
  m.fee = event.params.fee
  const durSecs = event.params.durationSeconds.toI32()
  m.durationSeconds = durSecs
  m.durationBucket = durationBucket(durSecs)
  m.oracleToken = event.params.oracleToken
  m.active = true
  m.createdAtBlock = event.block.number
  m.createdAtTimestamp = event.block.timestamp
  m.save()
}

export function handleMarketDeactivated(event: MarketDeactivated): void {
  const m = Market.load(event.params.marketId.toHexString())
  if (m == null) return
  m.active = false
  m.save()
}

export function handleCvammEnabledSet(event: CvammEnabledSet): void {
  const m = Market.load(event.params.marketId.toHexString())
  if (m == null) return
  m.cvammEnabled = event.params.enabled
  m.save()
}

// Config events are indexed for completeness/auditability; they touch no entity
// state beyond what their dedicated handlers above already capture.
export function handleTreasurySet(event: TreasurySet): void {}
export function handleCvammConfigured(event: CvammConfigured): void {}
export function handleCvammFrozen(event: CvammFrozen): void {}
export function handleLoadParamsSet(event: LoadParamsSet): void {}

// ─── Swap lifecycle ──────────────────────────────────────────────────────────

export function handleSwapCreated(event: SwapCreated): void {
  const id = event.params.swapId.toString()
  let s = Swap.load(id)
  if (s == null) s = new Swap(id)

  s.status = 'ACTIVE'
  s.isActive = true
  s.lp = event.params.lp
  s.mm = event.params.mm
  s.tokenId = event.params.tokenId
  s.v0 = event.params.V0
  s.maxIL = event.params.maxIL
  s.premium = event.params.premium
  s.createdAtBlock = event.block.number
  s.createdAtTimestamp = event.block.timestamp

  // Lifecycle flags default false until their event lands.
  s.priced = false
  s.routed = false
  s.cappedAtMaxIL = false
  s.geometryDecoded = false
  s.path = PATH_UNKNOWN

  // ── Geometry decode (NPM.positions at the SwapCreated block) ──
  // No geometry is stored in any event; every geometry-bucketed signal (1, 3, 4)
  // needs it. Bind + try_positions so a revert (e.g. token burned) degrades to
  // 'unknown' buckets instead of failing the whole handler.
  let width = UNKNOWN
  let distance = UNKNOWN
  const npm = NonfungiblePositionManager.bind(NPM_ADDRESS)
  const res = npm.try_positions(event.params.tokenId)
  if (!res.reverted) {
    const p = res.value
    s.tickLower = p.getTickLower()
    s.tickUpper = p.getTickUpper()
    s.liquidity = p.getLiquidity()
    width = widthBucketFromTicks(p.getTickLower(), p.getTickUpper())
    distance = distanceBucketFromTicks(p.getTickLower(), p.getTickUpper())
    s.geometryDecoded = true
  }
  s.widthBucket = width
  s.distanceBucket = distance

  // ── Market recovery + duration bucket ──
  // SwapRecord carries NO marketId. The market is recoverable off the tokenId's
  // token0/token1/fee + duration, but the duration is only knowable once we also
  // know expiry. The robust on-chain link is: read the swap record for expiry.
  const core = InflexionCore.bind(event.address)
  const recCall = core.try_swaps(event.params.swapId)
  let dur = 0
  if (!recCall.reverted) {
    // Recover createdAt/expiry positionally; durationSeconds = expiry − createdAt.
    // The tuple order is the SwapRecord struct; we only need the two timestamps.
    // try_swaps returns the full record — use its getters for the two we need.
    const rec = recCall.value
    s.expiryTimestamp = rec.getExpiry()
    const createdAt = rec.getCreatedAt()
    if (rec.getExpiry().gt(createdAt)) {
      dur = rec.getExpiry().minus(createdAt).toI32()
      s.durationSeconds = dur
    }
  }
  s.durationBucket = durationBucket(dur)

  // ── Market join (best-effort: derive marketId via resolveMarket geometry) ──
  // We cannot recompute keccak(token0,token1,fee,duration) cheaply in AS without
  // the position's tokens; the Market link is set when a SwapPriced/SwapRouted or
  // the market's own events let us join. Leave null here; the API joins by tokenId
  // geometry where needed. (Most directory reads use Market's own counters.)

  s.save()

  // ── Realized demand bucket (Signal 4 structural half) ──
  const g = getGeometryDemandBucket(width, distance, s.durationBucket, event.block.timestamp)
  g.realizedFillCount = g.realizedFillCount + 1
  g.realizedV0 = g.realizedV0.plus(event.params.V0)
  g.lastSeen = event.block.timestamp
  g.save()

  // ── Per-MM exposure (the counterparty; ConvexityVault for Path A) ──
  const mm = getMarketMaker(event.params.mm.toHexString(), event.block.timestamp)
  mm.fills = mm.fills + 1
  mm.exposureV0 = mm.exposureV0.plus(event.params.V0)
  mm.exposureMaxIL = mm.exposureMaxIL.plus(event.params.maxIL)
  mm.cumulativePremium = mm.cumulativePremium.plus(event.params.premium)
  mm.pnl = mm.cumulativePremium.minus(mm.cumulativePayout)
  mm.lastSeen = event.block.timestamp
  mm.save()

  // ── Protocol active-swap set (Signal 5 current snapshot) ──
  const ps = getProtocolState()
  ps.activeSwapCount = ps.activeSwapCount + 1
  ps.totalActiveV0 = ps.totalActiveV0.plus(event.params.V0)
  ps.totalActiveMaxIL = ps.totalActiveMaxIL.plus(event.params.maxIL)
  ps.cumulativeSwaps = ps.cumulativeSwaps + 1
  ps.save()
}

export function handleSwapPriced(event: SwapPriced): void {
  const id = event.params.swapId.toString()
  let s = Swap.load(id)
  if (s == null) {
    // SwapPriced can be ordered before SwapCreated only across blocks; within a tx
    // SwapCreated fires first. Defensive create so we never drop the pricing data.
    s = new Swap(id)
    s.status = 'ACTIVE'
    s.isActive = true
    s.lp = Address.zero()
    s.mm = Address.zero()
    s.tokenId = ZERO_BI
    s.v0 = ZERO_BI
    s.maxIL = ZERO_BI
    s.premium = ZERO_BI
    s.createdAtBlock = event.block.number
    s.createdAtTimestamp = event.block.timestamp
    s.routed = false
    s.geometryDecoded = false
    s.widthBucket = UNKNOWN
    s.distanceBucket = UNKNOWN
    s.durationBucket = UNKNOWN
  }

  s.priced = true
  s.path = event.params.path == 1 ? PATH_MM_B : PATH_POOL_A
  s.fairPremium = event.params.fairPremium
  s.baseLoadWad = event.params.baseLoadWad
  s.utilSkewWad = event.params.utilSkewWad
  s.dispSkewWad = event.params.dispSkewWad
  s.poolLoadWad = event.params.totalLoadWad
  s.sigmaRefWad = event.params.sigmaRefWad
  s.cappedAtMaxIL = event.params.cappedAtMaxIL
  s.save()

  // ── σ_ref backfill (SigmaPoint series; fills gaps between pokes) ──
  // `poke` is a no-op (no Poked) when dt < minSampleInterval, so the priced σ_ref
  // is the only σ_ref signal on quiet feeds. Anchor it to the market's oracleToken
  // where resolvable; key the point uniquely by event so it never collides.
  if (event.params.sigmaRefWad.gt(ZERO_BI)) {
    const sp = new SigmaPoint(eventUid(event))
    // We don't have the oracleToken in this event; tag with zero address and let
    // the API associate via the swap's market. The series value is what matters.
    sp.token = Address.zero()
    sp.timestamp = event.block.timestamp
    sp.blockNumber = event.block.number
    sp.sigmaRefWad = event.params.sigmaRefWad
    sp.source = 'SWAP_PRICED_BACKFILL'
    sp.save()
  }

  // ── BucketAggregate: count the pool fill + accumulate the mechanical baseline.
  //    EXCLUDE cap-bound fills (zero load info). The MM-load half is added in
  //    handleQuoteFilled (Path B). Path-A pool fills are counted here.
  if (!event.params.cappedAtMaxIL) {
    const b = getBucketAggregate(s.widthBucket, s.distanceBucket, s.durationBucket)
    b.totalNonCappedFills = b.totalNonCappedFills + 1
    b.sumPoolLoadWad = b.sumPoolLoadWad.plus(event.params.totalLoadWad)
    b.sumSigmaRefWad = b.sumSigmaRefWad.plus(event.params.sigmaRefWad)
    if (b.sigmaRefFloor === null || event.params.sigmaRefWad.lt(b.sigmaRefFloor as BigInt)) {
      b.sigmaRefFloor = event.params.sigmaRefWad
    }
    b.v0Volume = b.v0Volume.plus(s.v0)
    if (event.params.path == 1) {
      b.countMMFills = b.countMMFills + 1
      b.countMMWins = b.countMMWins + 1
    } else {
      b.countPoolFills = b.countPoolFills + 1
    }
    b.lastFillTimestamp = event.block.timestamp
    b.lastFillSwap = id
    b.save()
  }

  // ── Per-MM win count (Path B) ──
  if (event.params.path == 1 && s.mm.notEqual(Address.zero())) {
    const mm = getMarketMaker(s.mm.toHexString(), event.block.timestamp)
    mm.cumulativeWinCount = mm.cumulativeWinCount + 1
    mm.save()
  }
}

export function handleQuoteFilled(event: QuoteFilled): void {
  const id = event.params.swapId.toString()
  const s = Swap.load(id)
  if (s != null) {
    s.quoteId = event.params.quoteId
    s.nonce = event.params.nonce
    s.mmLoadBps = event.params.loadBps
    // Spread (Signal 2): pool mechanical load − MM behavioral load, in WAD.
    // mmLoadBps → WAD: loadBps/10000 * 1e18 = loadBps * 1e14.
    const mmLoadWad = BigInt.fromI32(event.params.loadBps).times(
      BigInt.fromString('100000000000000'),
    )
    if (s.poolLoadWad !== null) {
      s.spreadWad = (s.poolLoadWad as BigInt).minus(mmLoadWad)
    }
    s.save()

    // ── BucketAggregate: add the NON-CIRCULAR MM load (skip cap-bound fills). ──
    if (!s.cappedAtMaxIL) {
      const b = getBucketAggregate(s.widthBucket, s.distanceBucket, s.durationBucket)
      b.sumMMLoadBps = b.sumMMLoadBps.plus(BigInt.fromI32(event.params.loadBps))
      if (s.spreadWad !== null) {
        b.sumSpreadWad = b.sumSpreadWad.plus(s.spreadWad as BigInt)
      }
      b.save()
    }
  }

  // ── Nonce: precise fill attribution (MM-8). ──
  const nId = nonceId(event.params.mm, event.params.nonce)
  let n = Nonce.load(nId)
  if (n == null) {
    n = new Nonce(nId)
    n.mm = event.params.mm
    n.nonce = event.params.nonce
    n.filled = false
    n.cancelled = false
  }
  n.filled = true
  n.swap = id
  n.updatedAt = event.block.timestamp
  n.save()

  // ── Per-MM quote-fill count (Signal 2 per-MM). ──
  const mm = getMarketMaker(event.params.mm.toHexString(), event.block.timestamp)
  mm.cumulativeQuoteFillCount = mm.cumulativeQuoteFillCount + 1
  mm.save()
}

export function handleSwapRouted(event: SwapRouted): void {
  const id = event.params.swapId.toString()
  const s = Swap.load(id)
  if (s == null) return
  s.routed = true
  s.routedPathB = event.params.pathB
  s.premiumA = event.params.premiumA
  s.premiumB = event.params.premiumB
  // Win-depth on a routed Path-B win: how much the MM beat the pool by.
  if (event.params.pathB) {
    s.winDepth = event.params.premiumA.minus(event.params.premiumB)
  }
  s.save()
}

export function handleSwapSettled(event: SwapSettled): void {
  const id = event.params.swapId.toString()
  const s = Swap.load(id)
  if (s == null) return

  s.status = 'SETTLED'
  s.isActive = false
  s.realisedIL = event.params.realisedIL
  s.payout = event.params.payout
  s.settlementPrice = event.params.settlementPrice
  s.settledAtBlock = event.block.number
  s.settledAtTimestamp = event.block.timestamp
  s.pnlForMm = s.premium.minus(event.params.payout)
  s.save()

  // ── Per-MM realized payout + PnL ──
  if (s.mm.notEqual(Address.zero())) {
    const mm = getMarketMaker(s.mm.toHexString(), event.block.timestamp)
    mm.cumulativePayout = mm.cumulativePayout.plus(event.params.payout)
    mm.pnl = mm.cumulativePremium.minus(mm.cumulativePayout)
    mm.lastSeen = event.block.timestamp
    mm.save()
  }

  // ── Protocol active-swap set: remove from the open set (Signal 5). ──
  const ps = getProtocolState()
  if (ps.activeSwapCount > 0) ps.activeSwapCount = ps.activeSwapCount - 1
  ps.totalActiveV0 = ps.totalActiveV0.minus(s.v0)
  ps.totalActiveMaxIL = ps.totalActiveMaxIL.minus(s.maxIL)
  if (ps.totalActiveV0.lt(ZERO_BI)) ps.totalActiveV0 = ZERO_BI
  if (ps.totalActiveMaxIL.lt(ZERO_BI)) ps.totalActiveMaxIL = ZERO_BI
  ps.cumulativeSettled = ps.cumulativeSettled + 1
  ps.save()
}

export function handleNoncesCancelled(event: NoncesCancelled): void {
  const nonces = event.params.nonces
  for (let i = 0; i < nonces.length; i++) {
    const nId = nonceId(event.params.mm, nonces[i])
    let n = Nonce.load(nId)
    if (n == null) {
      n = new Nonce(nId)
      n.mm = event.params.mm
      n.nonce = nonces[i]
      n.filled = false
      n.cancelled = false
    }
    // A cancelled nonce that was not filled is honestly 'cancelled'. (isNonceUsed
    // is true on BOTH fill and cancel on-chain; the subgraph disambiguates here.)
    if (!n.filled) n.cancelled = true
    n.updatedAt = event.block.timestamp
    n.save()
  }
}
