'use client'

// Page-specific presentational sub-components for /dashboard. These wrap the
// foundation primitives (ui.tsx) — no SDK calls live here; the page owns every
// read/write and passes data down. The LP protections list renders each swap via
// <ActiveProtection> (the same component as the Protect-page history). See
// apps/web/INTEGRATION_MAP.md §2 (/dashboard row) for the wired methods.
import { type ReactNode } from 'react'
import type { BookPosition } from '@inflexion/sdk'
import { Badge } from '@/components/ui'
import { fmtUsd, fmtDuration, truncAddr } from '@/lib/format'

// ─── A row in the MM BOOK section ────────────────────────────────────────────
export function BookRow({ pos }: { pos: BookPosition }) {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const expired = pos.expiry <= now
  const tenorDays = Math.round(Number(pos.expiry - pos.createdAt) / 86_400)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="num text-mono-sm text-fg">#{pos.swapId.toString()}</span>
        <Badge tone={pos.isPathA ? 'teal' : 'mm'}>{pos.isPathA ? 'PATH A' : 'PATH B'}</Badge>
        <span className="text-body-sm text-fg-tertiary">
          {tenorDays > 0 ? `${tenorDays}d · ` : ''}LP {truncAddr(pos.lp)} · NFT #
          {pos.tokenId.toString()}
        </span>
      </div>
      <div className="flex items-center gap-5">
        <span className="num text-mono-sm text-fg-secondary" title="Notional V0">
          {fmtUsd(pos.V0)}
        </span>
        <span className="num text-mono-sm text-warn-400" title="MaxIL — collateral locked">
          {fmtUsd(pos.maxIL)}
        </span>
        <span className="num text-mono-sm text-accent-400" title="Premium earned">
          +{fmtUsd(pos.premium)}
        </span>
        <span className="text-label uppercase text-fg-tertiary">
          {expired ? 'expired' : fmtDuration(pos.expiry - now)}
        </span>
      </div>
    </div>
  )
}

// ─── Small labelled value used in the deposits + collateral grids ────────────
export function KV({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line-subtle py-2 last:border-b-0">
      <span className="text-body-sm text-fg-tertiary">{label}</span>
      <span className="num text-mono-sm text-fg-secondary">{children}</span>
    </div>
  )
}
