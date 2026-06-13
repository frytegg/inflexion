'use client'

// /data — the data-moat showcase. "The first public view into the microstructure
// of the DeFi LP vol-risk premium."
//
// All surfaces are LIVE:
//   (1) the CURRENT clearing-load surface over a transparent σ_ref — a live,
//       uncached RPC multicall (sdk.data.getCurrentLoadSurface + getSurfaceSigmaRef).
//   (2) the time-series signals (load-surface history, pool-vs-MM spread, demand
//       skew, net gamma) + NAV history — served by the deployed subgraph via the
//       hosted REST API (sdk.data.* → NEXT_PUBLIC_API_URL). They return real data
//       now; most are sparse until volume accrues, so we render the live rows when
//       present and an honest "live · no rows yet" note when empty — never an
//       error, never fabricated history. If the API is unreachable the SDK degrades
//       each surface to a typed pending envelope, rendered as a <PendingNote/>.
//
// No wallet, no writes. Read-only. See apps/web/INTEGRATION_MAP.md §2 (/data row),
// §3.4 (DataClient), §6.7 (framing), §6.4 (subgraph-pending degradation).

import { type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useInflexionSdk } from '@/lib/use-sdk'
import { MARKETS } from '@/lib/markets'
import {
  tokens,
  type LoadSurfaceHistory,
  type QuoteCompetition,
  type DemandRequests,
  type NetGamma,
} from '@inflexion/sdk'
import { Skeleton, ErrorNote } from '@/components/ui'
import { PageShell, PageHeader, FramedPanel, Reveal } from '@/components/app/chrome'
import { fmtWadPct, fmtUsd, fmtBps, fmtWad, fmtDate, truncAddr } from '@/lib/format'

import { LoadSurfaceGrid } from '@/components/data/load-surface-grid'
import { SignalSection } from '@/components/data/signal-section'
import { NavHistoryView } from '@/components/data/nav-history'
import { SignalData, LiveEmpty, DataTable, Row, MiniStat } from '@/components/data/signal-data'

export default function DataPage() {
  const sdk = useInflexionSdk()

  // ── (1) LIVE: current clearing-load surface across all 9 markets ──
  // getCurrentLoadSurface never throws; per-market oracle reverts inline as a
  // degraded SurfaceRow. We pass the canonical 9-market grid (no geometry → the
  // SDK's neutral reference geometry; the LOAD % is geometry-independent).
  const surfaceQ = useQuery({
    queryKey: ['data', 'load-surface', MARKETS.map((m) => m.marketId)],
    queryFn: () =>
      sdk.data.getCurrentLoadSurface({ markets: MARKETS.map((m) => ({ marketId: m.marketId })) }),
    refetchInterval: 30_000,
  })

  // ── LIVE: σ_ref the surface is priced against (transparent backdrop) ──
  const sigmaQ = useQuery({
    queryKey: ['data', 'surface-sigma', tokens.demoWeth],
    queryFn: () => sdk.data.getSurfaceSigmaRef(tokens.demoWeth),
    refetchInterval: 30_000,
  })

  // ── NAV history (depositor-risk, claim B) — live via the subgraph + hosted API ──
  const navQ = useQuery({
    queryKey: ['data', 'nav-history'],
    queryFn: () => sdk.data.getNavHistory({ bucket: '1d' }),
    refetchInterval: 60_000,
  })

  // Narrow the Degraded<T> envelope to its success branch (explicit, so TS keeps
  // the narrowing across the JSX use sites below).
  const sigma = sigmaQ.data
  const sigmaLive =
    sigma && sigma.available ? { sigmaRefWad: sigma.sigmaRefWad, regime: sigma.regime } : undefined

  return (
    <PageShell>
      <PageHeader title="Data">
        The first public price on the in-range impermanent-loss risk of Uniswap v3 LPs — what it
        costs, right now, to transfer LP convexity to a market maker. The structures are live from
        day one; the dynamics mature with volume.
      </PageHeader>

      {/* ── HERO: live clearing-load surface over a transparent σ_ref ── */}
      <Reveal className="mt-8">
        <FramedPanel
          title="Signal 1 — Clearing-load surface"
          right={
            sigmaQ.isLoading ? (
              <Skeleton className="h-5 w-28" />
            ) : sigmaLive ? (
              <span className="num text-label uppercase text-fg-tertiary">
                σ_ref {fmtWadPct(sigmaLive.sigmaRefWad)}
              </span>
            ) : null
          }
        >
          <p className="mb-4 max-w-2xl text-body-sm text-fg-tertiary">
            The pool&rsquo;s &ldquo;price-to-beat&rdquo; load (in bps over fair value) across all
            nine markets, read live from the chain — fair value from the on-chain FairValueOracle,
            the load stack finished with the parity-locked CvammPricing port. This is the load every
            Path-B MM must undercut to win a fill. It sits over a transparent σ_ref: the EWMA
            reference vol the whole surface is priced against.
          </p>

          {surfaceQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : surfaceQ.isError ? (
            <ErrorNote>
              Failed to read the live load surface from RPC. Check the network and retry.
            </ErrorNote>
          ) : surfaceQ.data ? (
            <LoadSurfaceGrid surface={surfaceQ.data} />
          ) : null}

          {surfaceQ.data?.blockNumber !== undefined && (
            <p className="mt-3 text-label uppercase text-fg-tertiary">
              Block {surfaceQ.data.blockNumber.toString()} · live uncached RPC multicall
            </p>
          )}
        </FramedPanel>
      </Reveal>

      {/* ── The five signals — all live via RPC + the hosted subgraph/API ── */}
      <div className="mt-10 space-y-6">
        <h2 className="font-display text-h3 font-bold text-fg">The five signals</h2>
        <p className="-mt-2 max-w-3xl text-body-sm text-fg-tertiary">
          Five lenses on the same risk-transfer market. Signal 1 is live RPC; the four time-series
          are served by the deployed subgraph via the hosted REST API. They carry real data now and
          fill in with volume — we render live rows when present, an honest &ldquo;live · no rows
          yet&rdquo; note when empty, never fabricated history.
        </p>

        {/* Signal 1 recap (live) — points at the hero above + the historical series */}
        <SignalSection
          n={1}
          title="Clearing-load surface"
          status="live"
          subtitle="What it costs, right now, to transfer LP convexity — pool load in bps over fair value, per market."
        >
          <p className="text-body-sm text-fg-secondary">
            Rendered live above. Historical day-by-day evolution of this same surface (the alpha
            time-series) is served by the subgraph via{' '}
            <code className="text-accent-400">getLoadSurfaceHistory</code>.
          </p>
          <div className="mt-3">
            <SignalData<LoadSurfaceHistory>
              query={() =>
                sdk.data.getLoadSurfaceHistory({ marketId: MARKETS[0]!.marketId, bucket: '1d' })
              }
              qk={['data', 'load-surface-history']}
            >
              {renderLoadSurface}
            </SignalData>
          </div>
        </SignalSection>

        {/* Signal 2 — pool-vs-MM spread + win-rate (subgraph + engine) */}
        <SignalSection
          n={2}
          title="Pool-vs-MM spread"
          status="live"
          subtitle="The mechanical pool baseline vs the behavioral MM load — the spread MMs win on, and how often they win it."
        >
          <SignalData<QuoteCompetition>
            query={() => sdk.data.getQuoteCompetition({ marketId: MARKETS[0]!.marketId })}
            qk={['data', 'quote-competition']}
          >
            {renderQuoteCompetition}
          </SignalData>
        </SignalSection>

        {/* Signal 3 — convexity term structure (subgraph) */}
        <SignalSection
          n={3}
          title="Convexity term structure"
          status="live"
          subtitle="How the load curves with duration (7d / 30d / 90d) at fixed width — the term structure of the convexity premium."
        >
          <SignalData<LoadSurfaceHistory>
            query={() =>
              sdk.data.getLoadSurfaceHistory({ marketId: MARKETS[1]!.marketId, bucket: '1d' })
            }
            qk={['data', 'term-structure']}
          >
            {renderLoadSurface}
          </SignalData>
        </SignalSection>

        {/* Signal 4 — demand skew incl. latent (engine telemetry, off-chain by design) */}
        <SignalSection
          n={4}
          title="Demand skew"
          status="live"
          subtitle="Realized fills vs latent interest — geometries LPs priced but did not buy. The latent half never touches the chain; it is off-chain engine telemetry by design."
        >
          <SignalData<DemandRequests>
            query={() => sdk.data.getDemandRequests({ marketId: MARKETS[0]!.marketId })}
            qk={['data', 'demand-requests']}
          >
            {renderDemand}
          </SignalData>
        </SignalSection>

        {/* Signal 5 — net gamma (off-chain compute over the open swap set) */}
        <SignalSection
          n={5}
          title="Net gamma"
          status="live"
          subtitle="The total convexity the protocol is short (pool + every MM) at what aggregate load, plus Σactive V0 / MaxIL — computed off-chain over the open swap set."
        >
          <SignalData<NetGamma> query={() => sdk.data.getNetGamma({})} qk={['data', 'net-gamma']}>
            {renderNetGamma}
          </SignalData>
        </SignalSection>
      </div>

      {/* ── NAV history (depositor-risk surface) — live; carries claim (B) ── */}
      <Reveal className="mt-10">
        <NavHistoryView
          title="Pool NAV history"
          data={navQ.data}
          isLoading={navQ.isLoading}
          intro={
            <p className="mb-3 max-w-2xl text-body-sm text-fg-tertiary">
              Per-tranche net asset value, day by day — the depositor-risk surface. Distinct from
              the LP claim:{' '}
              <strong className="text-fg-secondary">depositor capital is NOT guaranteed</strong>{' '}
              (junior is first-loss, senior is systemic-tail exposed).
            </p>
          }
        />
      </Reveal>

      {/* ── Footer: the honest framing + the API ── */}
      <Reveal className="mt-10 space-y-3 rounded-lg border border-line bg-base p-5 text-body-sm text-fg-tertiary">
        <p>
          <strong className="text-fg-secondary">
            Structures from day one, dynamics mature with volume.
          </strong>{' '}
          The clearing surface is live over RPC; the four time-series are served live by the
          deployed subgraph over the public REST API (
          <code className="text-accent-400">/data/*</code>). The rich events (
          <code className="text-accent-400">SwapPriced</code>,{' '}
          <code className="text-accent-400">QuoteFilled</code>) have been emitted on-chain since the
          2026-06-05 deploy and are indexed now; the surfaces deepen as volume accrues.
        </p>
      </Reveal>
    </PageShell>
  )
}

// ─── Per-signal renderers (live rows when present; honest empty note otherwise) ─

/** Signals 1 & 3 — historical clearing-load surface for one market. */
function renderLoadSurface(d: LoadSurfaceHistory): ReactNode {
  if (d.snapshots.length === 0)
    return (
      <LiveEmpty>
        no historical load buckets indexed yet — the daily series begins at the first fill in this
        market.
      </LiveEmpty>
    )
  return (
    <DataTable head={['Day', 'Total load', 'Util', 'Fills', 'V0 volume']}>
      {[...d.snapshots]
        .reverse()
        .slice(0, 10)
        .map((s) => (
          <Row
            key={s.bucketStart}
            cells={[
              fmtDate(s.bucketStart),
              fmtWadPct(s.totalLoadWad),
              fmtWadPct(s.utilWad),
              s.fillCount,
              fmtUsd(s.v0Volume),
            ]}
          />
        ))}
    </DataTable>
  )
}

/** Signal 2 — pool-vs-MM quote competition, aggregated per MM. */
function renderQuoteCompetition(d: QuoteCompetition): ReactNode {
  if (d.competition.length === 0)
    return (
      <LiveEmpty>
        {d.enabled
          ? 'the pool baseline is logged per fill; the MM-vs-pool spread populates once ≥2 MMs compete. No competition rows yet.'
          : 'the engine COMPETITION_LOG sink is not reporting rows yet.'}
      </LiveEmpty>
    )
  return (
    <DataTable head={['MM', 'Quotes', 'Accepted', 'Load bps (min/avg/max)']}>
      {d.competition.slice(0, 10).map((c) => (
        <Row
          key={c.mm}
          cells={[
            truncAddr(c.mm),
            c.quotes,
            c.accepted,
            `${fmtBps(c.minLoadBps)} / ${fmtBps(c.avgLoadBps)} / ${fmtBps(c.maxLoadBps)}`,
          ]}
        />
      ))}
    </DataTable>
  )
}

/** Signal 4 — demand skew: realized fills (on-chain) + latent interest (telemetry). */
function renderDemand(d: DemandRequests): ReactNode {
  if (d.realized.length === 0 && d.latent.length === 0)
    return (
      <LiveEmpty>
        no demand buckets yet — realized fills (on-chain) + latent previews (telemetry) populate as
        LPs price and buy.
      </LiveEmpty>
    )
  return (
    <div className="space-y-4">
      {d.realized.length > 0 && (
        <div>
          <p className="mb-2 text-label uppercase text-fg-tertiary">Realized fills (on-chain)</p>
          <DataTable head={['Width', 'Distance', 'Duration', 'Fills', 'V0']}>
            {d.realized.map((b) => (
              <Row
                key={b.id}
                cells={[
                  b.widthBucket,
                  b.distanceBucket,
                  b.durationBucket,
                  b.realizedFillCount,
                  fmtUsd(b.realizedV0),
                ]}
              />
            ))}
          </DataTable>
        </div>
      )}
      {d.latent.length > 0 && (
        <div>
          <p className="mb-2 text-label uppercase text-fg-tertiary">
            Latent interest (priced, not bought)
          </p>
          <DataTable head={['Width', 'Distance', 'Duration', 'Previews', 'Quote reqs']}>
            {d.latent.map((b, i) => (
              <Row
                key={`${b.widthBucket}-${b.distanceBucket}-${b.durationBucket}-${i}`}
                cells={[
                  b.widthBucket,
                  b.distanceBucket,
                  b.durationBucket,
                  b.previews,
                  b.quoteRequests,
                ]}
              />
            ))}
          </DataTable>
        </div>
      )}
    </div>
  )
}

/** Signal 5 — net convexity / gamma supply: protocol-wide aggregate + history. */
function renderNetGamma(d: NetGamma): ReactNode {
  const ps = d.protocolState
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <MiniStat label="Active swaps" value={ps.activeSwapCount} />
        <MiniStat label="Σ active V0" value={fmtUsd(ps.totalActiveV0)} />
        <MiniStat label="Σ active MaxIL" value={fmtUsd(ps.totalActiveMaxIL)} />
      </div>
      {d.snapshots.length === 0 ? (
        <LiveEmpty>
          protocol-wide net-gamma snapshots accrue as the open-swap set grows (currently{' '}
          {ps.activeSwapCount} active).
        </LiveEmpty>
      ) : (
        <DataTable head={['Bucket', 'Active', 'Σ V0', 'Γ (wad)', 'Vw load']}>
          {[...d.snapshots]
            .reverse()
            .slice(0, 8)
            .map((s) => (
              <Row
                key={s.bucketStart}
                cells={[
                  fmtDate(s.bucketStart),
                  s.activeSwapCount,
                  fmtUsd(s.totalV0),
                  fmtWad(s.aggGammaWad),
                  fmtWadPct(s.volumeWeightedLoadWad),
                ]}
              />
            ))}
        </DataTable>
      )}
    </div>
  )
}
