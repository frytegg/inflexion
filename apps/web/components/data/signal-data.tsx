'use client'

// Generic renderer for an API-backed data-moat signal: drives the SDK query and
// shows the live data (via the render-prop), an honest "live but empty" note, or
// the typed pending state. Replaces the old pending-only PendingHistory now that
// the hosted subgraph + REST API are live.
import { type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiBacked } from '@inflexion/sdk'
import { Skeleton, PendingNote } from '@/components/ui'

export function SignalData<T>({
  query,
  qk,
  children,
}: {
  query: () => Promise<ApiBacked<T>>
  qk: unknown[]
  children: (data: T) => ReactNode
}) {
  const q = useQuery({ queryKey: qk, queryFn: query, refetchInterval: 60_000 })
  if (q.isLoading) return <Skeleton className="mt-3 h-16 w-full" />
  const env = q.data
  // The success branch of ApiBacked<T> is `{ available: true } & T`; TS can't narrow
  // a generic union through `.available`, so assert the member type after the guard.
  if (env && env.available) return <>{children(env as { available: true } & T)}</>
  return (
    <PendingNote>
      <div className="space-y-1">
        <p>
          {env?.detail ??
            'Live once the subgraph + API are reachable. The on-chain events are emitted now.'}
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

/** The honest "wired + live, but no rows yet" state — distinct from pending. */
export function LiveEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-line-subtle bg-base px-4 py-3 text-body-sm text-fg-tertiary">
      <span className="text-accent-400">Live</span> · {children}
    </div>
  )
}

/** A compact data table. `head[0]` is left-aligned; the rest right-aligned. */
export function DataTable({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line-subtle text-label uppercase text-fg-tertiary">
            {head.map((h, i) => (
              <th key={i} className={`py-2 font-normal ${i === 0 ? 'text-left' : 'text-right'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="num">{children}</tbody>
      </table>
    </div>
  )
}

/** One data row. `cells[0]` is left-aligned/muted; the rest right-aligned. */
export function Row({ cells }: { cells: ReactNode[] }) {
  return (
    <tr className="border-b border-line-subtle/50">
      {cells.map((c, i) => (
        <td
          key={i}
          className={`py-1.5 ${i === 0 ? 'text-left text-fg-tertiary' : 'text-right text-fg-secondary'}`}
        >
          {c}
        </td>
      ))}
    </tr>
  )
}

/** A small inline stat (label + value). */
export function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-label uppercase text-fg-tertiary">{label}</div>
      <div className="num mt-1 text-body text-fg">{value}</div>
    </div>
  )
}
