/**
 * Positional decoders for the tuple-returning getters (`markets`, `loadParams`,
 * `swaps`) — the public mapping/struct getters return unnamed tuples, so we map
 * them to the named SDK types here in one place.
 */
import type { Address, Hex } from 'viem'
import type { LoadParams, MarketConfig } from './types.js'

/** `InflexionCore.markets(marketId)` tuple → MarketConfig. */
export function decodeMarketConfig(
  marketId: Hex,
  t: readonly [Address, Address, number, number, Address, number, number, number, boolean],
): MarketConfig {
  return {
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
}

/** `InflexionCore.loadParams()` tuple → LoadParams. */
export function decodeLoadParams(
  t: readonly [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ],
): LoadParams {
  return {
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
}

/** Decoded `InflexionCore.swaps(swapId)` record (NO marketId — recover via resolveMarket). */
export interface SwapRecord {
  tokenId: bigint
  lp: Address
  mm: Address
  V0: bigint
  maxIL: bigint
  collateral: bigint
  premium: bigint
  model: number
  settlement: number
  createdAt: bigint
  expiry: bigint
  amount0Entry: bigint
  amount1Entry: bigint
  liquidity: bigint
  status: number
}

/** `InflexionCore.swaps(swapId)` tuple → SwapRecord. */
export function decodeSwapRecord(
  t: readonly [
    bigint,
    Address,
    Address,
    bigint,
    bigint,
    bigint,
    bigint,
    number,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    number,
  ],
): SwapRecord {
  return {
    tokenId: t[0],
    lp: t[1],
    mm: t[2],
    V0: t[3],
    maxIL: t[4],
    collateral: t[5],
    premium: t[6],
    model: t[7],
    settlement: t[8],
    createdAt: t[9],
    expiry: t[10],
    amount0Entry: t[11],
    amount1Entry: t[12],
    liquidity: t[13],
    status: t[14],
  }
}
