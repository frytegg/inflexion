'use client'

// Renders the LIVE clearing-load surface (sdk.data.getCurrentLoadSurface) as a
// fee × duration matrix of total load (bps over fair value) — the "price-to-beat"
// every Path-B MM must undercut. Degraded rows (oracle revert / unknown market)
// are inlined, never dropped: the caller sees the gap honestly.
//
// LoadSurface / SurfaceRow / LoadBreakdown shapes from @inflexion/sdk (data.ts +
// types.ts). totalLoadWad is a WAD ratio (1e18 = 1.0); we show it in bps over fair.
import type { LoadSurface, SurfaceRow } from '@inflexion/sdk'
import { MARKETS, findMarket, type MarketDef } from '@/lib/markets'
import { fmtUsd, fmtWadPct, truncHex } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge, EmptyState } from '@/components/ui'

const FEE_LABELS = ['0.05%', '0.30%', '1.00%'] as const
const DURATION_LABELS = ['7d', '30d', '90d'] as const
const REGIME_TONE = { calm: 'teal', normal: 'neutral', stressed: 'warn' } as const

/** WAD ratio → bps integer (1e18 = 10000 bps). */
function wadToBps(wad: bigint): number {
  return (Number(wad) / 1e18) * 10_000
}

/** Heat color: 0 bps → faint, higher load → hotter (amber→loss). Pure CSS opacity. */
function heatStyle(loadBps: number, maxLoadBps: number): React.CSSProperties {
  if (maxLoadBps <= 0) return { backgroundColor: 'rgba(45,212,191,0.06)' }
  const t = Math.min(1, loadBps / maxLoadBps)
  // teal (cool, cheap) → amber (warm) → loss-red (hot) via opacity over a warm hue.
  const alpha = 0.08 + t * 0.34
  return { backgroundColor: `rgba(251,191,36,${alpha.toFixed(3)})` }
}

interface Cell {
  market: MarketDef
  row?: SurfaceRow
}

export function LoadSurfaceGrid({ surface }: { surface: LoadSurface }) {
  // Index the surface rows by marketId for O(1) lookup against the canonical grid.
  const byId = new Map<string, SurfaceRow>()
  for (const r of surface.rows) byId.set(r.marketId.toLowerCase(), r)

  // Build the 3×3 (rows = fee tiers, cols = durations) from the canonical MARKETS.
  // MARKETS is ordered fee-major (fee outer, duration inner) — see lib/markets.
  const grid: Cell[][] = FEE_LABELS.map((feeLabel) =>
    DURATION_LABELS.map((durationLabel) => {
      const market = MARKETS.find(
        (m) => m.feeLabel === feeLabel && m.durationLabel === durationLabel,
      )
      const row = market ? byId.get(market.marketId.toLowerCase()) : undefined
      return { market: market!, row }
    }),
  )

  // Scale the heat to the hottest priceable cell so the surface reads as a surface.
  let maxLoadBps = 0
  for (const r of surface.rows) {
    if (r.available) maxLoadBps = Math.max(maxLoadBps, wadToBps(r.load.totalLoadWad))
  }

  if (surface.rows.length === 0) {
    return <EmptyState title="No markets" desc="No markets were supplied to the surface read." />
  }

  return (
    <div className="space-y-4">
      {/* The matrix */}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-label uppercase text-fg-tertiary">
                Fee \ Duration
              </th>
              {DURATION_LABELS.map((d) => (
                <th key={d} className="px-3 py-2 text-right text-label uppercase text-fg-tertiary">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((cells, fi) => (
              <tr key={FEE_LABELS[fi]}>
                <td className="px-3 py-2 text-label uppercase text-fg-secondary">
                  {FEE_LABELS[fi]}
                </td>
                {cells.map((cell, di) => (
                  <SurfaceCell key={di} cell={cell} maxLoadBps={maxLoadBps} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-label uppercase text-fg-tertiary">
        <span>Cell = total pool load (bps over fair) · pool premium · regime</span>
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ backgroundColor: 'rgba(251,191,36,0.10)' }}
          />
          cheaper to beat
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ backgroundColor: 'rgba(251,191,36,0.42)' }}
          />
          richer to beat
        </span>
      </div>
    </div>
  )
}

function SurfaceCell({ cell, maxLoadBps }: { cell: Cell; maxLoadBps: number }) {
  const { market, row } = cell

  // No market mapping (shouldn't happen with the canonical grid) — render a blank.
  if (!market) {
    return (
      <td className="rounded-md border border-line-subtle px-3 py-3 text-center text-fg-disabled">
        —
      </td>
    )
  }

  // Degraded row: oracle revert or unknown market. Render the gap honestly.
  if (!row || !row.available) {
    const reason = row && !row.available ? row.reason : 'oracle-degraded'
    return (
      <td className="rounded-md border border-warn-500/20 bg-warn-500/5 px-3 py-3 align-top">
        <div
          className="text-label uppercase text-warn-400"
          title={findMarket(market.marketId)?.label}
        >
          {reason === 'market-unknown' ? 'not registered' : 'oracle degraded'}
        </div>
        <div className="mt-1 text-label text-fg-tertiary">{truncHex(market.marketId)}</div>
      </td>
    )
  }

  const loadBps = wadToBps(row.load.totalLoadWad)

  return (
    <td
      className={cn('rounded-md border border-line-subtle px-3 py-3 align-top')}
      style={heatStyle(loadBps, maxLoadBps)}
    >
      <div className="num text-mono-stat text-fg">+{loadBps.toFixed(0)} bps</div>
      <div className="num mt-1 text-body-sm text-fg-secondary">
        {fmtUsd(row.poolPremium)} premium
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Badge tone={REGIME_TONE[row.regime]}>{row.regime}</Badge>
        <span className="num text-label text-fg-tertiary" title="fair rate (premium / MaxIL)">
          {fmtWadPct(row.fairRateWad)}
        </span>
      </div>
    </td>
  )
}
