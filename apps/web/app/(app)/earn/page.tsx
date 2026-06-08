'use client'

// /earn — the depositor surface. Underwrite in-range IL through the dual-tranche
// ConvexityVault (Path-A pooled cvAMM underwriter). SENIOR (low-variance,
// underwriting-loss-protected) vs JUNIOR (first-loss, captures most premium).
//
// Wired to REAL on-chain SDK calls (DepositorClient over the live ConvexityVault):
//   reads  → getVaultState (carries regime + tranche sizes + load stack),
//            getPosition, getWithdrawalCooldown
//   writes → deposit(tranche, amount, {autoApprove}), requestWithdrawal, withdraw
//   pending→ data.getNavHistory (subgraph/API not wired → ApiPending)
//
// CLAIM (B), surfaced prominently (NOT a footnote): depositor capital is NOT
// guaranteed. Junior is first-loss; senior is structurally protected from
// underwriting loss only (the junior-first waterfall), not the systemic tail.
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInflexionSdk } from '@/lib/use-sdk'
import { useTx } from '@/lib/use-tx'
import { formatUnits } from 'viem'
import { fmtUsd, fmtUsdc, fmtWadPct, fmtWad, fmtDuration, parseUsdc } from '@/lib/format'
import {
  Section,
  Panel,
  Card,
  Stat,
  Field,
  AmountInput,
  Button,
  TxButton,
  Badge,
  Skeleton,
  EmptyState,
  PendingNote,
  ErrorNote,
  ConnectGate,
} from '@/components/ui'
import type { Tranche } from '@inflexion/sdk'

// Result types pulled straight off the real SDK method signatures (no hand-typing).
type Sdk = ReturnType<typeof useInflexionSdk>
type VaultStateResult = Awaited<ReturnType<Sdk['depositor']['getVaultState']>>
type PositionResult = Awaited<ReturnType<Sdk['depositor']['getPosition']>>
type NavHistoryResult = Awaited<ReturnType<Sdk['data']['getNavHistory']>>
type PositionOk = Extract<PositionResult, { available: true }>

// ─── Tranche descriptors (copy is load-bearing: senior vs junior risk split) ────

const TRANCHE_META: Record<
  Tranche,
  { name: string; role: string; risk: string; tone: 'teal' | 'warn' }
> = {
  senior: {
    name: 'Senior',
    role: 'Low-variance · underwriting-loss-protected',
    risk: 'Protected by the junior-first waterfall (totalLocked ≤ juniorAssets) from underwriting loss only — NOT from a systemic tail (USDC depeg, oracle/settlement failure, contract bug).',
    tone: 'teal',
  },
  junior: {
    name: 'Junior',
    role: 'First-loss · captures most of the premium',
    risk: 'First-loss capital. Absorbs underwriting losses before senior is ever touched, in exchange for most of the premium yield. Withdrawals can revert (JuniorBelowLocked) while collateral is locked.',
    tone: 'warn',
  },
}

const REGIME_TONE: Record<string, 'teal' | 'warn' | 'loss'> = {
  calm: 'teal',
  normal: 'warn',
  stressed: 'loss',
}

export default function EarnPage() {
  const sdk = useInflexionSdk()
  const { address } = useAccount()
  const qc = useQueryClient()

  // ─── READS ────────────────────────────────────────────────────────────────

  const vaultQ = useQuery({
    queryKey: ['earn', 'vaultState'],
    queryFn: () => sdk.depositor.getVaultState(),
    refetchInterval: 20_000,
  })

  const positionQ = useQuery({
    queryKey: ['earn', 'position', address],
    queryFn: () => sdk.depositor.getPosition(address!),
    enabled: !!address,
  })

  const cooldownQ = useQuery({
    queryKey: ['earn', 'cooldown'],
    queryFn: () => sdk.depositor.getWithdrawalCooldown(),
  })

  // NAV history is subgraph/API-backed → always ApiPending today. Render pending.
  const navHistoryQ = useQuery({
    queryKey: ['earn', 'navHistory'],
    queryFn: () => sdk.data.getNavHistory({ bucket: '1d' }),
  })

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['earn', 'vaultState'] })
    qc.invalidateQueries({ queryKey: ['earn', 'position'] })
  }

  const vault = vaultQ.data
  const position = positionQ.data
  const cooldown = cooldownQ.data

  return (
    <Section kicker="Earn" title="Underwrite in-range IL">
      {/* ─── CAPITAL NOT GUARANTEED — prominent, not a footnote ─────────────── */}
      <CapitalNotGuaranteed
        available={vault?.available === true ? vault.capitalNotGuaranteed : true}
      />

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* ── Left/center: vault state + tranches ── */}
        <div className="space-y-6 lg:col-span-2">
          <VaultOverview data={vault} isLoading={vaultQ.isLoading} />
          <TrancheSplit data={vault} isLoading={vaultQ.isLoading} />
          <NavHistory data={navHistoryQ.data} isLoading={navHistoryQ.isLoading} />
        </div>

        {/* ── Right rail: my position + deposit/withdraw ── */}
        <div className="space-y-6">
          <MyPosition data={position} isLoading={positionQ.isLoading} hasAddress={!!address} />
          <DepositPanel onSuccess={invalidateAll} />
          <WithdrawPanel
            position={position?.available === true ? position : undefined}
            cooldown={cooldown}
            onSuccess={invalidateAll}
          />
        </div>
      </div>
    </Section>
  )
}

// ─── Prominent "capital is NOT guaranteed" disclosure ─────────────────────────

function CapitalNotGuaranteed({ available }: { available: boolean }) {
  return (
    <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 p-5">
      <div className="flex items-center gap-2">
        <Badge tone="warn">Risk</Badge>
        <span className="font-display text-h4 font-bold text-warn-400">
          Capital is NOT guaranteed
        </span>
      </div>
      <p className="mt-3 max-w-3xl text-body-sm text-fg-secondary">
        You are <span className="text-fg">underwriting</span> the in-range impermanent loss of LP
        positions. <span className="text-fg">Junior</span> is first-loss and absorbs underwriting
        losses before <span className="text-fg">senior</span>; senior is structurally protected from
        underwriting loss only (the junior-first waterfall,{' '}
        <span className="num">totalLocked ≤ juniorAssets</span>) — NOT from a systemic tail (USDC
        depeg, oracle/settlement failure, contract bug). This is distinct from the LP-side claim:
        max protocol obligation per position is capped at <span className="text-fg">MaxIL</span>,
        which is why FULL mode produces no bad debt{' '}
        <span className="text-fg-tertiary">for LPs</span> — that guarantee is for the protected LP,
        not for you.
      </p>
      {!available && (
        <p className="mt-2 text-body-sm text-fg-tertiary">
          (Disclosure shown by default while vault state is loading.)
        </p>
      )}
    </div>
  )
}

// ─── Vault overview (pool-wide inventory + regime) ────────────────────────────

function VaultOverview({ data, isLoading }: { data?: VaultStateResult; isLoading: boolean }) {
  return (
    <Panel
      title="Vault — ConvexityVault (Path-A pooled underwriter)"
      right={
        data?.available === true ? (
          <Badge tone={REGIME_TONE[data.regime] ?? 'neutral'}>{data.regime} regime</Badge>
        ) : null
      }
    >
      {isLoading ? (
        <SkeletonStats n={4} />
      ) : data?.available === false ? (
        <PendingNote>
          Vault state unavailable: {data.reason}. The σ_ref / load stack needs an initialized
          VolOracle and a reachable RPC.
        </PendingNote>
      ) : data?.available === true ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat
              label="Total assets"
              value={fmtUsd(data.totalAssets)}
              sub="dUSDC underwriting capital"
            />
            <Stat
              label="Locked"
              value={fmtUsd(data.totalLocked)}
              accent="warn"
              sub="backing open swaps"
            />
            <Stat
              label="Free"
              value={fmtUsd(data.freeAssets)}
              accent="teal"
              sub="open capacity (fungible)"
            />
            <Stat label="Utilization" value={fmtWadPct(data.utilWad)} sub="locked / total" />
          </div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4 border-t border-line-subtle pt-5">
            <Stat label="σ_ref" value={fmtWad(data.sigmaRefWad)} sub="WAD vol ref" />
            <Stat label="Concentration" value={fmtWadPct(data.concWad)} sub="HHI colour" />
            <Stat label="Base load" value={fmtWadPct(data.baseLoadWad)} sub="regime floor" />
            <Stat
              label="Total load"
              value={fmtWadPct(data.totalLoadWad)}
              accent="teal"
              sub="price-to-beat (I10-clamped)"
            />
          </div>
        </div>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </Panel>
  )
}

// ─── Tranche split (the SENIOR vs JUNIOR risk explainer + sizes) ──────────────

function TrancheSplit({ data, isLoading }: { data?: VaultStateResult; isLoading: boolean }) {
  return (
    <Panel title="Tranches — waterfall: junior absorbs loss first">
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : data?.available === false ? (
        <PendingNote>Tranche sizes unavailable: {data.reason}.</PendingNote>
      ) : data?.available === true ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TrancheCard tranche="senior" assets={data.seniorAssets} totalAssets={data.totalAssets} />
          <TrancheCard tranche="junior" assets={data.juniorAssets} totalAssets={data.totalAssets} />
        </div>
      ) : (
        <Skeleton className="h-44 w-full" />
      )}
    </Panel>
  )
}

function TrancheCard({
  tranche,
  assets,
  totalAssets,
}: {
  tranche: Tranche
  assets: bigint
  totalAssets: bigint
}) {
  const meta = TRANCHE_META[tranche]
  const share = totalAssets > 0n ? Number((assets * 10000n) / totalAssets) / 100 : 0
  return (
    <Card className={tranche === 'junior' ? 'border-warn-500/30' : 'border-accent-700/40'}>
      <div className="flex items-center justify-between">
        <span className="font-display text-h4 font-bold text-fg">{meta.name}</span>
        <Badge tone={meta.tone}>{tranche === 'junior' ? 'First-loss' : 'Protected'}</Badge>
      </div>
      <p className="mt-1 text-label uppercase text-fg-tertiary">{meta.role}</p>
      <div className="mt-4">
        <Stat
          label="Tranche assets"
          value={fmtUsd(assets)}
          sub={`${share.toFixed(1)}% of vault`}
          accent={meta.tone}
        />
      </div>
      <p className="mt-4 text-body-sm text-fg-tertiary">{meta.risk}</p>
    </Card>
  )
}

// ─── My position (senior + junior shares / NAV-converted assets) ──────────────

function MyPosition({
  data,
  isLoading,
  hasAddress,
}: {
  data?: PositionResult
  isLoading: boolean
  hasAddress: boolean
}) {
  return (
    <Panel title="My position">
      {!hasAddress ? (
        <EmptyState
          title="Not connected"
          desc="Connect a wallet to see your senior + junior position."
        />
      ) : isLoading ? (
        <SkeletonStats n={2} />
      ) : data?.available === false ? (
        <ErrorNote>Could not read your position: {data.reason}</ErrorNote>
      ) : data?.available === true ? (
        data.seniorShares === 0n && data.juniorShares === 0n ? (
          <EmptyState
            title="No position yet"
            desc="Deposit into a tranche below to start underwriting."
          />
        ) : (
          <div className="space-y-4">
            <PositionRow
              tranche="senior"
              shares={data.seniorShares}
              assets={data.seniorAssets}
              withdraw={data.seniorWithdraw}
            />
            <PositionRow
              tranche="junior"
              shares={data.juniorShares}
              assets={data.juniorAssets}
              withdraw={data.juniorWithdraw}
            />
          </div>
        )
      ) : (
        <Skeleton className="h-20 w-full" />
      )}
    </Panel>
  )
}

function PositionRow({
  tranche,
  shares,
  assets,
  withdraw,
}: {
  tranche: Tranche
  shares: bigint
  assets: bigint
  withdraw?: { shares: bigint; unlockAt: bigint; secondsRemaining: bigint }
}) {
  const meta = TRANCHE_META[tranche]
  return (
    <div className="rounded-md border border-line-subtle bg-base p-4">
      <div className="flex items-center justify-between">
        <span className="text-label uppercase text-fg-tertiary">{meta.name}</span>
        <Badge tone={meta.tone}>{tranche === 'junior' ? 'First-loss' : 'Protected'}</Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Stat label="Value (NAV)" value={fmtUsd(assets)} accent={meta.tone} />
        <Stat label="Shares" value={fmtUsdc(shares)} />
      </div>
      {withdraw && (
        <div className="mt-3 rounded-md border border-warn-500/30 bg-warn-500/5 px-3 py-2 text-body-sm text-warn-400">
          Pending withdrawal: {fmtUsdc(withdraw.shares)} shares ·{' '}
          {withdraw.secondsRemaining > 0n
            ? `unlocks in ${fmtDuration(withdraw.secondsRemaining)}`
            : 'ready to withdraw'}
        </div>
      )}
    </div>
  )
}

// ─── Deposit (tranche toggle + amount → deposit autoApprove) ──────────────────

function DepositPanel({ onSuccess }: { onSuccess: () => void }) {
  const sdk = useInflexionSdk()
  const tx = useTx()
  const [tranche, setTranche] = useState<Tranche>('junior')
  const [amount, setAmount] = useState('')
  const meta = TRANCHE_META[tranche]
  const raw = parseUsdc(amount)
  const canSubmit = raw > 0n && !tx.isBusy

  async function submit() {
    const r = await tx.run(() => sdk.depositor.deposit(tranche, raw, { autoApprove: true }))
    if (r) {
      setAmount('')
      onSuccess()
    }
  }

  return (
    <Panel title="Deposit">
      <ConnectGate message="Connect a wallet on Arbitrum Sepolia to deposit underwriting capital.">
        <div className="space-y-4">
          <Field label="Tranche">
            <div className="grid grid-cols-2 gap-2">
              {(['senior', 'junior'] as Tranche[]).map((t) => (
                <Button
                  key={t}
                  variant={tranche === t ? 'primary' : 'ghost'}
                  onClick={() => setTranche(t)}
                  type="button"
                >
                  {TRANCHE_META[t].name}
                </Button>
              ))}
            </div>
          </Field>

          <div className="rounded-md border border-line-subtle bg-base px-3 py-2 text-body-sm text-fg-tertiary">
            {meta.role}. {meta.risk}
          </div>

          <Field label="Amount" hint="Approval is handled automatically (spender: ConvexityVault).">
            <AmountInput
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>

          <TxButton status={tx.status} onClick={submit} disabled={!canSubmit} className="w-full">
            Deposit {meta.name}
          </TxButton>

          {tx.error && <ErrorNote>{tx.error}</ErrorNote>}
          {tx.status === 'success' && (
            <p className="text-body-sm text-accent-400">
              Deposit confirmed. Capital is NOT guaranteed.
            </p>
          )}
        </div>
      </ConnectGate>
    </Panel>
  )
}

// ─── Withdraw (request → cooldown → withdraw; surface JuniorBelowLocked) ───────

function WithdrawPanel({
  position,
  cooldown,
  onSuccess,
}: {
  position?: PositionOk
  cooldown?: bigint
  onSuccess: () => void
}) {
  const sdk = useInflexionSdk()
  const reqTx = useTx()
  const wTx = useTx()
  const [tranche, setTranche] = useState<Tranche>('junior')
  const [shares, setShares] = useState('')

  const sharesRaw = parseUsdc(shares)
  const ownedShares =
    tranche === 'senior' ? (position?.seniorShares ?? 0n) : (position?.juniorShares ?? 0n)
  const pending = tranche === 'senior' ? position?.seniorWithdraw : position?.juniorWithdraw
  const ready = pending !== undefined && pending.secondsRemaining === 0n
  const canRequest = sharesRaw > 0n && sharesRaw <= ownedShares && !reqTx.isBusy

  async function request() {
    const r = await reqTx.run(() => sdk.depositor.requestWithdrawal(tranche, sharesRaw))
    if (r) {
      setShares('')
      onSuccess()
    }
  }

  async function withdraw() {
    const r = await wTx.run(() => sdk.depositor.withdraw(tranche))
    if (r) onSuccess()
  }

  return (
    <Panel title="Withdraw">
      <ConnectGate message="Connect a wallet to manage withdrawals.">
        <div className="space-y-4">
          <Field label="Tranche">
            <div className="grid grid-cols-2 gap-2">
              {(['senior', 'junior'] as Tranche[]).map((t) => (
                <Button
                  key={t}
                  variant={tranche === t ? 'primary' : 'ghost'}
                  onClick={() => setTranche(t)}
                  type="button"
                >
                  {TRANCHE_META[t].name}
                </Button>
              ))}
            </div>
          </Field>

          <p className="text-body-sm text-fg-tertiary">
            Withdrawals are cooldown-gated: <span className="num text-fg">requestWithdrawal</span>{' '}
            then, after{' '}
            <span className="num text-fg">
              {cooldown !== undefined ? fmtDuration(cooldown) : '…'}
            </span>
            , <span className="num text-fg">withdraw</span>. A junior withdraw can revert{' '}
            <span className="text-warn-400">JuniorBelowLocked</span> if it would breach senior
            protection.
          </p>

          {/* Step 1 — request */}
          <Field
            label="Step 1 — request shares"
            hint={`Owned: ${fmtUsdc(ownedShares)} ${tranche} shares`}
          >
            <AmountInput
              suffix="shares"
              placeholder="0.00"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              onMax={() => setShares(formatUnits(ownedShares, 6))}
            />
          </Field>
          <TxButton
            status={reqTx.status}
            onClick={request}
            disabled={!canRequest}
            variant="ghost"
            className="w-full"
          >
            Request withdrawal
          </TxButton>
          {reqTx.error && <ErrorNote>{reqTx.error}</ErrorNote>}

          {/* Pending state */}
          {pending && (
            <div className="rounded-md border border-warn-500/30 bg-warn-500/5 px-3 py-2 text-body-sm text-warn-400">
              Queued: {fmtUsdc(pending.shares)} shares ·{' '}
              {ready ? 'ready now' : `unlocks in ${fmtDuration(pending.secondsRemaining)}`}
            </div>
          )}

          {/* Step 2 — withdraw */}
          <div className="border-t border-line-subtle pt-4">
            <TxButton
              status={wTx.status}
              onClick={withdraw}
              disabled={!ready || wTx.isBusy}
              className="w-full"
            >
              Step 2 — Withdraw {TRANCHE_META[tranche].name}
            </TxButton>
            {!ready && (
              <p className="mt-2 text-body-sm text-fg-tertiary">
                {pending ? 'Cooldown not elapsed yet.' : 'Request a withdrawal first.'}
              </p>
            )}
            {wTx.error && (
              <div className="mt-2">
                <ErrorNote>{wTx.error}</ErrorNote>
              </div>
            )}
            {wTx.status === 'success' && (
              <p className="mt-2 text-body-sm text-accent-400">Withdrawal confirmed.</p>
            )}
          </div>
        </div>
      </ConnectGate>
    </Panel>
  )
}

// ─── NAV history (subgraph/API pending → PendingNote) ─────────────────────────

function NavHistory({ data, isLoading }: { data?: NavHistoryResult; isLoading: boolean }) {
  return (
    <Panel title="Per-tranche NAV history">
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <PendingNote>
          {data?.available === false
            ? `Live once the subgraph + API are deployed (route: ${data.endpoint}). The on-chain deposits / premium accrual / settlements are emitted now; the time-series index is pending.`
            : 'NAV history is subgraph-backed and not yet indexed.'}
        </PendingNote>
      )}
    </Panel>
  )
}

// ─── tiny helpers ─────────────────────────────────────────────────────────────

function SkeletonStats({ n }: { n: number }) {
  return (
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i}>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-6 w-24" />
        </div>
      ))}
    </div>
  )
}
