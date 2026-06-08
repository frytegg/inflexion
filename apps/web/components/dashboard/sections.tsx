'use client'

// Page-specific presentational + action sub-components for /dashboard. These wrap
// the foundation primitives (ui.tsx) — no new SDK calls live here; the page owns
// every read/write and passes data + handlers down. See apps/web/INTEGRATION_MAP.md
// §2 (/dashboard row) for the wired methods.
import { type ReactNode } from 'react'
import type { ProtectionStatus, BookPosition } from '@inflexion/sdk'
import { Badge, Card, Stat, TxButton, Button, ErrorNote } from '@/components/ui'
import type { TxStatus } from '@/lib/use-tx'
import { fmtUsd, fmtUsdc, fmtToken, fmtDuration, truncAddr } from '@/lib/format'

// ─── Status enum → label/tone ────────────────────────────────────────────────
const STATUS_LABEL: Record<number, string> = {
  0: 'UNINITIALIZED',
  1: 'ACTIVE',
  2: 'SETTLED',
}

function statusTone(status: number, expired: boolean): 'teal' | 'warn' | 'neutral' {
  if (status === 2) return 'neutral'
  if (status === 1 && expired) return 'warn'
  return 'teal'
}

// ─── Claimable fees view (subset of LpClient.ClaimableFees the card renders) ──
export interface ClaimableFeesView {
  fee0: bigint
  fee1: bigint
}

// ─── A row in the PROTECTIONS (LP) section ───────────────────────────────────
export function ProtectionCard({
  ps,
  fees,
  settleStatus,
  settleError,
  onSettle,
  marketLabel,
}: {
  ps: ProtectionStatus
  fees?: ClaimableFeesView
  settleStatus: TxStatus
  settleError?: string
  onSettle: () => void
  marketLabel?: string
}) {
  const expired = ps.status === 1 && ps.secondsToExpiry === 0n
  const settleable = ps.status === 1 && expired

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="num text-mono text-fg">swap #{ps.swapId.toString()}</span>
          <Badge tone={statusTone(ps.status, expired)}>
            {STATUS_LABEL[ps.status] ?? '—'}
            {expired && ps.status === 1 ? ' · EXPIRED' : ''}
          </Badge>
          <Badge tone={ps.isPathA ? 'teal' : 'mm'}>
            {ps.isPathA ? 'PATH A · POOL' : 'PATH B · MM'}
          </Badge>
        </div>
        <span className="text-body-sm text-fg-tertiary">
          {marketLabel ? `${marketLabel} · ` : ''}
          {ps.isPathA ? 'pool underwriter' : `MM ${truncAddr(ps.mm)}`}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Premium paid" value={fmtUsd(ps.premiumPaid)} />
        <Stat label="Notional V0" value={fmtUsd(ps.V0)} />
        <Stat label="MaxIL (cap)" value={fmtUsd(ps.maxIL)} accent="warn" sub="collateral == cap" />
        <Stat
          label={ps.status === 1 ? (expired ? 'Expired' : 'Time to expiry') : 'Lifecycle'}
          value={
            ps.status === 2
              ? 'settled'
              : expired
                ? 'ready to settle'
                : fmtDuration(ps.secondsToExpiry)
          }
        />
      </div>

      {/* IL to date — Priceable; render the degraded path as a quiet pending note. */}
      <div className="mt-4 rounded-md border border-line-subtle bg-base px-4 py-3">
        {ps.ilToDate.priceable ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-6">
              <Stat label="IL to date" value={fmtUsd(ps.ilToDate.il)} />
              <Stat
                label="Payout if settled now"
                value={fmtUsd(ps.ilToDate.payout)}
                accent="teal"
                sub="min(IL, MaxIL)"
              />
            </div>
            {ps.ilToDate.capHit && <Badge tone="warn">CAP BINDING</Badge>}
          </div>
        ) : (
          <p className="text-body-sm text-fg-tertiary">
            Live IL-to-date unavailable ({ps.ilToDate.reason}). The oracle is degraded or the swap
            is settled — premium / cap / expiry above are still on-chain accurate.
          </p>
        )}
      </div>

      {/* Claimable Uniswap v3 fees — under-states (checkpointed tokensOwed only). */}
      {fees && (fees.fee0 > 0n || fees.fee1 > 0n) && (
        <p className="mt-3 text-body-sm text-fg-tertiary">
          Checkpointed pool fees:{' '}
          <span className="num text-fg-secondary">{fmtToken(fees.fee0, 18)}</span> token0 ·{' '}
          <span className="num text-fg-secondary">{fmtUsdc(fees.fee1)}</span> token1{' '}
          <span className="text-fg-disabled">
            (under-states live-uncollected — full accounting needs the subgraph)
          </span>
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        {settleable ? (
          <TxButton status={settleStatus} onClick={onSettle}>
            Settle &amp; collect payout
          </TxButton>
        ) : ps.status === 1 ? (
          <Button variant="ghost" disabled>
            Settles after expiry
          </Button>
        ) : (
          <Button variant="ghost" disabled>
            Settled
          </Button>
        )}
      </div>
      {settleError && (
        <div className="mt-3">
          <ErrorNote>{settleError}</ErrorNote>
        </div>
      )}
    </Card>
  )
}

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
