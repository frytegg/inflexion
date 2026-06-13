// Per-tranche NAV history — the depositor-risk (claim B) time series, served live
// by the subgraph via the hosted REST API (`GET /pool/nav-history`) and surfaced
// through the SDK `data.getNavHistory()`. Renders a compact summary + a dual-line
// sparkline (senior vs junior NAV) + a recent-buckets table. Degrades to the honest
// pending note when the API/subgraph is unreachable (never an error, never mocked).
import type { ReactNode } from 'react'
import { formatUnits } from 'viem'
import { scaleLinear } from '@visx/scale'
import { LinePath } from '@visx/shape'
import { Group } from '@visx/group'
import { curveMonotoneX } from '@visx/curve'
import type { ApiBacked, NavHistory, NavSnapshot } from '@inflexion/sdk'
import { Skeleton, PendingNote } from '@/components/ui'
import { FramedPanel } from '@/components/app/chrome'
import { fmtUsd, fmtWadPct } from '@/lib/format'

// tokens (DESIGN_TOKENS.md) — inlined for the SVG presentation attributes.
const C = { teal: '#2DD4BF', warn: '#FBBF24' }

type NavHistoryResult = ApiBacked<NavHistory>

export function NavHistoryView({
  data,
  isLoading,
  title = 'Per-tranche NAV history',
  intro,
}: {
  data?: NavHistoryResult
  isLoading: boolean
  title?: string
  intro?: ReactNode
}) {
  return (
    <FramedPanel title={title}>
      {intro}
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data?.available === true ? (
        data.snapshots.length === 0 ? (
          <p className="text-body-sm text-fg-tertiary">
            No NAV buckets indexed yet — the series begins at the first depositor flow / premium
            accrual / settlement after the deploy block.
          </p>
        ) : (
          <NavHistoryBody snapshots={data.snapshots} disclosure={data.disclosure} />
        )
      ) : (
        <PendingNote>
          {data?.available === false
            ? (data.detail ??
              `Live once the subgraph + API are reachable (route: ${data.endpoint}).`)
            : 'NAV history is subgraph-backed and not yet reachable.'}
        </PendingNote>
      )}
    </FramedPanel>
  )
}

function NavHistoryBody({
  snapshots,
  disclosure,
}: {
  snapshots: NavSnapshot[]
  disclosure?: string
}) {
  // snapshots are oldest→newest (SDK guarantee); latest = last.
  const latest = snapshots[snapshots.length - 1]!
  const totalPremium = snapshots.reduce((a, s) => a + s.premiumAccrued, 0n)
  const totalPayouts = snapshots.reduce((a, s) => a + s.payouts, 0n)
  const totalJuniorLoss = snapshots.reduce((a, s) => a + s.juniorLoss, 0n)
  // Table: most-recent first, capped.
  const rows = [...snapshots].reverse().slice(0, 14)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Mini
          label="Senior NAV"
          value={fmtUsd(latest.seniorAssets)}
          accent="teal"
          sub="latest bucket"
        />
        <Mini
          label="Junior NAV"
          value={fmtUsd(latest.juniorAssets)}
          accent="warn"
          sub="first-loss"
        />
        <Mini label="Premium accrued" value={fmtUsd(totalPremium)} sub="window total" />
        <Mini
          label="Payouts / Jr loss"
          value={`${fmtUsd(totalPayouts)} / ${fmtUsd(totalJuniorLoss)}`}
          accent={totalJuniorLoss > 0n ? 'loss' : undefined}
          sub="window total"
        />
      </div>

      {snapshots.length >= 2 && <NavSparkline snapshots={snapshots} />}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line-subtle text-label uppercase text-fg-tertiary">
              <Th left>Bucket</Th>
              <Th>Senior</Th>
              <Th>Junior</Th>
              <Th>Util</Th>
              <Th>Premium</Th>
              <Th>Payout</Th>
              <Th>Jr loss</Th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((s) => (
              <tr key={s.bucketStart} className="border-b border-line-subtle/50">
                <Td left>{fmtBucket(s.bucketStart)}</Td>
                <Td>{fmtUsd(s.seniorAssets)}</Td>
                <Td>{fmtUsd(s.juniorAssets)}</Td>
                <Td>{fmtWadPct(s.utilWad)}</Td>
                <Td className={s.premiumAccrued > 0n ? 'text-accent-400' : undefined}>
                  {fmtUsd(s.premiumAccrued)}
                </Td>
                <Td>{fmtUsd(s.payouts)}</Td>
                <Td className={s.juniorLoss > 0n ? 'text-loss' : undefined}>
                  {fmtUsd(s.juniorLoss)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {disclosure && <p className="text-body-sm text-fg-tertiary">{disclosure}</p>}
    </div>
  )
}

/** Dual-line sparkline of senior vs junior tranche NAV over time. The y-axis is
 *  zoomed to the data range (NAV moves are small vs the absolute), labelled so. */
function NavSparkline({ snapshots }: { snapshots: NavSnapshot[] }) {
  const W = 600
  const H = 130
  const M = { top: 10, right: 8, bottom: 10, left: 8 }
  const IW = W - M.left - M.right
  const IH = H - M.top - M.bottom

  const xs = snapshots.map((s) => s.bucketStart)
  const sr = snapshots.map((s) => Number(formatUnits(s.seniorAssets, 6)))
  const jr = snapshots.map((s) => Number(formatUnits(s.juniorAssets, 6)))
  const all = [...sr, ...jr]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const pad = (hi - lo) * 0.1 || hi * 0.001 || 1

  const x = scaleLinear({ domain: [Math.min(...xs), Math.max(...xs)], range: [0, IW] })
  const y = scaleLinear({ domain: [lo - pad, hi + pad], range: [IH, 0] })
  const xAt = (_: number, i: number): number => x(xs[i]!)

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Per-tranche NAV over time — senior vs junior."
      >
        <Group left={M.left} top={M.top}>
          <LinePath
            data={sr}
            x={xAt}
            y={(d) => y(d)}
            stroke={C.teal}
            strokeWidth={2}
            curve={curveMonotoneX}
          />
          <LinePath
            data={jr}
            x={xAt}
            y={(d) => y(d)}
            stroke={C.warn}
            strokeWidth={2}
            curve={curveMonotoneX}
          />
        </Group>
      </svg>
      <div className="mt-1 flex items-center gap-4 text-label uppercase text-fg-tertiary">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: C.teal }} /> Senior
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: C.warn }} /> Junior
        </span>
        <span className="ml-auto normal-case text-fg-disabled">y-axis zoomed to data range</span>
      </div>
    </div>
  )
}

// ─── tiny presentational helpers ──────────────────────────────────────────────

function Mini({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: ReactNode
  sub?: string
  accent?: 'teal' | 'warn' | 'loss'
}) {
  const c =
    accent === 'teal'
      ? 'text-accent-400'
      : accent === 'warn'
        ? 'text-warn-400'
        : accent === 'loss'
          ? 'text-loss'
          : 'text-fg'
  return (
    <div>
      <div className="text-label uppercase text-fg-tertiary">{label}</div>
      <div className={`num mt-1 text-body ${c}`}>{value}</div>
      {sub && <div className="mt-0.5 text-body-sm text-fg-tertiary">{sub}</div>}
    </div>
  )
}

function Th({ children, left }: { children: ReactNode; left?: boolean }) {
  return <th className={`py-2 font-normal ${left ? 'text-left' : 'text-right'}`}>{children}</th>
}

function Td({
  children,
  left,
  className,
}: {
  children: ReactNode
  left?: boolean
  className?: string
}) {
  return (
    <td
      className={`py-1.5 ${left ? 'text-left text-fg-tertiary' : 'text-right text-fg-secondary'} ${className ?? ''}`}
    >
      {children}
    </td>
  )
}

/** Unix seconds → `YYYY-MM-DD` (day bucket) or `YYYY-MM-DD HH:00` (hour bucket). */
function fmtBucket(ts: number): string {
  const d = new Date(ts * 1000)
  const date = d.toISOString().slice(0, 10)
  if (ts % 86400 === 0) return date
  return `${date} ${String(d.getUTCHours()).padStart(2, '0')}:00`
}
