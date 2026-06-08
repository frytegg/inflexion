'use client'

// /markets — action-oriented market browser. Fully LIVE via RPC multicall (no
// subgraph). Renders the 9 demo markets with their on-chain clearing load + fair
// premium, then links each to /protect (buy) and /underwrite (quote).
//
// Data sources (INTEGRATION_MAP §2 /markets row):
//   READ  sdk.data.getCurrentLoadSurface({ markets })  — one multicall: per-market
//         fairPremium + poolPremium + load stack + regime (CvammPricing TS port).
//   READ  sdk.data.getSurfaceSigmaRef(tokens.demoWeth)  — the shared σ_ref/regime
//         the whole surface is priced against (all 9 markets share the dWETH oracle).
//   READ  sdk.mm.getMarketConfig(marketId)  — per-row active flag + fee/duration
//         confirmation (cached, immutable post-freeze).
//
// Per-row degradation: a market the surface could not price (oracle stale, σ_ref
// uninitialised, or unregistered) is rendered as an inline muted "—" row with a
// reason Badge — NEVER throws, never drops the row. Volume / share / history need
// the subgraph → surfaced as a header PendingNote, not faked.
//
// Framing (INTEGRATION_MAP §6.7, load-bearing): this is an IN-RANGE convexity
// hedge; the LP payout is min(realized IL, MaxIL) — the CAP is what makes the
// no-bad-debt guarantee hold. Both the header and the fair-premium column say so.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { tokens } from '@inflexion/sdk'
import type { Regime, MarketConfig, SurfaceRow } from '@inflexion/sdk'

import { useInflexionSdk } from '@/lib/use-sdk'
import { MARKETS, type MarketDef } from '@/lib/markets'
import { fmtUsd, fmtWadPct, truncHex } from '@/lib/format'
import { Section, Panel, Badge, Skeleton, PendingNote, ErrorNote, Stat } from '@/components/ui'

// ─── Regime → badge tone ────────────────────────────────────────────────────────
function regimeTone(regime: Regime): 'teal' | 'warn' | 'loss' {
  return regime === 'calm' ? 'teal' : regime === 'normal' ? 'warn' : 'loss'
}

// ─── A single market row ─────────────────────────────────────────────────────────
// `row` is the matching SurfaceRow for this market (discriminated on `available`).
// `config` is the per-market mm.getMarketConfig result (undefined = unregistered).
function MarketRow({
  market,
  row,
  config,
}: {
  market: MarketDef
  // The matching SurfaceRow from data.getCurrentLoadSurface (or undefined while
  // the surface is still loading). Discriminated on `available`.
  row: SurfaceRow | undefined
  config: MarketConfig | undefined
}) {
  const live = row?.available === true
  const inactive = config !== undefined && config.active === false

  return (
    <tr className="border-b border-line-subtle last:border-0 hover:bg-overlay/40">
      {/* Market (fee · duration) */}
      <td className="px-4 py-3">
        <div className="text-body font-medium text-fg">{market.label}</div>
        <div className="num text-body-sm text-fg-tertiary">{truncHex(market.marketId)}</div>
      </td>

      {/* σ_ref / regime */}
      <td className="px-4 py-3">
        {live ? (
          <div className="flex items-center gap-2">
            <span className="num text-mono text-fg">{fmtWadPct(row.sigmaRefWad)}</span>
            <Badge tone={regimeTone(row.regime)}>{row.regime}</Badge>
          </div>
        ) : (
          <span className="text-fg-tertiary">—</span>
        )}
      </td>

      {/* Pool clearing load (the "price to beat", bps) */}
      <td className="num px-4 py-3 text-right">
        {live ? (
          <span className="text-mono text-fg">{fmtWadPct(row.load.totalLoadWad)}</span>
        ) : (
          <span className="text-fg-tertiary">—</span>
        )}
      </td>

      {/* Fair / pool premium (Path-A pool floor, capped at MaxIL) */}
      <td className="num px-4 py-3 text-right">
        {live ? (
          <>
            <div className="text-mono text-fg">{fmtUsd(row.poolPremium)}</div>
            <div className="text-body-sm text-fg-tertiary">
              fair {fmtUsd(row.fairPremium)} · cap {fmtUsd(row.maxIL)}
            </div>
          </>
        ) : (
          <span className="text-fg-tertiary">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        {live ? (
          inactive ? (
            <Badge tone="neutral">paused</Badge>
          ) : (
            <Badge tone="teal">live</Badge>
          )
        ) : row?.available === false ? (
          <Badge tone="warn">
            {row.reason === 'market-unknown' ? 'unregistered' : 'oracle degraded'}
          </Badge>
        ) : (
          <Skeleton className="h-5 w-16" />
        )}
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          <Link
            href={{ pathname: '/protect', query: { market: market.marketId } }}
            className="rounded-md border border-line-strong px-3 py-1.5 text-body-sm text-fg hover:border-fg-tertiary"
          >
            Protect
          </Link>
          <Link
            href={{ pathname: '/underwrite', query: { market: market.marketId } }}
            className="rounded-md border border-mm/40 px-3 py-1.5 text-body-sm text-mm-400 hover:bg-mm/10"
          >
            Underwrite
          </Link>
        </div>
      </td>
    </tr>
  )
}

export default function MarketsPage() {
  const sdk = useInflexionSdk()

  // ── LIVE load surface across all 9 markets (one multicall, no geometry override
  //    → neutral reference geometry; load % is geometry-independent, premiums use
  //    the reference $1k cap). Per-row degradation is inlined, never thrown. ──
  const surfaceQ = useQuery({
    queryKey: ['markets', 'load-surface'],
    queryFn: () =>
      sdk.data.getCurrentLoadSurface({
        markets: MARKETS.map((m) => ({ marketId: m.marketId })),
      }),
    // Pool load drifts with util/σ_ref — keep it reasonably fresh.
    refetchInterval: 15_000,
  })

  // ── Shared σ_ref / regime for the whole surface (all markets share the dWETH
  //    oracle). Degraded if VolOracle isn't poked for the token yet. ──
  const sigmaQ = useQuery({
    queryKey: ['markets', 'sigma-ref', tokens.demoWeth],
    queryFn: () => sdk.data.getSurfaceSigmaRef(tokens.demoWeth),
    refetchInterval: 15_000,
  })

  // ── Per-row market config (active flag) — cached/immutable; one multicall worth
  //    of getMarketConfig reads fanned across the 9 markets. ──
  const configsQ = useQuery({
    queryKey: ['markets', 'configs'],
    queryFn: async () => {
      const entries = await Promise.all(
        MARKETS.map(async (m) => {
          try {
            const cfg = await sdk.mm.getMarketConfig(m.marketId)
            return [m.marketId.toLowerCase(), cfg] as const
          } catch {
            return [m.marketId.toLowerCase(), undefined] as const
          }
        }),
      )
      return Object.fromEntries(entries)
    },
  })

  const surface = surfaceQ.data
  const rowByMarket = new Map((surface?.rows ?? []).map((r) => [r.marketId.toLowerCase(), r]))

  const pricedCount = (surface?.rows ?? []).filter((r) => r.available).length

  return (
    <Section kicker="Markets" title="Market browser">
      {/* Framing — in-range convexity hedge, capped payoff (load-bearing). */}
      <p className="-mt-2 mb-6 max-w-3xl text-body-sm text-fg-secondary">
        In-range convexity hedge: an LP pays a fixed upfront premium to transfer the in-range
        impermanent-loss risk of a Uniswap v3 position. At expiry the payout is{' '}
        <span className="text-fg">min(realized IL, MaxIL)</span> — the cap is load-bearing for the
        no-bad-debt guarantee. The clearing load below is the Path-A pool floor an MM must undercut
        to win the fill.
      </p>

      {/* Surface-level summary stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Markets" value={MARKETS.length} sub="3 fee tiers × 3 durations" />
        <Stat
          label="Priceable now"
          value={surfaceQ.isLoading ? <Skeleton className="h-7 w-10" /> : pricedCount}
          sub="live oracle + σ_ref"
        />
        <Stat
          label="σ_ref (dWETH)"
          value={
            sigmaQ.isLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : sigmaQ.data?.available ? (
              fmtWadPct(sigmaQ.data.sigmaRefWad)
            ) : (
              '—'
            )
          }
          sub="EWMA reference vol"
        />
        <Stat
          label="Regime"
          value={
            sigmaQ.isLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : sigmaQ.data?.available ? (
              <Badge tone={regimeTone(sigmaQ.data.regime)}>{sigmaQ.data.regime}</Badge>
            ) : (
              '—'
            )
          }
          sub="σ_ref vs load bands"
        />
      </div>

      <Panel
        title="Live markets"
        right={
          surface?.blockNumber !== undefined ? (
            <span className="num text-label text-fg-tertiary">
              block {surface.blockNumber.toString()}
            </span>
          ) : undefined
        }
      >
        {surfaceQ.isError ? (
          <ErrorNote>
            Could not read the live load surface from RPC.{' '}
            {surfaceQ.error instanceof Error ? surfaceQ.error.message : 'Unknown error.'}
          </ErrorNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-2 text-label uppercase text-fg-tertiary">Market</th>
                  <th className="px-4 py-2 text-label uppercase text-fg-tertiary">
                    σ_ref · regime
                  </th>
                  <th className="px-4 py-2 text-right text-label uppercase text-fg-tertiary">
                    Clearing load
                  </th>
                  <th className="px-4 py-2 text-right text-label uppercase text-fg-tertiary">
                    Pool premium
                  </th>
                  <th className="px-4 py-2 text-label uppercase text-fg-tertiary">Status</th>
                  <th className="px-4 py-2 text-right text-label uppercase text-fg-tertiary">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {MARKETS.map((m) => (
                  <MarketRow
                    key={m.marketId}
                    market={m}
                    row={rowByMarket.get(m.marketId.toLowerCase())}
                    config={configsQ.data?.[m.marketId.toLowerCase()]}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {surface?.note && <p className="mt-4 text-body-sm text-fg-tertiary">{surface.note}</p>}
      </Panel>

      {/* Subgraph-pending surfaces — volume / share / history. Render honestly. */}
      <div className="mt-6">
        <PendingNote>
          Per-market volume, MM win-rate / share, and the historical clearing-load surface need the
          subgraph (events are live on-chain since deploy; indexing is pending). Everything above —
          clearing load, fair premium, σ_ref, regime — is live RPC right now.
        </PendingNote>
      </div>
    </Section>
  )
}
