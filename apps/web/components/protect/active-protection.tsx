'use client'

// One active/settled protection row. Each card owns its getProtectionStatus read
// (so the list can scan many swapIds and render them independently) and exposes a
// Settle button once the swap has expired. The IL-to-date is a Priceable: a
// degraded oracle renders a PendingNote, never an error.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTx } from '@/lib/use-tx'
import { useInflexionSdk } from '@/lib/use-sdk'
import { fmtUsd, fmtDuration, truncAddr } from '@/lib/format'
import { Badge, Card, ErrorNote, PendingNote, Skeleton, Stat, TxButton } from '@/components/ui'

export function ActiveProtection({ swapId }: { swapId: bigint }) {
  const sdk = useInflexionSdk()
  const tx = useTx()
  const qc = useQueryClient()

  const statusQ = useQuery({
    queryKey: ['protectionStatus', swapId.toString(), sdk.chainId],
    queryFn: () => sdk.lp.getProtectionStatus(swapId),
    refetchInterval: 20_000,
  })

  if (statusQ.isLoading) return <Skeleton className="h-40 w-full" />
  const status = statusQ.data
  if (!status) return <Skeleton className="h-40 w-full" />
  // getProtectionStatus degrades to { available:false } for unknown/unreadable swaps.
  if ('available' in status) {
    // swap-unknown means this scanned id isn't a real swap — render nothing.
    return null
  }

  const isActive = status.status === 1
  const isSettled = status.status === 2
  const expired = status.secondsToExpiry === 0n
  const canSettle = isActive && expired

  const onSettle = async () => {
    const hash = await tx.run(() => sdk.lp.settle(swapId))
    if (hash) {
      qc.invalidateQueries({ queryKey: ['protectionStatus', swapId.toString(), sdk.chainId] })
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="num text-mono text-fg">swap #{swapId.toString()}</span>
            {isActive && <Badge tone="teal">Active</Badge>}
            {isSettled && <Badge tone="neutral">Settled</Badge>}
            <Badge tone={status.isPathA ? 'teal' : 'mm'}>
              {status.isPathA ? 'Path A · pool' : 'Path B · MM'}
            </Badge>
          </div>
          <div className="mt-1 text-body-sm text-fg-tertiary">
            underwriter {truncAddr(status.mm)}
          </div>
        </div>
        <div className="text-right text-body-sm text-fg-tertiary">
          {isActive ? (
            expired ? (
              <span className="text-warn-400">expired — ready to settle</span>
            ) : (
              <>expires in {fmtDuration(status.secondsToExpiry)}</>
            )
          ) : (
            <>settled</>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Premium paid" value={fmtUsd(status.premiumPaid)} />
        <Stat label="MaxIL cap" value={fmtUsd(status.maxIL)} accent="warn" />
        <Stat label="V0 (notional)" value={fmtUsd(status.V0)} />
        <Stat
          label="IL to date"
          value={
            status.ilToDate.priceable ? (
              fmtUsd(status.ilToDate.il)
            ) : (
              <span className="text-fg-tertiary">—</span>
            )
          }
          sub={
            status.ilToDate.priceable
              ? `payout ${fmtUsd(status.ilToDate.payout)}${status.ilToDate.capHit ? ' · capped' : ''}`
              : undefined
          }
          accent={status.ilToDate.priceable && status.ilToDate.il > 0n ? 'loss' : undefined}
        />
      </div>

      {isActive && !status.ilToDate.priceable && (
        <div className="mt-4">
          <PendingNote>
            Live IL-to-date unavailable (oracle degraded). The protection is intact — payout is
            still computed at settlement from the price-at-expiry.
          </PendingNote>
        </div>
      )}

      {canSettle && (
        <div className="mt-4 flex items-center gap-3">
          <TxButton status={tx.status} onClick={onSettle}>
            Settle now
          </TxButton>
          <span className="text-body-sm text-fg-tertiary">
            Pays your realized IL — capped at MaxIL — from the underwriter&apos;s collateral.
          </span>
        </div>
      )}
      {tx.error && (
        <div className="mt-3">
          <ErrorNote>{tx.error}</ErrorNote>
        </div>
      )}
    </Card>
  )
}
