'use client'

// /protect — the LP buys IN-RANGE IL protection on a Uniswap v3 position.
//
// Flow: (1) list the owner's eligible v3 positions (listEligiblePositions),
// (2) pick a position + a market (fee × duration), (3) preview the premium
// (previewPremium → best of {Path A pool, Path B MM}), (4) see the payoff-with-cap
// chart, (5) buy (buyProtection, approvals handled by the SDK), (6) manage active
// protections (getProtectionStatus + settle on expiry).
//
// Framing (load-bearing): payout = min(realized IL, MaxIL). The CAP is what makes
// "no bad debt in FULL" hold. Entry requires Pa ≤ P0 ≤ Pb — out-of-range positions
// are rejected at creation. Every payout-bearing read carries noBadDebtFull (qualified).
import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInflexionSdk } from '@/lib/use-sdk'
import { useTx } from '@/lib/use-tx'
import { fmtUsd, fmtWadPct, fmtDuration, fmtCompact } from '@/lib/format'
import { MARKETS, DEMO_MARKET_ID, findMarket } from '@/lib/markets'
import { pairLabel, DEMO_PAIR } from '@/lib/tokens'
import {
  Badge,
  Button,
  ConnectGate,
  EmptyState,
  ErrorNote,
  Field,
  PendingNote,
  Skeleton,
  Stat,
} from '@/components/ui'
import {
  PageShell,
  PageHeader,
  FramedPanel,
  Reveal,
  ShimmerTxButton,
} from '@/components/app/chrome'
import { PayoffChart } from '@/components/charts/payoff-chart'
import { ActiveProtection } from '@/components/protect/active-protection'
import {
  core,
  inflexionCoreAbi,
  sqrtToPriceWad,
  positionV0,
  withSlippage,
  type EligiblePosition,
  type LpGeometry,
  type NotPriceable,
} from '@inflexion/sdk'

const SLIPPAGE_BPS = 100 // 1% buffer over the previewed best premium → maxPremium

// The two market axes the user can pick (derived from the canonical MARKETS list).
const FEES = Array.from(new Map(MARKETS.map((m) => [m.fee, m.feeLabel])).entries()) // [fee, label]
const DURATIONS = Array.from(
  new Map(MARKETS.map((m) => [m.durationSeconds, m.durationLabel])).entries(),
) // [seconds, label]

const DEMO_MARKET = MARKETS.find((m) => m.marketId.toLowerCase() === DEMO_MARKET_ID.toLowerCase())

// sqrtPriceX96 → a plain price number (token1/token0, raw decimals). Only the
// RATIOS Pa:P0:Pb matter to PayoffChart (it normalizes by V0), so consistent
// units across the three are sufficient.
function priceNum(sqrtPX96: bigint): number {
  return Number(sqrtToPriceWad(sqrtPX96)) / 1e18
}

// A Uniswap v3 position has exactly ONE intrinsic fee tier (its pool). Recover it
// from the resolved geometry when priceable; otherwise fall back to the position's
// marketId pre-image (every demo market id is in the canonical MARKETS list). The
// fee tier is therefore a PROPERTY of the position — used to filter the list, never
// an independent axis the user can mismatch the position against.
function feeOfPosition(p: EligiblePosition): number | undefined {
  if (p.geometry.priceable) return p.geometry.geometry.fee
  return findMarket(p.marketId)?.fee
}

// Honest, reason-specific copy for a NotPriceable preview. Only `oracle-degraded`
// is an actual oracle outage — the previous UI blamed the oracle for EVERY reason.
function notPriceableMessage(np: NotPriceable): string {
  switch (np.reason) {
    case 'oracle-degraded':
      return 'Not priceable right now — the live oracle reverted (stale feed / sequencer down). The position still exists and becomes quotable once the oracle recovers.'
    case 'market-unknown':
      return 'No market is registered for this fee tier and duration, so this position cannot be quoted here.'
    case 'position-unknown':
      return 'This position is not quotable on the selected market right now — its pool fee tier does not match, or it has moved out of range.'
    default:
      return `Not priceable right now (${np.reason}).`
  }
}

export default function ProtectPage() {
  return (
    <PageShell>
      <PageHeader title="Protect">
        Pay a fixed premium to hedge the <strong className="text-fg">in-range</strong> impermanent
        loss of a Uniswap v3 position. You&apos;re paid your realized IL at expiry — capped at{' '}
        <strong className="text-fg">MaxIL</strong>.
      </PageHeader>
      <div className="mt-8">
        <ConnectGate message="Connect a wallet on Arbitrum Sepolia to view your positions and buy protection.">
          <ProtectFlow />
        </ConnectGate>
      </div>
    </PageShell>
  )
}

function ProtectFlow() {
  const sdk = useInflexionSdk()
  const { address } = useAccount()
  const tx = useTx()
  const qc = useQueryClient()

  // Duration is a real user choice; the FEE TIER is a property of the chosen
  // position (its pool), used to filter the list. Default to the demo 7d/fee-500 market.
  const [fee, setFee] = useState<number>(DEMO_MARKET?.fee ?? 500)
  const [durationSeconds, setDurationSeconds] = useState<number>(
    DEMO_MARKET?.durationSeconds ?? 7 * 86_400,
  )
  const [selectedTokenId, setSelectedTokenId] = useState<bigint | undefined>(undefined)

  // (1) Eligible positions for the connected owner, scoped to the selected duration.
  const eligibleQ = useQuery({
    queryKey: ['eligiblePositions', address, durationSeconds, sdk.chainId],
    queryFn: () => sdk.lp.listEligiblePositions(address!, { durations: [durationSeconds] }),
    enabled: !!address,
  })

  const positions = useMemo(() => eligibleQ.data ?? [], [eligibleQ.data])

  // Which fee tiers the owner actually holds positions in (for this duration).
  const presentFees = useMemo(() => {
    const s = new Set<number>()
    for (const p of positions) {
      const f = feeOfPosition(p)
      if (f !== undefined) s.add(f)
    }
    return s
  }, [positions])

  // Keep the selected fee tier valid: snap to the lowest tier that has positions.
  useEffect(() => {
    if (presentFees.size > 0 && !presentFees.has(fee)) {
      const first = [...presentFees].sort((a, b) => a - b)[0]
      if (first !== undefined) setFee(first)
    }
  }, [presentFees, fee])

  // Positions shown = those in the selected tier (fall back to all if fee unresolved).
  const visiblePositions = useMemo(
    () => (presentFees.size === 0 ? positions : positions.filter((p) => feeOfPosition(p) === fee)),
    [positions, presentFees, fee],
  )

  const selected =
    visiblePositions.find((p) => p.tokenId === selectedTokenId) ?? visiblePositions[0]
  const effectiveTokenId = selected?.tokenId
  const selectedGeometry: LpGeometry | undefined =
    selected && selected.geometry.priceable ? selected.geometry.geometry : undefined
  // Preview/buy on the SELECTED POSITION'S OWN market (its fee × the chosen duration).
  const activeMarketId = selected?.marketId
  const activeMarket = activeMarketId ? findMarket(activeMarketId) : undefined
  const labelMarket =
    activeMarket ?? MARKETS.find((m) => m.fee === fee && m.durationSeconds === durationSeconds)

  // (2) Premium preview for the selected position (best of {Path A pool, Path B MM}).
  const previewQ = useQuery({
    queryKey: ['previewPremium', effectiveTokenId?.toString(), activeMarketId, sdk.chainId],
    queryFn: () => sdk.lp.previewPremium(effectiveTokenId!, activeMarketId!),
    enabled: effectiveTokenId !== undefined && activeMarketId !== undefined,
    refetchInterval: 30_000,
  })
  const preview = previewQ.data
  const hasSelection = effectiveTokenId !== undefined && activeMarketId !== undefined

  const onBuy = async () => {
    if (
      !preview ||
      !preview.priceable ||
      effectiveTokenId === undefined ||
      activeMarketId === undefined
    )
      return
    const maxPremium = withSlippage(preview.best, SLIPPAGE_BPS)
    const hash = await tx.run(() =>
      sdk.lp.buyProtection({
        tokenId: effectiveTokenId,
        marketId: activeMarketId,
        maxPremium,
        approve: true,
      }),
    )
    if (hash) {
      qc.invalidateQueries({ queryKey: ['eligiblePositions'] })
      qc.invalidateQueries({ queryKey: ['ownerSwaps'] })
      previewQ.refetch()
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Row 1: your positions │ premium preview + breakdown — one aligned rectangle ── */}
      <Reveal className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-stretch">
        {/* Left: positions */}
        <FramedPanel title="Your eligible v3 positions" className="h-full">
          <MarketPicker
            fee={fee}
            durationSeconds={durationSeconds}
            presentFees={presentFees}
            onFee={setFee}
            onDuration={setDurationSeconds}
          />
          {labelMarket && (
            <p
              className="mt-3 text-body-sm text-fg-secondary"
              title={`marketId ${labelMarket.marketId}`}
            >
              Market <span className="text-fg">{DEMO_PAIR}</span>
              <span className="text-fg-tertiary">
                {' · '}
                {labelMarket.feeLabel} · {labelMarket.durationLabel}
              </span>
            </p>
          )}
          <div className="mt-4">
            {eligibleQ.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : eligibleQ.isError ? (
              <ErrorNote>Could not read your positions. Check the RPC connection.</ErrorNote>
            ) : positions.length === 0 ? (
              <EmptyState
                title="No eligible positions"
                desc={`No in-range Uniswap v3 positions found for a ${
                  labelMarket?.durationLabel ?? ''
                } market. Out-of-range positions are not protectable — entry requires Pa ≤ P0 ≤ Pb.`}
              />
            ) : visiblePositions.length === 0 ? (
              <EmptyState
                title="No positions in this fee tier"
                desc="You hold eligible positions, but none in the selected fee tier. Pick another tier above."
              />
            ) : (
              <ul className="space-y-2">
                {visiblePositions.map((p) => (
                  <PositionRow
                    key={`${p.tokenId}-${p.marketId}`}
                    position={p}
                    selected={p.tokenId === effectiveTokenId}
                    onSelect={() => setSelectedTokenId(p.tokenId)}
                  />
                ))}
              </ul>
            )}
          </div>
        </FramedPanel>

        {/* Right: premium preview + breakdown — fills the row height to align with the left */}
        <div className="flex h-full flex-col gap-6">
          {!hasSelection ? (
            <FramedPanel title="Premium preview" className="flex-1">
              <EmptyState
                title="Select a position"
                desc="Pick an eligible position on the left to preview its premium and payoff."
              />
            </FramedPanel>
          ) : previewQ.isLoading || !preview ? (
            <FramedPanel title="Premium preview" className="flex-1">
              {previewQ.isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-2/3" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : (
                <Skeleton className="h-20 w-full" />
              )}
            </FramedPanel>
          ) : !preview.priceable ? (
            <FramedPanel title="Premium preview" className="flex-1">
              <PendingNote>{notPriceableMessage(preview)}</PendingNote>
            </FramedPanel>
          ) : (
            <>
              <FramedPanel
                title="Premium preview"
                right={
                  <Badge tone={preview.path === 'B' ? 'mm' : 'teal'}>Path {preview.path}</Badge>
                }
              >
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <div className="text-label uppercase text-fg-tertiary">Premium (best)</div>
                    <div className="num mt-1 text-mono-stat text-accent-400">
                      {fmtUsd(preview.best)}
                    </div>
                    <div className="mt-1 text-body-sm text-fg-tertiary">
                      pay once · {preview.path === 'B' ? 'MM quote' : 'pool'}
                    </div>
                  </div>
                  <div>
                    <div className="text-label uppercase text-fg-tertiary">MaxIL (cap)</div>
                    <div className="num mt-1 text-mono-stat text-warn-400">
                      {fmtUsd(preview.maxIL)}
                    </div>
                    <div className="mt-1 text-body-sm text-fg-tertiary">your payout ceiling</div>
                  </div>
                </div>
              </FramedPanel>

              {/* Buy — directly under the premium preview (no separate card). */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <ShimmerTxButton status={tx.status} onClick={onBuy} disabled={!preview.priceable}>
                    Buy protection · {fmtUsd(preview.best)}
                  </ShimmerTxButton>
                  {tx.status === 'success' && (
                    <Badge tone="teal">Protected — see status below</Badge>
                  )}
                </div>
                <p className="text-body-sm text-fg-tertiary">
                  Covers in-range IL up to{' '}
                  <span className="text-fg-secondary">{fmtUsd(preview.maxIL)}</span> for{' '}
                  {fmtDuration(activeMarket?.durationSeconds ?? 0)} · max{' '}
                  <span className="num">{fmtUsd(withSlippage(preview.best, SLIPPAGE_BPS))}</span> (
                  {SLIPPAGE_BPS / 100}% slippage) · NFT + dUSDC auto-approved.
                </p>
                {tx.error && <ErrorNote>{tx.error}</ErrorNote>}
              </div>

              <FramedPanel title="Breakdown" className="flex-1">
                <div className="grid grid-cols-2 gap-4">
                  <Stat label="Path A · pool" value={fmtUsd(preview.premiumA)} />
                  <Stat
                    label="Path B · MM"
                    value={preview.premiumB !== undefined ? fmtUsd(preview.premiumB) : '—'}
                    sub={preview.premiumB === undefined ? 'no live MM quote' : undefined}
                  />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line-subtle pt-4">
                  <Stat label="Fair premium" value={fmtUsd(preview.fairPremium)} />
                  <Stat label="σ_ref" value={fmtWadPct(preview.sigmaRefWad)} sub="annualised vol" />
                </div>
              </FramedPanel>
            </>
          )}
        </div>
      </Reveal>

      {/* ── Row 2: payoff chart — full-width horizontal banner with the animated cursor ── */}
      {hasSelection && (
        <Reveal>
          <FramedPanel title="Payoff with cap">
            {selectedGeometry ? (
              <>
                <PayoffChart
                  className="w-full"
                  geometry={{
                    pa: priceNum(selectedGeometry.sqrtPaX96),
                    p0: priceNum(selectedGeometry.sqrtP0X96),
                    pb: priceNum(selectedGeometry.sqrtPbX96),
                  }}
                />
                <p className="mt-3 max-w-3xl text-body-sm text-fg-tertiary">
                  Hover the chart to read coverage at any price.{' '}
                  <strong className="text-accent-400">Teal — covered:</strong> your realized IL is
                  paid in full (at or below MaxIL).{' '}
                  <strong className="text-loss">Red — capped:</strong> the IL has risen above the
                  amber MaxIL line, so your payout is <strong className="text-fg">capped</strong>{' '}
                  and the excess is uncovered — the cap that makes the no-bad-debt guarantee hold.
                </p>
              </>
            ) : (
              <PendingNote>
                Geometry unavailable (oracle degraded) — the chart needs the live entry price P0.
              </PendingNote>
            )}
          </FramedPanel>
        </Reveal>
      )}

      {/* ── Active protections ── */}
      <Reveal>
        <ActiveProtections owner={address!} />
      </Reveal>
    </div>
  )
}

// ─── Market picker ──────────────────────────────────────────────────────────
function MarketPicker({
  fee,
  durationSeconds,
  presentFees,
  onFee,
  onDuration,
}: {
  fee: number
  durationSeconds: number
  /** Fee tiers the owner actually holds positions in; others are disabled. */
  presentFees: Set<number>
  onFee: (f: number) => void
  onDuration: (d: number) => void
}) {
  // Only gate once positions have loaded (non-empty set); during loading leave every
  // tier enabled so the picker doesn't flash fully-disabled.
  const gate = presentFees.size > 0
  return (
    <div className="grid grid-cols-2 gap-4">
      <Field label="Fee tier" hint="Matches the pool your position is in">
        <div className="flex gap-2">
          {FEES.map(([f, label]) => {
            const absent = gate && !presentFees.has(f)
            return (
              <Button
                key={f}
                variant={f === fee ? 'primary' : 'ghost'}
                className="flex-1 px-2 py-2 text-body-sm"
                disabled={absent}
                title={absent ? 'No positions in this fee tier' : undefined}
                onClick={() => onFee(f)}
              >
                {label}
              </Button>
            )
          })}
        </div>
      </Field>
      <Field label="Duration">
        <div className="flex gap-2">
          {DURATIONS.map(([s, label]) => (
            <Button
              key={s}
              variant={s === durationSeconds ? 'primary' : 'ghost'}
              className="flex-1 px-2 py-2 text-body-sm"
              onClick={() => onDuration(s)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Field>
    </div>
  )
}

// ─── Position row ───────────────────────────────────────────────────────────
function PositionRow({
  position,
  selected,
  onSelect,
}: {
  position: EligiblePosition
  selected: boolean
  onSelect: () => void
}) {
  const g = position.geometry
  const pair = g.priceable ? pairLabel(g.geometry.token0, g.geometry.token1) : DEMO_PAIR

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={
          'w-full rounded-md border px-4 py-3 text-left transition-colors ' +
          (selected ? 'border-accent-700 bg-accent/5' : 'border-line hover:border-fg-tertiary')
        }
      >
        <div className="flex items-center justify-between">
          <span className="text-fg">
            <span className="font-medium">{pair}</span>
            <span
              className="num ml-2 text-body-sm text-fg-tertiary"
              title="Uniswap v3 position NFT id"
            >
              #{position.tokenId.toString()}
            </span>
          </span>
          <Badge tone={position.inRange ? 'teal' : 'warn'}>
            {position.inRange === true
              ? 'in range'
              : position.inRange === false
                ? 'out of range'
                : 'oracle degraded'}
          </Badge>
        </div>
        {g.priceable ? (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-fg-tertiary">
            <span title="Position value at the current oracle price, in dUSDC (the numéraire)">
              Value <span className="num text-fg-secondary">{fmtUsd(positionV0(g.geometry))}</span>
            </span>
            <span title="Maximum impermanent loss covered — your payout is capped here (the no-bad-debt cap)">
              MaxIL <span className="num text-warn-400">{fmtUsd(g.geometry.maxIL)}</span>
            </span>
            <span
              title={`Uniswap v3 liquidity (L) — immutable, stored at position creation. Raw: ${g.geometry.liquidity.toString()}`}
            >
              Liquidity{' '}
              <span className="num text-fg-tertiary">{fmtCompact(g.geometry.liquidity)}</span>
            </span>
          </div>
        ) : (
          <div className="mt-1.5 text-body-sm text-fg-tertiary">
            {g.reason} · not priceable right now
          </div>
        )}
      </button>
    </li>
  )
}

// ─── Active protections (owner discovery via on-chain swap scan) ────────────
function ActiveProtections({ owner }: { owner: `0x${string}` }) {
  const sdk = useInflexionSdk()

  // No subgraph yet → discover the owner's swaps by scanning nextSwapId and
  // filtering getProtectionStatus.lp to the connected owner (the SDK's own
  // discovery pattern; coarse but live).
  const swapsQ = useQuery({
    queryKey: ['ownerSwaps', owner, sdk.chainId],
    queryFn: async () => {
      const next = (await sdk.publicClient.readContract({
        address: core.inflexionCore,
        abi: inflexionCoreAbi,
        functionName: 'nextSwapId',
        args: [],
      })) as bigint
      const limit = next < 200n ? next : 200n
      const ids: bigint[] = []
      for (let id = 1n; id <= limit; id++) {
        const st = await sdk.lp.getProtectionStatus(id)
        if ('available' in st) continue
        if (st.lp.toLowerCase() === owner.toLowerCase()) ids.push(id)
      }
      return ids
    },
    enabled: !!owner,
  })

  const ids = swapsQ.data ?? []

  return (
    <FramedPanel
      title="Your active protections"
      right={
        <span className="text-body-sm text-fg-tertiary">
          LPs are always paid in FULL mode (no bad debt — qualified)
        </span>
      }
    >
      {swapsQ.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : ids.length === 0 ? (
        <EmptyState
          title="No protections yet"
          desc="Buy protection above and it will appear here with live IL-to-date and a Settle button once it expires."
        />
      ) : (
        <div className="space-y-4">
          {ids.map((id) => (
            <ActiveProtection key={id.toString()} swapId={id} />
          ))}
        </div>
      )}
    </FramedPanel>
  )
}
