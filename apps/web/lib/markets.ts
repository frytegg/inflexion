// The 9 demo markets (3 fee tiers × 3 durations), registered by the deploy.
// marketId = keccak256(abi.encodePacked(token0, token1, fee, durationSeconds))
// with token0 = dWETH (< dUSDC by address), token1 = dUSDC — matches
// InflexionCore.registerMarket / the on-chain derivation. SDK read methods take
// caller-supplied marketIds, so this is the canonical list the UI selects from.
import { keccak256, encodePacked, type Hex } from 'viem'
import { tokens, demo } from '@inflexion/sdk'

export interface MarketDef {
  marketId: Hex
  fee: number // uint24
  durationSeconds: number
  feeLabel: string // "0.05%"
  durationLabel: string // "7d"
  label: string // "0.05% · 7d"
}

const FEES = [500, 3000, 10_000] as const
const DURATIONS = [7 * 86_400, 30 * 86_400, 90 * 86_400] as const

function deriveMarketId(fee: number, durationSeconds: number): Hex {
  return keccak256(
    encodePacked(
      ['address', 'address', 'uint24', 'uint32'],
      [tokens.demoWeth, tokens.demoUsdc, fee, durationSeconds],
    ),
  )
}

export const MARKETS: MarketDef[] = [
  ...FEES.flatMap((fee) =>
    DURATIONS.map((durationSeconds) => {
      const feeLabel = `${(fee / 10_000).toFixed(2)}%`
      const durationLabel = `${durationSeconds / 86_400}d`
      return {
        marketId: deriveMarketId(fee, durationSeconds),
        fee,
        durationSeconds,
        feeLabel,
        durationLabel,
        label: `${feeLabel} · ${durationLabel}`,
      }
    }),
  ),
  // 5-minute fee-500 market — settle-able on camera (the 7/30/90d markets can't
  // expire during a demo). Registered on-chain via DemoLifecycle; its marketId
  // matches the registry's lifecycle.shortMarketId_fee500_300s.
  {
    marketId: deriveMarketId(500, 300),
    fee: 500,
    durationSeconds: 300,
    feeLabel: '0.05%',
    durationLabel: '5min',
    label: '0.05% · 5min (demo)',
  },
]

/** Known-good anchor from the registry (fee 500, 7d) — sanity-matches MARKETS[0]. */
export const DEMO_MARKET_ID = demo.marketId_fee500_7d as Hex

export function findMarket(marketId: string): MarketDef | undefined {
  return MARKETS.find((m) => m.marketId.toLowerCase() === marketId.toLowerCase())
}
