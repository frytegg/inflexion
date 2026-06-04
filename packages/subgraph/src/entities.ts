/**
 * getOrCreate helpers for the singleton + aggregate entities. Keeps the event
 * handlers terse and guarantees every numeric field is initialised to zero (the
 * subgraph store has no defaults).
 */
import { BigInt } from '@graphprotocol/graph-ts'
import {
  BucketAggregate,
  GeometryDemandBucket,
  MarketMaker,
  ProtocolState,
  PoolState,
} from '../generated/schema'
import { ZERO_BI, bucketId } from './helpers'

export function getProtocolState(): ProtocolState {
  let s = ProtocolState.load('global')
  if (s == null) {
    s = new ProtocolState('global')
    s.activeSwapCount = 0
    s.totalActiveV0 = ZERO_BI
    s.totalActiveMaxIL = ZERO_BI
    s.cumulativeSwaps = 0
    s.cumulativeSettled = 0
    s.nextNetGammaBucket = ZERO_BI
    s.save()
  }
  return s
}

export function getPoolState(timestamp: BigInt): PoolState {
  let s = PoolState.load('global')
  if (s == null) {
    s = new PoolState('global')
    s.seniorAssets = ZERO_BI
    s.juniorAssets = ZERO_BI
    s.totalLocked = ZERO_BI
    s.concWad = ZERO_BI
    s.cumulativePremiumAccrued = ZERO_BI
    s.cumulativePayouts = ZERO_BI
    s.cumulativeJuniorLoss = ZERO_BI
    s.cumulativeSeniorLoss = ZERO_BI
    s.lastUpdated = timestamp
    s.save()
  }
  return s
}

export function getMarketMaker(id: string, timestamp: BigInt): MarketMaker {
  let mm = MarketMaker.load(id)
  if (mm == null) {
    mm = new MarketMaker(id)
    mm.fills = 0
    mm.exposureV0 = ZERO_BI
    mm.exposureMaxIL = ZERO_BI
    mm.cumulativePremium = ZERO_BI
    mm.cumulativePayout = ZERO_BI
    mm.pnl = ZERO_BI
    mm.cumulativeWinCount = 0
    mm.cumulativeQuoteFillCount = 0
    mm.firstSeen = timestamp
    mm.lastSeen = timestamp
  }
  return mm
}

export function getBucketAggregate(
  width: string,
  distance: string,
  duration: string,
): BucketAggregate {
  const id = bucketId(width, distance, duration)
  let b = BucketAggregate.load(id)
  if (b == null) {
    b = new BucketAggregate(id)
    b.widthBucket = width
    b.distanceBucket = distance
    b.durationBucket = duration
    b.countPoolFills = 0
    b.countMMFills = 0
    b.countMMWins = 0
    b.totalNonCappedFills = 0
    b.sumMMLoadBps = ZERO_BI
    b.sumPoolLoadWad = ZERO_BI
    b.sumSpreadWad = ZERO_BI
    b.sumSigmaRefWad = ZERO_BI
    b.sigmaRefFloor = null
    b.v0Volume = ZERO_BI
    b.lastFillTimestamp = ZERO_BI
  }
  return b
}

export function getGeometryDemandBucket(
  width: string,
  distance: string,
  duration: string,
  timestamp: BigInt,
): GeometryDemandBucket {
  const id = bucketId(width, distance, duration)
  let g = GeometryDemandBucket.load(id)
  if (g == null) {
    g = new GeometryDemandBucket(id)
    g.widthBucket = width
    g.distanceBucket = distance
    g.durationBucket = duration
    g.realizedFillCount = 0
    g.realizedV0 = ZERO_BI
    g.firstSeen = timestamp
    g.lastSeen = timestamp
  }
  return g
}
