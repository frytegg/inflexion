'use client'

/**
 * /underwrite — the Path-B market-maker rail.
 *
 * Flow (INTEGRATION_MAP §2 /underwrite + §4 EIP-712 browser signing):
 *  1. UnderwriterVault collateral — mm.getMmCollateral; deposit/withdraw are a
 *     SEPARATE ERC-20 approve + UnderwriterVault.deposit/withdraw (the SDK exports
 *     the ABI + addresses but has no MmClient helper, so we call the documented
 *     on-chain fns directly via the wallet client — we do NOT invent a method).
 *  2. The quote is PER-MARKET — set the load (below the pool's, ≤ maxLoadBps),
 *     the MaxIL-ratio band (which positions you cover), and capacity. NO tokenId:
 *     MaxIL is the unit of risk, so one firm quote covers ANY in-range position in
 *     the market whose MaxIL/V0 ∈ [min, max] bps (InflexionCore checks this at fill).
 *     mm.getPoolLoadToBeat + getMarketConfig (the oracle anchor) drive it; an
 *     illustrative premium uses a representative position.
 *  3. Build + SIGN a SignedQuote in the BROWSER — enforce the max-load cap + below-pool BEFORE
 *     signing, then walletClient.signTypedData.
 *  4. Publish the envelope to the engine (NEXT_PUBLIC_ENGINE_URL) or show it.
 *  5. Book (mm.getBook) + recent fills (mm.watchFills, coarse) + cancelNonces.
 *
 * Firm quotes, NO last-look. In FULL mode collateral == MaxIL covers the capped
 * claim (payout = min(realized IL, MaxIL)). MM capital is NOT guaranteed.
 */
import { useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toHex, type Hex } from 'viem'
import {
  core,
  tokens,
  demo,
  CHAIN_ID,
  SignedQuoteTypes,
  quoteDomain,
  encodeNonce,
  encodeQuote,
  erc20Abi,
  underwriterVaultAbi,
  oracleManagerAbi,
  type SignedQuote,
  type QuoteEnvelope,
} from '@inflexion/sdk'
import { useInflexionSdk } from '@/lib/use-sdk'
import { useTx } from '@/lib/use-tx'
import { MARKETS, DEMO_MARKET_ID, findMarket } from '@/lib/markets'
import {
  fmtUsd,
  fmtUsdc,
  parseUsdc,
  fmtBps,
  fmtWadPct,
  fmtDuration,
  truncAddr,
  truncHex,
} from '@/lib/format'
import {
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
import { ShimmerButton } from '@/components/magicui/shimmer-button'
import { PageShell, PageHeader, FramedPanel, Reveal } from '@/components/app/chrome'
import { FillsFeed } from '@/components/underwrite/fills-feed'

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL

/** Random bytes32 quoteId (browser crypto). */
function randomQuoteId(): Hex {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return toHex(b)
}

export default function UnderwritePage() {
  const { address, isConnected } = useAccount()

  return (
    <PageShell>
      <PageHeader title="Underwrite">
        Post collateral, beat the pool&apos;s load, and sign{' '}
        <strong className="text-fg">firm EIP-712 quotes — no last-look</strong>. You underwrite the
        capped in-range IL claim (<span className="num">payout = min(realized IL, MaxIL)</span>); in
        FULL mode your locked collateral == MaxIL fully covers it.{' '}
        <strong className="text-warn-400">Your capital is NOT guaranteed</strong> — you are short
        convexity and paid the premium for it.
      </PageHeader>

      <div className="mt-8 space-y-8">
        <Reveal>
          <CollateralPanel address={address} isConnected={isConnected} />
        </Reveal>
        <Reveal>
          <QuoteBuilder isConnected={isConnected} />
        </Reveal>
        <Reveal>
          <BookAndFills address={address} isConnected={isConnected} />
        </Reveal>
      </div>
    </PageShell>
  )
}

// ─── 1. Collateral (UnderwriterVault) ────────────────────────────────────────

function CollateralPanel({
  address,
  isConnected,
}: {
  address: `0x${string}` | undefined
  isConnected: boolean
}) {
  const sdk = useInflexionSdk()
  const qc = useQueryClient()
  const tx = useTx()
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')

  const collateral = useQuery({
    queryKey: ['mm', 'collateral', address],
    queryFn: () => sdk.mm.getMmCollateral(address!),
    enabled: !!address,
    refetchInterval: 12_000,
  })

  // dUSDC wallet balance (for the deposit Max button).
  const balance = useQuery({
    queryKey: ['mm', 'usdcBalance', address],
    queryFn: () =>
      sdk.publicClient.readContract({
        address: tokens.demoUsdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address!],
      }) as Promise<bigint>,
    enabled: !!address,
  })

  const raw = parseUsdc(amount)
  const data = collateral.data

  async function deposit(): Promise<Hex> {
    if (!sdk.walletClient) throw new Error('Connect a wallet to sign.')
    const account = sdk.walletClient.account!
    // ERC-20 approve (spender = UnderwriterVault) only if allowance is short.
    const allowance = (await sdk.publicClient.readContract({
      address: tokens.demoUsdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, core.underwriterVault],
    })) as bigint
    if (allowance < raw) {
      const approveHash = await sdk.walletClient.writeContract({
        account,
        chain: sdk.walletClient.chain ?? null,
        address: tokens.demoUsdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [core.underwriterVault, raw],
      })
      await sdk.publicClient.waitForTransactionReceipt({ hash: approveHash })
    }
    return sdk.walletClient.writeContract({
      account,
      chain: sdk.walletClient.chain ?? null,
      address: core.underwriterVault,
      abi: underwriterVaultAbi,
      functionName: 'deposit',
      args: [raw],
    })
  }

  async function withdraw(): Promise<Hex> {
    if (!sdk.walletClient) throw new Error('Connect a wallet to sign.')
    const account = sdk.walletClient.account!
    return sdk.walletClient.writeContract({
      account,
      chain: sdk.walletClient.chain ?? null,
      address: core.underwriterVault,
      abi: underwriterVaultAbi,
      functionName: 'withdraw',
      args: [raw],
    })
  }

  async function submit() {
    if (raw <= 0n) return
    const ok = await tx.run(() => (mode === 'deposit' ? deposit() : withdraw()))
    if (ok) {
      setAmount('')
      qc.invalidateQueries({ queryKey: ['mm', 'collateral', address] })
      qc.invalidateQueries({ queryKey: ['mm', 'usdcBalance', address] })
    }
  }

  return (
    <FramedPanel title="Underwriter collateral" right={<Badge tone="mm">Path-B vault</Badge>}>
      <ConnectGate message="Connect a wallet on Arbitrum Sepolia to post collateral.">
        {collateral.isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : data === undefined ? (
          <PendingNote>
            Could not read the UnderwriterVault for this account right now (RPC degraded). Retry
            shortly — the on-chain balances are available.
          </PendingNote>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Deposited" value={fmtUsd(data.deposited)} />
            <Stat
              label="Locked (backing claims)"
              value={fmtUsd(data.locked)}
              accent="warn"
              sub="== Σ MaxIL of your active fills"
            />
            <Stat
              label="Available to quote"
              value={fmtUsd(data.available)}
              accent="teal"
              sub="free collateral for new fills"
            />
          </div>
        )}

        <div className="mt-6 rounded-md border border-line bg-base p-4">
          <div className="mb-3 flex gap-2">
            <Button
              variant={mode === 'deposit' ? 'primary' : 'ghost'}
              className="px-3 py-1.5"
              onClick={() => setMode('deposit')}
            >
              Deposit
            </Button>
            <Button
              variant={mode === 'withdraw' ? 'primary' : 'ghost'}
              className="px-3 py-1.5"
              onClick={() => setMode('withdraw')}
            >
              Withdraw
            </Button>
          </div>
          <Field
            label={
              mode === 'deposit' ? 'Deposit dUSDC collateral' : 'Withdraw available collateral'
            }
            hint={
              mode === 'deposit'
                ? 'Two txs: ERC-20 approve(UnderwriterVault) then deposit. Collateral must stay instantly liquid — never lock it elsewhere.'
                : 'Only available (un-locked) collateral can be withdrawn.'
            }
          >
            <AmountInput
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              onMax={() => {
                if (mode === 'deposit' && balance.data !== undefined)
                  setAmount(fmtUsdc(balance.data, 6))
                else if (mode === 'withdraw' && data) setAmount(fmtUsdc(data.available, 6))
              }}
            />
          </Field>
          <div className="mt-4 flex items-center gap-3">
            <TxButton
              status={tx.status}
              onClick={submit}
              disabled={raw <= 0n || !isConnected}
              busyLabel={mode === 'deposit' ? 'Approve + deposit…' : 'Withdraw…'}
            >
              {mode === 'deposit' ? 'Deposit collateral' : 'Withdraw collateral'}
            </TxButton>
            {balance.data !== undefined && (
              <span className="text-body-sm text-fg-tertiary">
                Wallet: <span className="num text-fg">{fmtUsd(balance.data)}</span> dUSDC
              </span>
            )}
          </div>
          {tx.error && (
            <div className="mt-3">
              <ErrorNote>{tx.error}</ErrorNote>
            </div>
          )}
          <p className="mt-3 text-body-sm text-fg-tertiary">
            UnderwriterVault{' '}
            <code className="font-mono text-accent-300">{truncAddr(core.underwriterVault)}</code> ·
            dUSDC <code className="font-mono text-accent-300">{truncAddr(tokens.demoUsdc)}</code>.
            Direct on-chain calls — the SDK exposes the ABI + addresses but no helper for MM
            collateral.
          </p>
        </div>
      </ConnectGate>
    </FramedPanel>
  )
}

// ─── 2. Quote builder (geometry → pricing → sign → publish) ──────────────────

function QuoteBuilder({ isConnected }: { isConnected: boolean }) {
  const sdk = useInflexionSdk()

  // Inputs.
  const [marketId, setMarketId] = useState<Hex>(DEMO_MARKET_ID)
  const [loadBps, setLoadBps] = useState<string>('')
  // The MaxIL-ratio band — which positions this quote covers. A quote is per-MARKET,
  // not per-NFT: it fills any in-range position whose MaxIL/V0 ∈ [min, max] bps.
  const [minRatioBps, setMinRatioBps] = useState<string>('0')
  const [maxRatioBps, setMaxRatioBps] = useState<string>('10000')
  const [priceBandBps, setPriceBandBps] = useState<string>('50')
  const [maxNotional, setMaxNotional] = useState<string>('')
  const [validitySecs, setValiditySecs] = useState<string>('10')

  // Sign / publish state.
  const [signing, setSigning] = useState(false)
  const [signError, setSignError] = useState<string | undefined>(undefined)
  const [envelope, setEnvelope] = useState<QuoteEnvelope | undefined>(undefined)
  const [publishState, setPublishState] = useState<
    | { kind: 'idle' }
    | { kind: 'sending' }
    | { kind: 'sent' }
    | { kind: 'error'; detail: string }
    | { kind: 'no-engine' }
  >({ kind: 'idle' })

  const market = findMarket(marketId)
  // Market config → the oracleToken (the quotePrice anchor — per-MARKET, not per-NFT).
  const marketConfig = useQuery({
    queryKey: ['mm', 'config', marketId],
    queryFn: () => sdk.mm.getMarketConfig(marketId),
    enabled: market !== undefined,
  })
  const oracleToken = marketConfig.data?.oracleToken

  // Live oracle price = the quotePrice the MM signs against (Fork-2 band anchor).
  const oracle = useQuery({
    queryKey: ['mm', 'oracle', oracleToken],
    queryFn: () =>
      sdk.publicClient.readContract({
        address: core.oracleManager,
        abi: oracleManagerAbi,
        functionName: 'getPrice',
        args: [oracleToken!],
      }) as Promise<bigint>,
    enabled: oracleToken !== undefined,
    refetchInterval: 12_000,
  })

  // ILLUSTRATIVE pricing only — a representative in-range position (the seeded demo
  // LP) priced at the selected duration. The QUOTE does NOT depend on this; the real
  // premium is computed on-chain per the LP's own position at fill.
  const geometry = useQuery({
    queryKey: ['mm', 'sampleGeo', market?.durationSeconds],
    queryFn: () => sdk.mm.getPositionGeometry(demo.lpPositionTokenId, market!.durationSeconds),
    enabled: market !== undefined,
  })
  const geo = geometry.data

  const pricingGeo =
    geo?.priceable === true
      ? {
          aWad: geo.geometry.aWad,
          bWad: geo.geometry.bWad,
          durationSeconds: BigInt(market!.durationSeconds),
          maxIL: geo.geometry.maxIL,
          oracleToken: geo.config.oracleToken,
        }
      : undefined

  const pricing = useQuery({
    queryKey: ['mm', 'samplePricing', marketId, pricingGeo?.aWad.toString() ?? 'none'],
    queryFn: () => sdk.mm.getMarketPricing(marketId, pricingGeo!),
    enabled: pricingGeo !== undefined,
  })

  // Geometry-independent "pool load to beat" (the headline max-load reference).
  const poolLoad = useQuery({
    queryKey: ['mm', 'poolLoad', marketId],
    queryFn: () => sdk.mm.getPoolLoadToBeat(marketId),
    enabled: market !== undefined,
    refetchInterval: 8_000,
  })

  const params = useQuery({
    queryKey: ['mm', 'loadParams'],
    queryFn: () => sdk.mm.getLoadParams(),
  })

  const maxLoadBps = params.data ? Number(params.data.maxLoadBps) : undefined
  const poolBps =
    poolLoad.data?.available && poolLoad.data.totalLoadBps !== undefined
      ? Number(poolLoad.data.totalLoadBps)
      : undefined

  // Quote validation (mirror mm.signQuote guards) — gate the sign button.
  const loadNum = loadBps.trim() === '' ? NaN : Number(loadBps)
  const bandNum = priceBandBps.trim() === '' ? NaN : Number(priceBandBps)
  const minRatioNum = minRatioBps.trim() === '' ? NaN : Number(minRatioBps)
  const maxRatioNum = maxRatioBps.trim() === '' ? NaN : Number(maxRatioBps)
  const maxNotionalRaw = parseUsdc(maxNotional)
  const validNum = validitySecs.trim() === '' ? NaN : Number(validitySecs)

  // bps fields are on-chain uint16 — must be non-negative integers.
  const loadInt = Number.isInteger(loadNum)
  const i10Ok = maxLoadBps === undefined || (loadInt && loadNum <= maxLoadBps)
  const belowPool = poolBps === undefined || (loadInt && loadNum < poolBps)
  const ratioOk =
    Number.isInteger(minRatioNum) &&
    Number.isInteger(maxRatioNum) &&
    minRatioNum >= 0 &&
    maxRatioNum <= 10_000 &&
    minRatioNum <= maxRatioNum
  // Signing needs the oracle price (quotePrice) + valid load/band/ratio/capacity —
  // NOT the illustrative sample pricing.
  const inputsOk =
    loadInt &&
    loadNum >= 0 &&
    Number.isInteger(bandNum) &&
    bandNum >= 0 &&
    ratioOk &&
    Number.isFinite(validNum) &&
    validNum >= 5 &&
    maxNotionalRaw > 0n &&
    oracle.data !== undefined

  const canSign = inputsOk && i10Ok && belowPool && isConnected

  async function buildAndSign() {
    setSignError(undefined)
    setEnvelope(undefined)
    setPublishState({ kind: 'idle' })
    if (!sdk.walletClient) {
      setSignError('Connect a wallet to sign.')
      return
    }
    if (oracleToken === undefined) {
      setSignError('Market oracle not resolved yet — try again in a moment.')
      return
    }
    setSigning(true)
    try {
      // Re-enforce the max-load cap + below-pool against a FRESH read right before signing.
      const freshParams = await sdk.mm.getLoadParams()
      if (BigInt(loadNum) > freshParams.maxLoadBps) {
        throw new Error(`loadBps ${loadNum} exceeds maxLoadBps ${freshParams.maxLoadBps}`)
      }
      const freshPool = await sdk.mm.getPoolLoadToBeat(marketId)
      if (
        freshPool.available &&
        freshPool.totalLoadBps !== undefined &&
        BigInt(loadNum) >= freshPool.totalLoadBps
      ) {
        throw new Error(
          `loadBps ${loadNum} does not undercut live pool load ${freshPool.totalLoadBps}bps`,
        )
      }

      // quotePrice (Fork-2 band anchor) = the live oracle price for the MARKET's
      // oracleToken — read fresh, position-independent.
      const oraclePrice = (await sdk.publicClient.readContract({
        address: core.oracleManager,
        abi: oracleManagerAbi,
        functionName: 'getPrice',
        args: [oracleToken],
      })) as bigint

      const now = Math.floor(Date.now() / 1000)
      const quote: SignedQuote = {
        mm: sdk.walletClient.account!.address,
        marketId,
        loadBps: loadNum,
        minMaxILRatioBps: minRatioNum,
        maxMaxILRatioBps: maxRatioNum,
        quotePrice: oraclePrice,
        priceBandBps: bandNum,
        model: 0, // FULL
        partialRatioBps: 0,
        maxNotionalV0: maxNotionalRaw,
        validUntil: BigInt(now + Math.round(validNum)),
        quoteId: randomQuoteId(),
        // word 0, a pseudo-random bit (0–255) so re-quotes don't collide locally.
        nonce: encodeNonce(0n, Math.floor(Math.random() * 256)),
      }

      const signature = await sdk.walletClient.signTypedData({
        account: sdk.walletClient.account!,
        domain: quoteDomain(CHAIN_ID, core.inflexionCore),
        types: SignedQuoteTypes,
        primaryType: 'SignedQuote',
        message: quote,
      })
      const env: QuoteEnvelope = { quote, signature }
      setEnvelope(env)
      await publish(env)
    } catch (e) {
      setSignError(e instanceof Error ? e.message.split('\n')[0] : String(e))
    } finally {
      setSigning(false)
    }
  }

  async function publish(env: QuoteEnvelope) {
    if (!ENGINE_URL) {
      setPublishState({ kind: 'no-engine' })
      return
    }
    setPublishState({ kind: 'sending' })
    try {
      const res = await fetch(`${ENGINE_URL.replace(/\/$/, '')}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'quote',
          quote: encodeQuote(env.quote),
          signature: env.signature,
        }),
      })
      if (!res.ok) {
        setPublishState({ kind: 'error', detail: `engine ${res.status}` })
        return
      }
      setPublishState({ kind: 'sent' })
    } catch (e) {
      setPublishState({ kind: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <FramedPanel
      title="Build & sign a firm quote"
      right={<Badge tone="teal">EIP-712 · no last-look</Badge>}
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* LEFT: inputs */}
        <div className="space-y-4">
          <Field label="Market">
            <select
              value={marketId}
              onChange={(e) => setMarketId(e.target.value as Hex)}
              className="w-full rounded-md border border-line bg-inset px-3 py-2.5 text-body-sm text-fg outline-none focus:border-accent-700"
            >
              {MARKETS.map((m) => (
                <option key={m.marketId} value={m.marketId}>
                  dWETH/dUSDC · {m.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="rounded-md border border-line-subtle bg-base p-3">
            <p className="text-body-sm text-fg-secondary">
              A quote is <span className="text-fg">per-market</span>, not per-position — it fills{' '}
              <span className="text-fg">any in-range position</span> whose MaxIL is within the band
              below (MaxIL is the unit of risk), up to your capacity.{' '}
              {market ? `Duration ${fmtDuration(market.durationSeconds)}.` : ''}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <Field label="Min MaxIL ratio (bps)" hint="MaxIL/V0 lower bound">
                <AmountInput
                  suffix="bps"
                  value={minRatioBps}
                  onChange={(e) => setMinRatioBps(e.target.value)}
                  placeholder="0"
                />
              </Field>
              <Field label="Max MaxIL ratio (bps)" hint="10000 = cover all">
                <AmountInput
                  suffix="bps"
                  value={maxRatioBps}
                  onChange={(e) => setMaxRatioBps(e.target.value)}
                  placeholder="10000"
                />
              </Field>
            </div>
            {!ratioOk && (minRatioBps.trim() !== '' || maxRatioBps.trim() !== '') && (
              <p className="mt-2 text-body-sm text-loss">
                Band must be integers with 0 ≤ min ≤ max ≤ 10000.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Your load (bps)"
              hint={
                maxLoadBps !== undefined
                  ? `≤ ${maxLoadBps} · below pool ${poolBps ?? '—'}`
                  : 'over the on-chain FairPremium'
              }
            >
              <AmountInput
                suffix="bps"
                value={loadBps}
                onChange={(e) => setLoadBps(e.target.value)}
                placeholder={poolBps !== undefined ? String(Math.max(poolBps - 1, 0)) : '0'}
              />
            </Field>
            <Field label="Price band (bps)" hint="Band around the oracle anchor (quotePrice)">
              <AmountInput
                suffix="bps"
                value={priceBandBps}
                onChange={(e) => setPriceBandBps(e.target.value)}
                placeholder="50"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Max notional (V0)" hint="capacity cap for this quote">
              <AmountInput
                value={maxNotional}
                onChange={(e) => setMaxNotional(e.target.value)}
                placeholder="10000"
              />
            </Field>
            <Field label="Valid for (s)" hint="on-chain bound to now + [5,15]s">
              <AmountInput
                suffix="s"
                value={validitySecs}
                onChange={(e) => setValiditySecs(e.target.value)}
                placeholder="10"
              />
            </Field>
          </div>

          {/* Guard banners */}
          {Number.isFinite(loadNum) && !i10Ok && (
            <ErrorNote>
              loadBps {loadNum} exceeds maxLoadBps {maxLoadBps} — the signature would be rejected.
            </ErrorNote>
          )}
          {Number.isFinite(loadNum) && i10Ok && !belowPool && (
            <ErrorNote>
              loadBps {loadNum} does not undercut the live pool load ({poolBps} bps). A quote at or
              above the pool floor will not win the route.
            </ErrorNote>
          )}

          <ConnectGate message="Connect a wallet to sign quotes.">
            <ShimmerButton
              onClick={buildAndSign}
              disabled={!canSign || signing}
              className="text-body-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              {signing ? 'Signing…' : 'Sign firm quote'}
            </ShimmerButton>
          </ConnectGate>
          {signError && <ErrorNote>{signError}</ErrorNote>}
        </div>

        {/* RIGHT: live pricing + the load to beat */}
        <div className="space-y-4">
          {/* Pool load to beat */}
          <Card>
            <div className="flex items-center justify-between">
              <span className="text-label uppercase text-fg-tertiary">Pool load to beat</span>
              {poolLoad.data?.available && poolLoad.data.regime && (
                <Badge
                  tone={
                    poolLoad.data.regime === 'stressed'
                      ? 'loss'
                      : poolLoad.data.regime === 'normal'
                        ? 'warn'
                        : 'teal'
                  }
                >
                  {poolLoad.data.regime}
                </Badge>
              )}
            </div>
            {poolLoad.isLoading ? (
              <Skeleton className="mt-2 h-9 w-32" />
            ) : poolLoad.data?.available !== true ? (
              <div className="mt-2">
                <PendingNote>
                  Pool load not readable ({poolLoad.data?.reason ?? 'unknown'}) — the vol oracle or
                  inventory read is degraded. You can still sign, but you cannot verify you undercut
                  the pool until it recovers.
                </PendingNote>
              </div>
            ) : (
              <>
                <div className="num mt-1 text-mono-stat text-accent-400">
                  {fmtBps(poolLoad.data.totalLoadBps ?? 0n)}
                </div>
                <p className="mt-1 text-body-sm text-fg-tertiary">
                  Your load must be <span className="text-fg">strictly below</span> this and{' '}
                  <span className="text-fg">≤ {maxLoadBps ?? '—'} bps</span>.
                </p>
                {poolLoad.data.load && (
                  <div className="mt-3 grid grid-cols-3 gap-3 text-body-sm">
                    <div>
                      <div className="text-label uppercase text-fg-tertiary">Base</div>
                      <div className="num text-fg">{fmtWadPct(poolLoad.data.load.baseLoadWad)}</div>
                    </div>
                    <div>
                      <div className="text-label uppercase text-fg-tertiary">Util skew</div>
                      <div className="num text-fg">{fmtWadPct(poolLoad.data.load.utilSkewWad)}</div>
                    </div>
                    <div>
                      <div className="text-label uppercase text-fg-tertiary">Disp skew</div>
                      <div className="num text-fg">{fmtWadPct(poolLoad.data.load.dispSkewWad)}</div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>

          {/* Oracle price — the quotePrice anchor (per-market, not per-NFT) */}
          <Card>
            <div className="flex items-center justify-between">
              <span className="text-label uppercase text-fg-tertiary">
                Oracle price — quotePrice anchor
              </span>
              <Badge tone="neutral">{market ? fmtDuration(market.durationSeconds) : '—'}</Badge>
            </div>
            {oracle.isLoading ? (
              <Skeleton className="mt-2 h-8 w-40" />
            ) : oracle.data === undefined ? (
              <div className="mt-2">
                <PendingNote>
                  Oracle price not readable — it&apos;s the price-band anchor you sign against, so
                  signing is blocked until it recovers.
                </PendingNote>
              </div>
            ) : (
              <>
                <div className="num mt-1 text-mono-stat text-fg">
                  ${(Number(oracle.data) / 1e8).toFixed(2)}
                </div>
                <p className="mt-1 text-body-sm text-fg-tertiary">
                  LPs fill only while the live price stays within ±
                  {Number.isFinite(bandNum) ? bandNum : 'your band'} bps of this.
                </p>
              </>
            )}
          </Card>

          {/* Illustrative pricing — a representative position */}
          <Card>
            <span className="text-label uppercase text-fg-tertiary">
              Illustrative — a representative position
            </span>
            {geometry.isLoading || pricing.isLoading ? (
              <Skeleton className="mt-2 h-24" />
            ) : geo?.priceable !== true ? (
              <div className="mt-2">
                <PendingNote>
                  Position not priceable ({geo?.reason ?? 'unknown'}
                  {geo && 'detail' in geo && geo.detail ? ` — ${geo.detail}` : ''}). The oracle may
                  be stale/seq-down, or the position is out-of-range / unknown to this market.
                </PendingNote>
              </div>
            ) : pricing.data?.available !== true ? (
              <div className="mt-2">
                <PendingNote>
                  Could not price the market ({pricing.data?.reason ?? 'unknown'}). The FairValue or
                  vol oracle is degraded — try again shortly.
                </PendingNote>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-4">
                <Stat
                  label="Sample MaxIL (representative)"
                  value={fmtUsd(geo.geometry.maxIL)}
                  accent="warn"
                />
                <Stat
                  label="On-chain FairPremium (sample)"
                  value={fmtUsd(pricing.data.fairPremium)}
                />
                <Stat
                  label="Pool premium (Path-A, to beat)"
                  value={fmtUsd(pricing.data.poolPremium)}
                  accent="teal"
                />
                <Stat
                  label="Est. premium @ your load (sample)"
                  value={
                    Number.isFinite(loadNum) && loadNum >= 0
                      ? fmtUsd(estPremium(pricing.data.fairPremium, loadNum, geo.geometry.maxIL))
                      : '—'
                  }
                  sub={`fair × (1 + ${Number.isFinite(loadNum) ? loadNum : 'your load'} bps), capped at MaxIL · each LP priced from their own position`}
                />
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Signed envelope + publish */}
      {envelope && (
        <div className="mt-6">
          <SignedEnvelope
            envelope={envelope}
            publishState={publishState}
            onRepublish={() => publish(envelope)}
          />
        </div>
      )}
    </FramedPanel>
  )
}

/** est. premium = ceil(fair × (1 + loadBps)) capped at MaxIL — mirrors poolPremium math. */
function estPremium(fairPremium: bigint, loadBps: number, maxIL: bigint): bigint {
  const loaded =
    (fairPremium * BigInt(10_000 + Math.max(0, Math.round(loadBps))) + 9_999n) / 10_000n
  return loaded > maxIL ? maxIL : loaded
}

function SignedEnvelope({
  envelope,
  publishState,
  onRepublish,
}: {
  envelope: QuoteEnvelope
  publishState:
    | { kind: 'idle' }
    | { kind: 'sending' }
    | { kind: 'sent' }
    | { kind: 'error'; detail: string }
    | { kind: 'no-engine' }
  onRepublish: () => void
}) {
  const wire = encodeQuote(envelope.quote)
  return (
    <Card className="border-accent-700/40">
      <div className="flex items-center justify-between">
        <span className="text-label uppercase text-accent-300">Signed quote envelope</span>
        {publishState.kind === 'sent' && <Badge tone="teal">published</Badge>}
        {publishState.kind === 'sending' && <Badge tone="warn">publishing…</Badge>}
        {publishState.kind === 'error' && <Badge tone="loss">publish failed</Badge>}
        {publishState.kind === 'no-engine' && <Badge tone="neutral">engine not configured</Badge>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-body-sm sm:grid-cols-4">
        <KV k="loadBps" v={String(envelope.quote.loadBps)} />
        <KV k="band bps" v={String(envelope.quote.priceBandBps)} />
        <KV k="quotePrice" v={envelope.quote.quotePrice.toString()} />
        <KV k="maxNotionalV0" v={fmtUsd(envelope.quote.maxNotionalV0)} />
        <KV
          k="validUntil"
          v={new Date(Number(envelope.quote.validUntil) * 1000).toLocaleTimeString()}
        />
        <KV k="model" v={envelope.quote.model === 0 ? 'FULL' : 'PARTIAL'} />
        <KV k="quoteId" v={truncHex(envelope.quote.quoteId)} />
        <KV k="nonce" v={envelope.quote.nonce.toString()} />
      </div>

      {publishState.kind === 'no-engine' && (
        <div className="mt-3">
          <PendingNote>
            <code className="font-mono">NEXT_PUBLIC_ENGINE_URL</code> is not set — the quote is
            signed but not published. Below is the exact wire envelope an MM hands to the engine WS
            (or an LP passes to <code className="font-mono">lp.buyProtection</code>).
          </PendingNote>
        </div>
      )}
      {publishState.kind === 'error' && (
        <div className="mt-3 flex items-center gap-3">
          <ErrorNote>Publish failed: {publishState.detail}</ErrorNote>
          <Button variant="ghost" className="px-3 py-1.5" onClick={onRepublish}>
            Retry publish
          </Button>
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-body-sm text-fg-tertiary">
          Wire envelope (QuoteWire + signature)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-base p-3 text-mono text-fg-secondary">
          {JSON.stringify({ type: 'quote', quote: wire, signature: envelope.signature }, null, 2)}
        </pre>
      </details>
    </Card>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-label uppercase text-fg-tertiary">{k}</div>
      <div className="num truncate text-fg" title={v}>
        {v}
      </div>
    </div>
  )
}

// ─── 3. Book + fills + cancelNonces ──────────────────────────────────────────

function BookAndFills({
  address,
  isConnected,
}: {
  address: `0x${string}` | undefined
  isConnected: boolean
}) {
  const sdk = useInflexionSdk()
  const qc = useQueryClient()
  const tx = useTx()
  const [cancelInput, setCancelInput] = useState('')

  const book = useQuery({
    queryKey: ['mm', 'book', address],
    queryFn: () => sdk.mm.getBook(address!),
    enabled: !!address,
    refetchInterval: 15_000,
  })

  const nonces = useMemo(() => {
    return cancelInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return BigInt(s)
        } catch {
          return undefined
        }
      })
      .filter((n): n is bigint => n !== undefined)
  }, [cancelInput])

  async function cancel() {
    if (nonces.length === 0) return
    const ok = await tx.run(() => sdk.mm.cancelNonces(nonces))
    if (ok) {
      setCancelInput('')
      qc.invalidateQueries({ queryKey: ['mm', 'book', address] })
    }
  }

  const data = book.data

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-stretch">
      {/* Book */}
      <FramedPanel
        title="Your book — active fills"
        right={<Badge tone="mm">Path-B</Badge>}
        className="h-full"
      >
        <ConnectGate message="Connect a wallet to see your book.">
          {book.isLoading ? (
            <Skeleton className="h-32" />
          ) : data?.available !== true ? (
            <PendingNote>
              Book scan degraded ({data?.reason ?? 'unknown'}) — the on-chain swap scan failed.
              Retry shortly.
            </PendingNote>
          ) : data.count === 0 ? (
            <EmptyState
              title="No active fills"
              desc="Quotes you sign that get hit show up here. Discovery is an on-chain swap scan (no subgraph yet); aggregate exposure is exact."
            />
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-4">
                <Stat label="Exposure (Σ V0)" value={fmtUsd(data.exposureV0)} />
                <Stat
                  label="Locked (Σ MaxIL)"
                  value={fmtUsd(data.exposureMaxIL)}
                  accent="warn"
                  sub="== your committed collateral"
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-body-sm">
                  <thead>
                    <tr className="border-b border-line-subtle text-left text-label uppercase text-fg-tertiary">
                      <th className="py-2 pr-4 font-normal">Swap</th>
                      <th className="py-2 pr-4 font-normal text-right">V0</th>
                      <th className="py-2 pr-4 font-normal text-right">MaxIL</th>
                      <th className="py-2 pr-4 font-normal text-right">Premium</th>
                      <th className="py-2 font-normal">Expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p) => (
                      <tr key={p.swapId.toString()} className="border-b border-line-subtle/60">
                        <td className="num py-2 pr-4 text-fg">#{p.swapId.toString()}</td>
                        <td className="num py-2 pr-4 text-right text-fg">{fmtUsd(p.V0)}</td>
                        <td className="num py-2 pr-4 text-right text-warn-400">
                          {fmtUsd(p.maxIL)}
                        </td>
                        <td className="num py-2 pr-4 text-right text-accent-400">
                          {fmtUsd(p.premium)}
                        </td>
                        <td className="num py-2 text-fg-tertiary">
                          {new Date(Number(p.expiry) * 1000).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* cancelNonces */}
          <div className="mt-6 rounded-md border border-line bg-base p-4">
            <Field
              label="Cancel quote nonces"
              hint="Space/comma-separated decimal nonces ((word<<8)|bit). Burns the bitmap bit so the quote can never fill."
            >
              <AmountInput
                suffix="nonces"
                value={cancelInput}
                onChange={(e) => setCancelInput(e.target.value)}
                placeholder="3 4 5"
              />
            </Field>
            <div className="mt-4 flex items-center gap-3">
              <TxButton
                status={tx.status}
                variant="danger"
                onClick={cancel}
                disabled={nonces.length === 0 || !isConnected}
                busyLabel="Cancelling…"
              >
                Cancel {nonces.length || ''} nonce{nonces.length === 1 ? '' : 's'}
              </TxButton>
            </div>
            {tx.error && (
              <div className="mt-3">
                <ErrorNote>{tx.error}</ErrorNote>
              </div>
            )}
          </div>
        </ConnectGate>
      </FramedPanel>

      {/* Fills */}
      <FramedPanel title="Recent fills" right={<Badge tone="warn">coarse</Badge>} className="h-full">
        <ConnectGate message="Connect a wallet to watch your fills.">
          {address && <FillsFeed mm={address} />}
        </ConnectGate>
      </FramedPanel>
    </div>
  )
}
