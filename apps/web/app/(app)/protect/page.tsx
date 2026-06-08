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
import { useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { useInflexionSdk } from '@/lib/use-sdk'
import { useTx } from '@/lib/use-tx'
import { fmtUsd, fmtWadPct, fmtDuration, truncHex } from '@/lib/format'
import { MARKETS, DEMO_MARKET_ID } from '@/lib/markets'
import {
  Badge,
  Button,
  Card,
  ConnectGate,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  PendingNote,
  Section,
  Skeleton,
  Stat,
  TxButton,
} from '@/components/ui'
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

export default function ProtectPage() {
  return (
    <Section kicker="LP · claim A" title="Protect">
      <p className="-mt-3 max-w-2xl text-body-sm text-fg-secondary">
        Pay a fixed upfront premium to transfer the <strong>in-range</strong> impermanent-loss risk
        of a Uniswap v3 position to an underwriter. At expiry you are paid your realized IL — capped
        at <strong>MaxIL</strong>. In FULL mode the protocol cannot produce bad debt under its
        stated assumptions (capped payoff, solvent collateral, oracle &amp; settlement liveness).
      </p>
      <div className="mt-6">
        <ConnectGate message="Connect a wallet on Arbitrum Sepolia to view your positions and buy protection.">
          <ProtectFlow />
        </ConnectGate>
      </div>
    </Section>
  )
}

function ProtectFlow() {
  const sdk = useInflexionSdk()
  const { address } = useAccount()

  // Market selection (fee tier × duration). Default to the demo 7d / fee-500 market.
  const [fee, setFee] = useState<number>(DEMO_MARKET?.fee ?? 500)
  const [durationSeconds, setDurationSeconds] = useState<number>(
    DEMO_MARKET?.durationSeconds ?? 7 * 86_400,
  )
  const selectedMarket = useMemo(
    () => MARKETS.find((m) => m.fee === fee && m.durationSeconds === durationSeconds),
    [fee, durationSeconds],
  )

  const [selectedTokenId, setSelectedTokenId] = useState<bigint | undefined>(undefined)

  // (1) Eligible positions for the connected owner, scoped to the selected duration
  // so the in-range gate + market match the market the user is about to buy on.
  const eligibleQ = useQuery({
    queryKey: ['eligiblePositions', address, durationSeconds, sdk.chainId],
    queryFn: () => sdk.lp.listEligiblePositions(address!, { durations: [durationSeconds] }),
    enabled: !!address,
  })

  const positions = eligibleQ.data ?? []
  // Keep the selection valid as the duration changes.
  const selected = positions.find((p) => p.tokenId === selectedTokenId) ?? positions[0]
  const effectiveTokenId = selected?.tokenId
  // Narrow the selected geometry to a concrete LpGeometry (or undefined when degraded).
  const selectedGeometry: LpGeometry | undefined =
    selected && selected.geometry.priceable ? selected.geometry.geometry : undefined

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* ─── Left: position list + market picker ─── */}
        <Panel title="Your eligible v3 positions">
          <MarketPicker
            fee={fee}
            durationSeconds={durationSeconds}
            onFee={setFee}
            onDuration={setDurationSeconds}
          />

          {selectedMarket && (
            <p className="mt-3 text-body-sm text-fg-tertiary">
              market <span className="num">{truncHex(selectedMarket.marketId)}</span> ·{' '}
              {selectedMarket.label}
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
                  selectedMarket?.durationLabel ?? ''
                } market. Out-of-range positions are not protectable — entry requires Pa ≤ P0 ≤ Pb.`}
              />
            ) : (
              <ul className="space-y-2">
                {positions.map((p) => (
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
        </Panel>

        {/* ─── Right: preview + payoff + buy ─── */}
        <div className="space-y-6">
          {effectiveTokenId !== undefined && selectedMarket ? (
            <PreviewAndBuy
              tokenId={effectiveTokenId}
              marketId={selectedMarket.marketId}
              geometry={selectedGeometry}
            />
          ) : (
            <Panel title="Premium preview">
              <EmptyState
                title="Select a position"
                desc="Pick an eligible position on the left to preview its premium and payoff."
              />
            </Panel>
          )}
        </div>
      </div>

      {/* ─── Active protections ─── */}
      <ActiveProtections owner={address!} />
    </div>
  )
}

// ─── Market picker ──────────────────────────────────────────────────────────
function MarketPicker({
  fee,
  durationSeconds,
  onFee,
  onDuration,
}: {
  fee: number
  durationSeconds: number
  onFee: (f: number) => void
  onDuration: (d: number) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Field label="Fee tier">
        <div className="flex gap-2">
          {FEES.map(([f, label]) => (
            <Button
              key={f}
              variant={f === fee ? 'primary' : 'ghost'}
              className="flex-1 px-2 py-2 text-body-sm"
              onClick={() => onFee(f)}
            >
              {label}
            </Button>
          ))}
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
          <span className="num text-mono text-fg">#{position.tokenId.toString()}</span>
          <Badge tone={position.inRange ? 'teal' : 'warn'}>
            {position.inRange === true
              ? 'in range'
              : position.inRange === false
                ? 'out of range'
                : 'oracle degraded'}
          </Badge>
        </div>
        <div className="mt-1 text-body-sm text-fg-tertiary">
          {g.priceable ? (
            <>
              V0 {fmtUsd(positionV0(g.geometry))} · MaxIL{' '}
              <span className="text-warn-400">{fmtUsd(g.geometry.maxIL)}</span> · L{' '}
              <span className="num">{g.geometry.liquidity.toString()}</span>
            </>
          ) : (
            <>{g.reason} · not priceable right now</>
          )}
        </div>
      </button>
    </li>
  )
}

// ─── Preview + payoff + buy ─────────────────────────────────────────────────
function PreviewAndBuy({
  tokenId,
  marketId,
  geometry,
}: {
  tokenId: bigint
  marketId: Hex
  geometry: LpGeometry | undefined
}) {
  const sdk = useInflexionSdk()
  const tx = useTx()
  const qc = useQueryClient()

  const previewQ = useQuery({
    queryKey: ['previewPremium', tokenId.toString(), marketId, sdk.chainId],
    queryFn: () => sdk.lp.previewPremium(tokenId, marketId),
    refetchInterval: 30_000,
  })

  const preview = previewQ.data

  const onBuy = async () => {
    if (!preview || !preview.priceable) return
    const maxPremium = withSlippage(preview.best, SLIPPAGE_BPS)
    const hash = await tx.run(() =>
      sdk.lp.buyProtection({ tokenId, marketId, maxPremium, approve: true }),
    )
    if (hash) {
      qc.invalidateQueries({ queryKey: ['eligiblePositions'] })
      qc.invalidateQueries({ queryKey: ['ownerSwaps'] })
      previewQ.refetch()
    }
  }

  return (
    <>
      <Panel
        title="Premium preview"
        right={
          preview && preview.priceable ? (
            <Badge tone={preview.path === 'B' ? 'mm' : 'teal'}>Path {preview.path}</Badge>
          ) : undefined
        }
      >
        {previewQ.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !preview ? (
          <Skeleton className="h-20 w-full" />
        ) : !preview.priceable ? (
          <PendingNote>
            Not priceable right now ({preview.reason}). The live oracle reverted (stale feed /
            sequencer down) — the position still exists and becomes quotable once the oracle
            recovers.
          </PendingNote>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Premium (best)"
                value={fmtUsd(preview.best)}
                sub={`pay once · ${preview.path === 'B' ? 'MM quote' : 'pool'}`}
                accent="teal"
              />
              <Stat label="MaxIL (cap)" value={fmtUsd(preview.maxIL)} accent="warn" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
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
          </>
        )}
      </Panel>

      {/* Payoff-with-cap chart from the selected position's geometry. */}
      <Panel title="Payoff with cap">
        {geometry ? (
          <>
            <PayoffChart
              className="w-full"
              geometry={{
                pa: priceNum(geometry.sqrtPaX96),
                p0: priceNum(geometry.sqrtP0X96),
                pb: priceNum(geometry.sqrtPbX96),
              }}
            />
            <p className="mt-3 text-body-sm text-fg-tertiary">
              You are paid your realized IL <strong>up to MaxIL</strong> (teal) while the price is
              in range. Beyond the range the true IL (dashed red) keeps growing but your payout is{' '}
              <strong>capped</strong> at the amber line — the cap that makes the no-bad-debt
              guarantee hold.
            </p>
          </>
        ) : (
          <PendingNote>
            Geometry unavailable (oracle degraded) — the chart needs the live entry price P0.
          </PendingNote>
        )}
      </Panel>

      {/* Buy */}
      <Panel title="Buy protection">
        {preview && preview.priceable ? (
          <>
            <p className="text-body-sm text-fg-secondary">
              Pay <strong>{fmtUsd(preview.best)}</strong> now to cover this position&apos;s in-range
              IL up to <strong>{fmtUsd(preview.maxIL)}</strong> for{' '}
              {fmtDuration(MARKETS.find((m) => m.marketId === marketId)?.durationSeconds ?? 0)}. Max
              premium sent (with {SLIPPAGE_BPS / 100}% slippage):{' '}
              <span className="num">{fmtUsd(withSlippage(preview.best, SLIPPAGE_BPS))}</span>.
            </p>
            <p className="mt-2 text-body-sm text-fg-tertiary">
              The SDK auto-approves the position NFT and the premium (dUSDC) to InflexionCore.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <TxButton status={tx.status} onClick={onBuy} disabled={!preview.priceable}>
                Buy protection
              </TxButton>
              {tx.status === 'success' && (
                <Badge tone="teal">Protected — scroll down for status</Badge>
              )}
            </div>
            {tx.error && (
              <div className="mt-3">
                <ErrorNote>{tx.error}</ErrorNote>
              </div>
            )}
          </>
        ) : (
          <PendingNote>Premium not priceable right now — buying is disabled.</PendingNote>
        )}
      </Panel>
    </>
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
    <Panel
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
    </Panel>
  )
}
