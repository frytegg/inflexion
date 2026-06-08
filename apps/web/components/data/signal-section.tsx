'use client'

// A labeled wrapper for each of the five data-moat signals. Every signal is
// HONESTLY badged: 'live' (RPC today) or 'pending' (needs the subgraph + API).
// Function-first; the design pass refines later.
import { type ReactNode } from 'react'
import { Panel, Badge } from '@/components/ui'

export function SignalSection({
  n,
  title,
  subtitle,
  status,
  children,
}: {
  n: number
  title: string
  subtitle?: string
  status: 'live' | 'pending'
  children: ReactNode
}) {
  return (
    <Panel
      title={`Signal ${n} — ${title}`}
      right={
        status === 'live' ? <Badge tone="teal">Live</Badge> : <Badge tone="warn">Pending</Badge>
      }
    >
      {subtitle && <p className="mb-4 max-w-2xl text-body-sm text-fg-tertiary">{subtitle}</p>}
      {children}
    </Panel>
  )
}
