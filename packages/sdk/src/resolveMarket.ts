/**
 * `resolveMarket` — the shared helper that recovers a swap's market.
 *
 * A `SwapRecord` carries NO `marketId` (kept compact on-chain). To recover it the
 * SDK reproduces the exact on-chain derivation in `_marketIdForSwap`:
 *
 *   NPM.positions(s.tokenId) → (token0, token1, fee)
 *   marketId = keccak256(abi.encodePacked(token0, token1, fee, uint32(expiry - createdAt)))
 *   cfg      = InflexionCore.markets(marketId)
 *
 * Used by every LP/MM surface row that starts from a `swapId`.
 */
import { encodePacked, keccak256, type Hex, type PublicClient } from 'viem'
import { core as coreAddrs, npm as npmAddr } from './addresses.js'
import { inflexionCoreAbi, npmAbi } from './abis.js'
import { decodeMarketConfig, type SwapRecord } from './decode.js'
import type { MarketConfig } from './types.js'

/** Compute the marketId for a (token0, token1, fee, durationSeconds) tuple — the
 *  exact `keccak256(abi.encodePacked(...))` the contract uses at registration. */
export function computeMarketId(
  token0: `0x${string}`,
  token1: `0x${string}`,
  fee: number,
  durationSeconds: number,
): Hex {
  return keccak256(
    encodePacked(
      ['address', 'address', 'uint24', 'uint32'],
      [token0, token1, fee, durationSeconds],
    ),
  )
}

export interface ResolvedMarket {
  marketId: Hex
  config: MarketConfig
  /** The pool tokens + fee read from the position (the marketId pre-image). */
  token0: `0x${string}`
  token1: `0x${string}`
  fee: number
  durationSeconds: number
}

/**
 * Recover the market for a decoded swap record. Reads `NPM.positions(tokenId)`
 * for (token0, token1, fee), derives the marketId from those + the swap's
 * (expiry − createdAt) duration, and reads back `markets(marketId)`.
 */
export async function resolveMarket(
  client: PublicClient,
  swap: Pick<SwapRecord, 'tokenId' | 'expiry' | 'createdAt'>,
  opts?: { coreAddress?: `0x${string}`; npmAddress?: `0x${string}` },
): Promise<ResolvedMarket> {
  const coreAddress = opts?.coreAddress ?? coreAddrs.inflexionCore
  const npmAddress = opts?.npmAddress ?? npmAddr

  const pos = await client.readContract({
    address: npmAddress,
    abi: npmAbi,
    functionName: 'positions',
    args: [swap.tokenId],
  })
  const token0 = pos[2]
  const token1 = pos[3]
  const fee = pos[4]
  const durationSeconds = Number(swap.expiry - swap.createdAt)
  const marketId = computeMarketId(token0, token1, fee, durationSeconds)

  const cfgTuple = await client.readContract({
    address: coreAddress,
    abi: inflexionCoreAbi,
    functionName: 'markets',
    args: [marketId],
  })
  const config = decodeMarketConfig(marketId, cfgTuple)
  return { marketId, config, token0, token1, fee, durationSeconds }
}
