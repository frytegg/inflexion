'use client'

// /data — the data-moat showcase. "The first public view into the microstructure
// of the DeFi LP vol-risk premium."
//
// ONE thing is live today, and we say so loudly:
//   (1) the CURRENT clearing-load surface over a transparent σ_ref — a live,
//       uncached RPC multicall (sdk.data.getCurrentLoadSurface + getSurfaceSigmaRef).
//
// The other four signals are STRUCTURAL today / DYNAMIC with volume: each is a
// time-series that needs the subgraph + public API (live on-chain since the
// 2026-06-05 deploy, indexing pending). Those calls return a typed ApiPending
// envelope ({ available:false }), which we render as <PendingNote/> with the
// honest framing + the API route it will be served from — never an error, never
// fabricated data.
//
// No wallet, no writes. Read-only. See apps/web/INTEGRATION_MAP.md §2 (/data row),
// §3.4 (DataClient), §6.7 (framing), §6.4 (subgraph-pending degradation).

import { useQuery } from '@tanstack/react-query'

import { useInflexionSdk } from '@/lib/use-sdk'
import { MARKETS } from '@/lib/markets'
import { tokens } from '@inflexion/sdk'
import { Section, Panel, Badge, Skeleton, PendingNote, ErrorNote } from '@/components/ui'
import { fmtWadPct } from '@/lib/format'

import { LoadSurfaceGrid } from '@/components/data/load-surface-grid'
import { SignalSection } from '@/components/data/signal-section'

const REGIME_TONE = { calm: 'teal', normal: 'neutral', stressed: 'warn' } as const

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

  // Narrow the Degraded<T> envelope to its success branch (explicit, so TS keeps
  // the narrowing across the JSX use sites below).
  const sigma = sigmaQ.data
  const sigmaLive =
    sigma && sigma.available ? { sigmaRefWad: sigma.sigmaRefWad, regime: sigma.regime } : undefined

  return (
    <Section kicker="Data moat" title="The microstructure of the LP vol-risk premium">
      <p className="-mt-2 max-w-3xl text-body text-fg-secondary">
        Inflexion is the first venue to put a public price on the in-range impermanent-loss risk of
        Uniswap v3 LPs. That makes the clearing surface itself a dataset that has never existed
        before: what it costs, right now, to transfer LP convexity to a market maker. The structures
        are live from day one; the dynamics mature with volume.
      </p>

      {/* ── HERO: live clearing-load surface over a transparent σ_ref ── */}
      <div className="mt-8">
        <Panel
          title="Signal 1 — Clearing-load surface"
          right={
            <div className="flex items-center gap-2">
              <Badge tone="teal">Live</Badge>
              {sigmaQ.isLoading ? (
                <Skeleton className="h-5 w-28" />
              ) : sigmaLive ? (
                <Badge tone={REGIME_TONE[sigmaLive.regime]}>
                  σ_ref {fmtWadPct(sigmaLive.sigmaRefWad)} · {sigmaLive.regime}
                </Badge>
              ) : (
                <Badge tone="warn">σ_ref uninitialised</Badge>
              )}
            </div>
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
        </Panel>
      </div>

      {/* ── The five signals: 1 LIVE, 4 subgraph/API-pending ── */}
      <div className="mt-10 space-y-6">
        <h2 className="font-display text-h3 font-bold text-fg">The five signals</h2>
        <p className="-mt-2 max-w-3xl text-body-sm text-fg-tertiary">
          Five lenses on the same risk-transfer market. Signal 1 is live RPC today. The four
          time-series below need the subgraph + public API — the events are emitted on-chain since
          the deploy, indexing is pending. We render the honest pending state, never fabricated
          history.
        </p>

        {/* Signal 1 recap (live) — points at the hero above */}
        <SignalSection
          n={1}
          title="Clearing-load surface"
          status="live"
          subtitle="What it costs, right now, to transfer LP convexity — pool load in bps over fair value, per market."
        >
          <p className="text-body-sm text-fg-secondary">
            Rendered live above. Historical evolution of this same surface (the alpha time-series)
            comes from the subgraph via{' '}
            <code className="text-accent-400">getLoadSurfaceHistory</code> once indexed.
          </p>
          <PendingHistory
            query={() =>
              sdk.data.getLoadSurfaceHistory({ marketId: MARKETS[0]!.marketId, bucket: '1d' })
            }
            qk={['data', 'load-surface-history']}
          />
        </SignalSection>

        {/* Signal 2 — pool-vs-MM spread + win-rate (subgraph + engine) */}
        <SignalSection
          n={2}
          title="Pool-vs-MM spread"
          status="pending"
          subtitle="The mechanical pool baseline vs the behavioral MM load — the spread MMs win on, and how often they win it."
        >
          <PendingHistory
            query={() => sdk.data.getQuoteCompetition({ marketId: MARKETS[0]!.marketId })}
            qk={['data', 'quote-competition']}
          />
        </SignalSection>

        {/* Signal 3 — convexity term structure (subgraph) */}
        <SignalSection
          n={3}
          title="Convexity term structure"
          status="pending"
          subtitle="How the load curves with duration (7d / 30d / 90d) at fixed width — the term structure of the convexity premium."
        >
          <PendingHistory
            query={() =>
              sdk.data.getLoadSurfaceHistory({ marketId: MARKETS[1]!.marketId, bucket: '1d' })
            }
            qk={['data', 'term-structure']}
          />
        </SignalSection>

        {/* Signal 4 — demand skew incl. latent (engine telemetry, off-chain by design) */}
        <SignalSection
          n={4}
          title="Demand skew"
          status="pending"
          subtitle="Realized fills vs latent interest — geometries LPs priced but did not buy. The latent half never touches the chain (I7); it is off-chain engine telemetry by design."
        >
          <PendingHistory
            query={() => sdk.data.getDemandRequests({ marketId: MARKETS[0]!.marketId })}
            qk={['data', 'demand-requests']}
          />
        </SignalSection>

        {/* Signal 5 — net gamma (off-chain compute over the open swap set) */}
        <SignalSection
          n={5}
          title="Net gamma"
          status="pending"
          subtitle="The total convexity the protocol is short (pool + every MM) at what aggregate load, plus Σfree / Σlocked — computed off-chain over the open swap set."
        >
          <PendingHistory query={() => sdk.data.getNetGamma({})} qk={['data', 'net-gamma']} />
        </SignalSection>
      </div>

      {/* ── NAV history (depositor-risk surface) — also pending; carries claim (B) ── */}
      <div className="mt-10">
        <Panel title="Pool NAV history" right={<Badge tone="warn">Pending</Badge>}>
          <p className="mb-3 max-w-2xl text-body-sm text-fg-tertiary">
            Per-tranche net asset value, day by day — the depositor-risk surface. Distinct from the
            LP claim:{' '}
            <strong className="text-fg-secondary">depositor capital is NOT guaranteed</strong>{' '}
            (junior is first-loss, senior is systemic-tail exposed).
          </p>
          <PendingHistory
            query={() => sdk.data.getNavHistory({ bucket: '1d' })}
            qk={['data', 'nav-history']}
          />
        </Panel>
      </div>

      {/* ── Footer: the honest framing + the API ── */}
      <div className="mt-10 space-y-3 rounded-lg border border-line bg-base p-5 text-body-sm text-fg-tertiary">
        <p>
          <strong className="text-fg-secondary">
            Structures from day one, dynamics mature with volume.
          </strong>{' '}
          The clearing surface is live now. The four time-series go live the moment the subgraph
          deploys — the rich events (<code className="text-accent-400">SwapPriced</code>,{' '}
          <code className="text-accent-400">QuoteFilled</code>) have been emitted on-chain since the
          2026-06-05 deploy; only the indexer is pending. The same shapes will be served, cached,
          over the public REST API (<code className="text-accent-400">/data/*</code>).
        </p>
        <p className="text-loss">
          This page surfaces protocol microstructure, not investment advice. Depositor and MM
          capital is NOT guaranteed. LP payout is capped: you receive{' '}
          <code>min(realized in-range IL, MaxIL)</code> — the cap is load-bearing for the
          no-bad-debt guarantee, which holds only under FULL mode, capped payoff, solvent USDC, and
          oracle/settlement liveness.
        </p>
      </div>
    </Section>
  )
}

/**
 * A tiny inline component that fires one of the API-pending DataClient methods and
 * renders its typed ApiPending envelope as a <PendingNote/> — including the future
 * API route + the query that WOULD be sent. Never throws; the SDK returns
 * { available:false } today and we render that honestly.
 */
function PendingHistory({
  query,
  qk,
}: {
  query: () => Promise<import('@inflexion/sdk').ApiPending>
  qk: unknown[]
}) {
  const q = useQuery({ queryKey: qk, queryFn: query, staleTime: Infinity })

  if (q.isLoading) return <Skeleton className="mt-3 h-16 w-full" />
  // ApiPending is always { available:false } today — render it as the honest pending state.
  const env = q.data
  return (
    <PendingNote>
      <div className="space-y-1">
        <p>
          {env?.detail ??
            'Live once the subgraph + API are deployed. The on-chain events are emitted now.'}
        </p>
        {env?.endpoint && (
          <p className="text-label uppercase opacity-80">
            served by{' '}
            <code className="text-accent-400">
              {env.endpoint}
              {env.query && Object.keys(env.query).length > 0
                ? `?${new URLSearchParams(env.query).toString()}`
                : ''}
            </code>
          </p>
        )}
      </div>
    </PendingNote>
  )
}
