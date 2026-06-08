'use client'

/**
 * /dashboard — the connected user's portfolio across all three roles:
 *   1. PROTECTIONS (LP)  — swaps where lp == you; settle expired ones.       (claim A)
 *   2. DEPOSITS (depositor) — senior/junior NAV + withdraw flow.            (claim B)
 *   3. MM BOOK — active swaps you underwrite + your collateral usage.       (claim B)
 *
 * Reads are graceful: discovery is a bounded on-chain swap scan (no subgraph yet —
 * see INTEGRATION_MAP §2/§6.4); each degraded envelope renders a PendingNote, never
 * an error. Writes are gated behind <ConnectGate> and run through useTx, then
 * invalidate the owning query. Framing is load-bearing: payout = min(realized IL,
 * MaxIL) (the CAP); depositor / MM capital is NOT guaranteed. (§6.7)
 */
import { useAccount } from 'wagmi'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { Address } from 'viem'
import {
  inflexionCoreAbi,
  core,
  type ProtectionStatus,
  type DepositorPosition,
  type Degraded,
  type BookResult,
  type WithdrawRequest,
  type InflexionSdk,
  decodeSwapRecord,
} from '@inflexion/sdk'

import { useInflexionSdk } from '@/lib/use-sdk'
import { useTx } from '@/lib/use-tx'
import {
  Section,
  Panel,
  Card,
  Stat,
  Badge,
  Skeleton,
  EmptyState,
  PendingNote,
  ErrorNote,
  ConnectGate,
  TxButton,
  Button,
} from '@/components/ui'
import { fmtUsd, fmtUsdc, fmtDuration } from '@/lib/format'
import {
  ProtectionCard,
  BookRow,
  KV,
  type ClaimableFeesView,
} from '@/components/dashboard/sections'

// How far back the on-chain `swaps` enumeration walks for LP discovery. Bounded —
// full history needs the subgraph (INTEGRATION_MAP §6.4). getBook (MM) walks the
// same range internally.
const SCAN_LIMIT = 400

// getMmCollateral returns `undefined` on a degraded read; React Query rejects an
// `undefined` query value, so normalize the absent case to `null`.
type MmCollateral = { deposited: bigint; locked: bigint; available: bigint } | null

// ─── A discovered LP protection (status + its checkpointed fees) ─────────────
interface LpProtection {
  ps: ProtectionStatus
  fees?: ClaimableFeesView
}

export default function DashboardPage() {
  return (
    <Section kicker="Portfolio" title="Dashboard">
      <ConnectGate message="Connect a wallet on Arbitrum Sepolia to see your protections, deposits, and MM book.">
        <DashboardBody />
      </ConnectGate>
    </Section>
  )
}

function DashboardBody() {
  const { address } = useAccount()
  const sdk = useInflexionSdk()
  const qc = useQueryClient()
  const owner = address as Address | undefined

  // ── (1) PROTECTIONS (LP): bounded on-chain swap scan → getProtectionStatus ──
  const protectionsQ = useQuery<LpProtection[]>({
    queryKey: ['dashboard', 'lp-protections', sdk.chainId, owner],
    enabled: !!owner,
    queryFn: async (): Promise<LpProtection[]> => {
      if (!owner) return []
      // nextSwapId bounds the scan; swap ids are 1-indexed.
      const next = (await sdk.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'nextSwapId',
        args: [],
      })) as bigint
      const last = next > 0n ? next - 1n : 0n
      const lo = last > BigInt(SCAN_LIMIT) ? last - BigInt(SCAN_LIMIT) + 1n : 1n

      const out: LpProtection[] = []
      const ownerLc = owner.toLowerCase()
      for (let id = last; id >= lo && id >= 1n; id--) {
        // Cheap pre-filter: raw swaps(id) → decode → match lp + non-zero status,
        // BEFORE the expensive enriched getProtectionStatus (oracle + settlePreview).
        let lpAddr: string
        let status: number
        try {
          const t = (await sdk.publicClient.readContract({
            address: core.inflexionCore,
            abi: inflexionCoreAbi,
            functionName: 'swaps',
            args: [id],
          })) as Parameters<typeof decodeSwapRecord>[0]
          const rec = decodeSwapRecord(t)
          lpAddr = rec.lp.toLowerCase()
          status = rec.status
        } catch {
          continue // unreadable id → skip rather than fail the whole scan
        }
        if (status === 0 || lpAddr !== ownerLc) continue

        const ps = await sdk.lp.getProtectionStatus(id)
        if ('available' in ps) continue // { available: false } envelope → skip
        let fees: ClaimableFeesView | undefined
        const cf = await sdk.lp.getClaimableFees(id)
        if (!('available' in cf)) fees = { fee0: cf.fee0, fee1: cf.fee1 }
        out.push({ ps, fees })
      }
      return out
    },
  })

  // ── (2) DEPOSITS (depositor): getPosition ──────────────────────────────────
  const positionQ = useQuery<Degraded<DepositorPosition>>({
    queryKey: ['dashboard', 'depositor-position', sdk.chainId, owner],
    enabled: !!owner,
    queryFn: () => sdk.depositor.getPosition(owner as Address),
  })

  // ── (3) MM BOOK: getBook + getMmCollateral ─────────────────────────────────
  const bookQ = useQuery<BookResult>({
    queryKey: ['dashboard', 'mm-book', sdk.chainId, owner],
    enabled: !!owner,
    queryFn: () => sdk.mm.getBook(owner as Address, { fromSwapId: 1n }),
  })
  const collateralQ = useQuery<MmCollateral>({
    queryKey: ['dashboard', 'mm-collateral', sdk.chainId, owner],
    enabled: !!owner,
    queryFn: async () => (await sdk.mm.getMmCollateral(owner as Address)) ?? null,
  })

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  return (
    <div className="space-y-12">
      <ProtectionsSection q={protectionsQ} onSettled={invalidateAll} sdk={sdk} />
      <DepositsSection q={positionQ} onWrote={invalidateAll} sdk={sdk} />
      <MmBookSection bookQ={bookQ} collateralQ={collateralQ} />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// (1) PROTECTIONS (LP)
// ════════════════════════════════════════════════════════════════════════════
function ProtectionsSection({
  q,
  onSettled,
  sdk,
}: {
  q: UseQueryResult<LpProtection[]>
  onSettled: () => void
  sdk: InflexionSdk
}) {
  return (
    <div>
      <SectionHead
        title="Protections"
        kicker="LP · claim A"
        note="LPs are always paid — no bad debt in FULL (capped payout + solvent USDC + oracle/settlement liveness). Payout = min(realized IL, MaxIL); the cap is load-bearing."
      />
      <PendingNote>
        Discovered by a bounded on-chain scan of the last {SCAN_LIMIT} swaps. Full position history
        (and exact uncollected fees) goes live with the subgraph; the on-chain scan works now.
      </PendingNote>
      <div className="mt-4 space-y-4">
        {q.isLoading ? (
          <>
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </>
        ) : q.isError ? (
          <ErrorNote>Could not scan swaps: {(q.error as Error).message}</ErrorNote>
        ) : !q.data || q.data.length === 0 ? (
          <EmptyState
            title="No protections found"
            desc="You have no in-range IL protection in the scanned range. Buy protection on the Protect page."
          />
        ) : (
          q.data.map((p) => (
            <SettleableProtection
              key={p.ps.swapId.toString()}
              p={p}
              onSettled={onSettled}
              sdk={sdk}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** One protection card with its own settle tx state (each row settles independently). */
function SettleableProtection({
  p,
  onSettled,
  sdk,
}: {
  p: LpProtection
  onSettled: () => void
  sdk: InflexionSdk
}) {
  const tx = useTx()
  return (
    <ProtectionCard
      ps={p.ps}
      {...(p.fees ? { fees: p.fees } : {})}
      settleStatus={tx.status}
      {...(tx.error ? { settleError: tx.error } : {})}
      onSettle={async () => {
        const h = await tx.run(() => sdk.lp.settle(p.ps.swapId))
        if (h) onSettled()
      }}
    />
  )
}

// ════════════════════════════════════════════════════════════════════════════
// (2) DEPOSITS (depositor)
// ════════════════════════════════════════════════════════════════════════════
function DepositsSection({
  q,
  onWrote,
  sdk,
}: {
  q: UseQueryResult<Degraded<DepositorPosition>>
  onWrote: () => void
  sdk: InflexionSdk
}) {
  const data = q.data
  const hasPosition =
    data !== undefined && data.available && (data.seniorShares > 0n || data.juniorShares > 0n)

  return (
    <div>
      <SectionHead
        title="Deposits"
        kicker="Depositor · claim B"
        note="You underwrite pooled in-range IL via the dual-tranche cvAMM vault. Capital is NOT guaranteed — junior is first-loss; senior is protected from underwriting loss only, not the systemic tail."
      />
      <div className="mt-4">
        {q.isLoading ? (
          <Skeleton className="h-44" />
        ) : q.isError ? (
          <ErrorNote>Could not read your vault position: {(q.error as Error).message}</ErrorNote>
        ) : data === undefined || !data.available ? (
          <PendingNote>
            Vault position unavailable
            {data !== undefined && !data.available ? ` (${data.reason})` : ''}. The on-chain reads
            are live — retry once the RPC / vault is reachable.
          </PendingNote>
        ) : !hasPosition ? (
          <EmptyState
            title="No vault deposits"
            desc="Deposit into the senior or junior tranche on the Earn page to start underwriting."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <TrancheCard
              tranche="senior"
              label="Senior"
              shares={data.seniorShares}
              assets={data.seniorAssets}
              withdraw={data.seniorWithdraw}
              onWrote={onWrote}
              sdk={sdk}
            />
            <TrancheCard
              tranche="junior"
              label="Junior · first-loss"
              shares={data.juniorShares}
              assets={data.juniorAssets}
              withdraw={data.juniorWithdraw}
              onWrote={onWrote}
              sdk={sdk}
              firstLoss
            />
          </div>
        )}
      </div>
    </div>
  )
}

function TrancheCard({
  tranche,
  label,
  shares,
  assets,
  withdraw,
  onWrote,
  sdk,
  firstLoss,
}: {
  tranche: 'senior' | 'junior'
  label: string
  shares: bigint
  assets: bigint
  withdraw?: WithdrawRequest
  onWrote: () => void
  sdk: InflexionSdk
  firstLoss?: boolean
}) {
  const reqTx = useTx()
  const wdTx = useTx()
  const empty = shares === 0n && (!withdraw || withdraw.shares === 0n)
  const matured = withdraw !== undefined && withdraw.shares > 0n && withdraw.secondsRemaining === 0n

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="font-display text-h4 text-fg">{label}</span>
        {firstLoss && <Badge tone="warn">FIRST-LOSS</Badge>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Stat label="Your NAV" value={fmtUsd(assets)} accent="teal" />
        <Stat label="Shares" value={fmtUsdc(shares)} />
      </div>

      {withdraw !== undefined && withdraw.shares > 0n && (
        <div className="mt-4 rounded-md border border-line-subtle bg-base px-4 py-3">
          <KV label="Withdrawal queued (shares)">{fmtUsdc(withdraw.shares)}</KV>
          <KV label={matured ? 'Status' : 'Unlocks in'}>
            {matured ? 'matured — claimable' : fmtDuration(withdraw.secondsRemaining)}
          </KV>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {/* requestWithdrawal — queue the full balance (cooldown-gated on-chain). */}
        {shares > 0n && (
          <TxButton
            status={reqTx.status}
            variant="ghost"
            onClick={async () => {
              const h = await reqTx.run(() => sdk.depositor.requestWithdrawal(tranche, shares))
              if (h) onWrote()
            }}
          >
            Request withdrawal
          </TxButton>
        )}
        {/* withdraw — claim a matured request (vault reverts JuniorBelowLocked if unsafe). */}
        {withdraw !== undefined && withdraw.shares > 0n && (
          <TxButton
            status={wdTx.status}
            disabled={!matured}
            onClick={async () => {
              const h = await wdTx.run(() => sdk.depositor.withdraw(tranche))
              if (h) onWrote()
            }}
          >
            {matured ? 'Withdraw' : 'Withdraw (after cooldown)'}
          </TxButton>
        )}
        {empty && (
          <Button variant="ghost" disabled>
            No {tranche} balance
          </Button>
        )}
      </div>

      {reqTx.error && (
        <div className="mt-3">
          <ErrorNote>{reqTx.error}</ErrorNote>
        </div>
      )}
      {wdTx.error && (
        <div className="mt-3">
          <ErrorNote>{wdTx.error}</ErrorNote>
        </div>
      )}
    </Card>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// (3) MM BOOK
// ════════════════════════════════════════════════════════════════════════════
function MmBookSection({
  bookQ,
  collateralQ,
}: {
  bookQ: UseQueryResult<BookResult>
  collateralQ: UseQueryResult<MmCollateral>
}) {
  const book = bookQ.data
  const collateral = collateralQ.data

  return (
    <div>
      <SectionHead
        title="MM Book"
        kicker="Market maker · claim B"
        note="Active swaps you underwrite (Path B) + your collateral usage. MM capital is NOT guaranteed — you are short the capped IL claim and post collateral == MaxIL per fill."
      />

      {/* Collateral (UnderwriterVault) */}
      <div className="mt-4">
        {collateralQ.isLoading ? (
          <Skeleton className="h-24" />
        ) : collateral === undefined || collateral === null ? (
          <PendingNote>
            No collateral record found in the UnderwriterVault for this address (or the read
            degraded). Deposit MM collateral to quote Path B.
          </PendingNote>
        ) : (
          <Card>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Deposited" value={fmtUsd(collateral.deposited)} />
              <Stat
                label="Locked"
                value={fmtUsd(collateral.locked)}
                accent="warn"
                sub="I5: locked ≤ deposited"
              />
              <Stat label="Available" value={fmtUsd(collateral.available)} accent="teal" />
            </div>
          </Card>
        )}
      </div>

      {/* Active book */}
      <div className="mt-4">
        {bookQ.isLoading ? (
          <Skeleton className="h-40" />
        ) : bookQ.isError ? (
          <ErrorNote>Could not read your book: {(bookQ.error as Error).message}</ErrorNote>
        ) : book === undefined || !book.available ? (
          <PendingNote>
            Book unavailable{book !== undefined && !book.available ? ` (${book.reason})` : ''}.
            Precise fill attribution (QuoteFilled) needs the subgraph; the active-swap scan works
            now.
          </PendingNote>
        ) : book.positions.length === 0 ? (
          <EmptyState
            title="No active fills"
            desc="You are not underwriting any active swaps in the scanned range. Sign quotes on the Underwrite page to get filled."
          />
        ) : (
          <Panel
            title={`Active fills · ${book.count}`}
            right={
              <span className="text-body-sm text-fg-tertiary">
                exposure V0 <span className="num text-fg-secondary">{fmtUsd(book.exposureV0)}</span>{' '}
                · MaxIL <span className="num text-warn-400">{fmtUsd(book.exposureMaxIL)}</span>
              </span>
            }
          >
            <div className="-mx-5 -my-5">
              {book.positions.map((pos) => (
                <BookRow key={pos.swapId.toString()} pos={pos} />
              ))}
            </div>
            {/* Coarse fill attribution note (INTEGRATION_MAP §6.5). */}
            <p className="mt-4 px-1 text-body-sm text-fg-disabled">
              Fill to quote attribution is coarse on-chain (cancel and fill share a nonce bit);
              precise per-quote attribution arrives with the QuoteFilled-indexing subgraph. Cancel
              outstanding quote nonces from the Underwrite page.
            </p>
          </Panel>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// shared section header
// ════════════════════════════════════════════════════════════════════════════
function SectionHead({ title, kicker, note }: { title: string; kicker: string; note: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-h2 font-bold text-fg">{title}</h2>
        <span className="text-label uppercase text-accent-400">{kicker}</span>
      </div>
      <p className="mt-2 max-w-3xl text-body-sm text-fg-tertiary">{note}</p>
    </div>
  )
}
