'use client'

// One active/settled protection row. Each card owns its getProtectionStatus read
// (so the list can scan many swapIds and render them independently) and exposes a
// Settle button once the swap has expired. The IL-to-date is a Priceable: a
// degraded oracle renders a PendingNote, never an error. Settled swaps additionally
// read the SwapSettled event for the final realized IL + payout (best-effort).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTx } from '@/lib/use-tx'
import { useInflexionSdk } from '@/lib/use-sdk'
import { fmtUsd, fmtDate, fmtDuration, truncAddr } from '@/lib/format'
import { pairLabel } from '@/lib/tokens'
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

  const status = statusQ.data
  const isSettled = status !== undefined && !('available' in status) && status.status === 2

  // Final settlement outcome (realized IL + payout) — only for settled swaps.
  const settlementQ = useQuery({
    queryKey: ['settlement', swapId.toString(), sdk.chainId],
    queryFn: () => sdk.lp.getSettlement(swapId),
    enabled: isSettled,
  })

  if (statusQ.isLoading) return <Skeleton className="h-40 w-full" />
  if (!status) return <Skeleton className="h-40 w-full" />
  // getProtectionStatus degrades to { available:false } for unknown/unreadable swaps.
  if ('available' in status) {
    // swap-unknown means this scanned id isn't a real swap — render nothing.
    return null
  }

  const isActive = status.status === 1
  const settled = status.status === 2
  const expired = status.secondsToExpiry === 0n
  const canSettle = isActive && expired
  const pair = pairLabel(status.token0, status.token1)
  const settlement = settlementQ.data

  const onSettle = async () => {
    const hash = await tx.run(() => sdk.lp.settle(swapId))
    if (hash) {
      qc.invalidateQueries({ queryKey: ['protectionStatus', swapId.toString(), sdk.chainId] })
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{pair}</span>
            <span className="num text-body-sm text-fg-tertiary" title="Settlement (swap) record id">
              swap #{swapId.toString()}
            </span>
            {isActive && <Badge tone="teal">Active</Badge>}
            {settled && <Badge tone="neutral">Settled</Badge>}
            <Badge tone={status.isPathA ? 'teal' : 'mm'}>
              {status.isPathA ? 'Path A · pool' : 'Path B · MM'}
            </Badge>
          </div>
          <div className="mt-1 text-body-sm text-fg-tertiary">
            {status.isPathA ? (
              <span title={`ConvexityVault ${status.mm}`}>Underwriter: cvAMM pool</span>
            ) : (
              <span title={status.mm}>Underwriter: MM {truncAddr(status.mm)}</span>
            )}
            <span title="The Uniswap v3 position protected by this swap">
              {' · NFT #'}
              {status.tokenId.toString()}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right text-body-sm text-fg-tertiary">
          {isActive ? (
            expired ? (
              <span className="text-warn-400">expired — ready to settle</span>
            ) : (
              <>expires in {fmtDuration(status.secondsToExpiry)}</>
            )
          ) : (
            <span title={`created ${fmtDate(status.createdAt)} · expiry ${fmtDate(status.expiry)}`}>
              {fmtDuration(status.durationSeconds)} term · ended {fmtDate(status.expiry)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label={
            <span title="One-time premium you paid for this protection (dUSDC)">Premium paid</span>
          }
          value={fmtUsd(status.premiumPaid)}
        />
        <Stat
          label={
            <span title="Maximum IL covered — your payout is capped here (the no-bad-debt cap)">
              MaxIL cap
            </span>
          }
          value={fmtUsd(status.maxIL)}
          accent="warn"
        />
        <Stat
          label={
            <span title="V0 — the position's value when protection started (dUSDC numéraire)">
              Notional
            </span>
          }
          value={fmtUsd(status.V0)}
        />
        {settled ? (
          <Stat
            label={
              <span title="Realized in-range IL at expiry, paid to you from the underwriter's collateral">
                Final IL
              </span>
            }
            value={
              settlement ? (
                fmtUsd(settlement.realisedIL)
              ) : (
                <span className="text-fg-tertiary">—</span>
              )
            }
            sub={
              settlement
                ? `paid ${fmtUsd(settlement.payout)}${settlement.capHit ? ' · capped at MaxIL' : ''}`
                : settlementQ.isLoading
                  ? 'loading…'
                  : 'settlement detail unavailable'
            }
            accent={settlement && settlement.realisedIL > 0n ? 'loss' : undefined}
          />
        ) : (
          <Stat
            label={
              <span title="Live realized IL so far (settlePreview at the current oracle price)">
                IL to date
              </span>
            }
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
        )}
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
