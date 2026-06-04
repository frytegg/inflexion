/**
 * Shared mapping helpers — geometry bucketing, duration bucketing, entity getters,
 * and the coarse classifiers the moat aggregates key on. Pure AssemblyScript; no
 * I/O beyond store load/save.
 *
 * BUCKETS mirror the engine telemetry buckets (docs/ENGINE_TELEMETRY.md) so the
 * realized (on-chain) and latent (off-chain) halves of Signals 4 / 2 share one
 * coordinate system the API can join on.
 */
import { BigInt, Bytes, Address, ethereum } from '@graphprotocol/graph-ts'

export const ZERO_BI = BigInt.fromI32(0)
export const ONE_BI = BigInt.fromI32(1)
export const WAD = BigInt.fromString('1000000000000000000')
export const SECONDS_PER_DAY = BigInt.fromI32(86400)
export const SECONDS_PER_HOUR = BigInt.fromI32(3600)

// Tranche enum mirror (ConvexityVault.Tranche): 0 = senior, 1 = junior.
export const TRANCHE_SENIOR = 0
export const TRANCHE_JUNIOR = 1

// SwapPath enum string values (must match schema enum SwapPath).
export const PATH_UNKNOWN = 'UNKNOWN'
export const PATH_POOL_A = 'POOL_A'
export const PATH_MM_B = 'MM_B'

// Coarse geometry buckets (must match engine WidthBucket/DistanceBucket/DurationBucket).
export const UNKNOWN = 'unknown'

/**
 * Duration → coarse bucket. Thresholds match the engine's day-one telemetry so
 * realized + latent demand share one axis:
 *   hour   ≤ 1h
 *   day    ≤ 1d
 *   week   ≤ 7d
 *   month  ≤ 30d
 *   longer > 30d
 */
export function durationBucket(durationSeconds: i32): string {
  if (durationSeconds <= 0) return UNKNOWN
  if (durationSeconds <= 3600) return 'hour'
  if (durationSeconds <= 86400) return 'day'
  if (durationSeconds <= 604800) return 'week'
  if (durationSeconds <= 2592000) return 'month'
  return 'longer'
}

/**
 * Width bucket from the tick span (tickUpper − tickLower). The tick span is
 * monotone in log(Pb/Pa) (1 tick = 1bp price ratio), so coarse span thresholds
 * map directly to range width. Thresholds chosen to spread typical v3 ranges:
 *   tight  ≤   600 ticks (~±3%)
 *   medium ≤  2000 ticks (~±10%)
 *   wide   ≤ 10000 ticks (~±65%)
 *   full   >  10000 ticks (near full-range)
 */
export function widthBucketFromTicks(tickLower: i32, tickUpper: i32): string {
  const span = tickUpper - tickLower
  if (span <= 0) return UNKNOWN
  if (span <= 600) return 'tight'
  if (span <= 2000) return 'medium'
  if (span <= 10000) return 'wide'
  return 'full'
}

/**
 * Distance-to-edge bucket from the position's geometric centre tick relative to
 * its own range. Without an oracle P0 in the handler we use the position's centre
 * as the reference: a range centred far from where it was minted reads as nearer
 * an edge. This is a COARSE proxy (the precise distance needs P0); good enough for
 * the demand-skew bucketing and refined by the API when it joins the priced σ_ref.
 *
 * We approximate using the fraction of the range on the smaller side of centre —
 * but with only ticks available the centre IS the midpoint, so on-chain we report
 * 'mid' for a well-formed range and 'unknown' for a degenerate one. The precise
 * at-edge / near / deep classification is computed by the API from P0 vs (Pa,Pb).
 */
export function distanceBucketFromTicks(tickLower: i32, tickUpper: i32): string {
  if (tickUpper <= tickLower) return UNKNOWN
  // Geometry-only: report 'mid' (centre) for a valid range; the API refines with P0.
  return 'mid'
}

/** Compose the (width × distance × duration) bucket id used by the aggregates. */
export function bucketId(width: string, distance: string, duration: string): string {
  return width + '-' + distance + '-' + duration
}

/** event-unique id `${block}-${logIndex}` for immutable rows. */
export function eventUid(event: ethereum.Event): string {
  return event.block.number.toString() + '-' + event.logIndex.toString()
}

/** (mm, nonce) composite id for the Nonce entity. */
export function nonceId(mm: Bytes, nonce: BigInt): string {
  return mm.toHexString() + '-' + nonce.toString()
}

/** (address, tranche) composite id for the Depositor entity. */
export function depositorId(who: Address, tranche: i32): string {
  return who.toHexString() + '-' + tranche.toString()
}
