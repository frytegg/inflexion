/**
 * MmClient surface tests. Two layers:
 *  1. OFFLINE (always) — pure logic (nonce codec, wadToBps), and the on-chain
 *     surfaces driven by a MOCK viem PublicClient/WalletClient so the multicall
 *     decode, graceful-degradation branches, and the signQuote I10/below-pool
 *     guards are all exercised deterministically with NO RPC.
 *  2. LIVE (gated on ARBITRUM_SEPOLIA_RPC / SEPOLIA_RPC) — the geometry-free
 *     "load to beat" + a real getMarketPricing against the demo market.
 */
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import {
  MmClient,
  MmQuoteError,
  decodeNonce,
  encodeNonce,
  wadToBps,
  type PoolLoadTick,
} from './mm.js'
import { core, demo, tokens } from './addresses.js'
import { makePublicClient, resolveRpcUrl } from './client.js'
import { CollateralModel, type SignedQuote } from './quote.js'
import { WAD } from './math.js'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

/** The live deployment's load params (mirrors the parity test fixture). */
const LOAD_PARAMS_TUPLE = [
  2000n, // baseLoadCalmBps
  3000n, // baseLoadNormalBps
  5000n, // baseLoadStressedBps
  600_000_000_000_000_000n, // regimeCalmBelowWad
  1_025_000_000_000_000_000n, // regimeStressedAtWad
  450_000_000_000_000_000n, // utilKneeWad
  600_000_000_000_000_000n, // utilSlopeWad
  2_000_000_000_000_000_000n, // utilPowerWad
  600_000_000_000_000_000n, // utilCapWad
  500_000_000_000_000_000n, // dispSlopeWad
  1_500_000_000_000_000_000n, // dispPowerWad
  500_000_000_000_000_000n, // dispCapWad
  16_000n, // maxLoadBps
] as const

const MARKET_TUPLE = [
  tokens.demoWeth,
  tokens.demoUsdc,
  500,
  604800,
  tokens.demoWeth, // oracleToken
  18,
  6,
  8,
  true,
] as const

/** A test MM key (well-known anvil key #0) + its address. */
const MM_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const MM_ADDR = privateKeyToAccount(MM_KEY).address

// ─── A configurable mock PublicClient ────────────────────────────────────────

interface MockHandlers {
  markets?: () => readonly unknown[]
  loadParams?: () => readonly unknown[]
  /** inventory tuple (total, locked, free, util, conc). */
  inventory?: () => readonly [bigint, bigint, bigint, bigint, bigint] | { revert: true }
  /** sigmaRef WAD or a revert (uninitialized). */
  sigmaRef?: () => bigint | { revert: true }
  /** fairPremium (premium, fairRateWad, sigmaRefWad) or a revert. */
  fairPremium?: () => readonly [bigint, bigint, bigint] | { revert: true }
}

function makeMockPublic(h: MockHandlers): PublicClient {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    switch (args.functionName) {
      case 'markets':
        return (h.markets ?? (() => MARKET_TUPLE))()
      case 'loadParams':
        return (h.loadParams ?? (() => LOAD_PARAMS_TUPLE))()
      case 'sigmaRef': {
        const r = (h.sigmaRef ?? (() => 700_000_000_000_000_000n))()
        if (typeof r === 'object' && 'revert' in r) throw new Error('vol uninitialized')
        return r
      }
      default:
        throw new Error(`unexpected readContract ${args.functionName}`)
    }
  })

  const multicall = vi.fn(async (args: { contracts: ReadonlyArray<{ functionName: string }> }) => {
    return args.contracts.map((c) => {
      if (c.functionName === 'inventory') {
        const r = (h.inventory ?? (() => [0n, 0n, 0n, 0n, 0n] as const))()
        if (typeof r === 'object' && !Array.isArray(r) && 'revert' in r)
          return { status: 'failure', error: new Error('inventory revert') }
        return { status: 'success', result: r }
      }
      if (c.functionName === 'sigmaRef') {
        const r = (h.sigmaRef ?? (() => 700_000_000_000_000_000n))()
        if (typeof r === 'object' && 'revert' in r)
          return { status: 'failure', error: new Error('vol uninitialized') }
        return { status: 'success', result: r }
      }
      if (c.functionName === 'fairPremium') {
        const r = (
          h.fairPremium ??
          (() => [1_000_000n, 50_000_000_000_000_000n, 700_000_000_000_000_000n] as const)
        )()
        if (typeof r === 'object' && !Array.isArray(r) && 'revert' in r)
          return { status: 'failure', error: new Error('out of range') }
        return { status: 'success', result: r }
      }
      return { status: 'failure', error: new Error(`unexpected multicall ${c.functionName}`) }
    })
  })

  return { readContract, multicall } as unknown as PublicClient
}

// ─── Offline: pure helpers ───────────────────────────────────────────────────

describe('nonce codec (MM-9)', () => {
  it('encodeNonce/decodeNonce round-trip with (word<<8)|bit', () => {
    expect(encodeNonce(0n, 0)).toBe(0n)
    expect(encodeNonce(1n, 0)).toBe(256n)
    expect(encodeNonce(3n, 7)).toBe((3n << 8n) | 7n)
    const { word, bit } = decodeNonce((3n << 8n) | 7n)
    expect(word).toBe(3n)
    expect(bit).toBe(7)
    const big = encodeNonce(123456789n, 255)
    expect(decodeNonce(big)).toEqual({ word: 123456789n, bit: 255 })
  })

  it('rejects an out-of-range bit', () => {
    expect(() => encodeNonce(0n, 256)).toThrow(MmQuoteError)
    expect(() => encodeNonce(0n, -1)).toThrow(MmQuoteError)
  })
})

describe('wadToBps', () => {
  it('converts WAD load to bps (floor)', () => {
    expect(wadToBps(WAD)).toBe(10_000n) // 1.0 → 10000bps
    expect(wadToBps(WAD / 2n)).toBe(5_000n)
    expect(wadToBps(50_000_000_000_000_000n)).toBe(500n) // 0.05 → 500bps
    expect(wadToBps(0n)).toBe(0n)
  })
})

// ─── Offline: getMarketPricing via mock ──────────────────────────────────────

const GEOM = {
  aWad: 900_000_000_000_000_000n,
  bWad: 1_100_000_000_000_000_000n,
  durationSeconds: 604800n,
  maxIL: 1_000_000_000n,
}

describe('getMarketPricing (mock multicall)', () => {
  it('composes fair value + pool load + per-component skews + regime', async () => {
    const pub = makeMockPublic({
      inventory: () => [100n, 60n, 40n, 600_000_000_000_000_000n, 250_000_000_000_000_000n],
      sigmaRef: () => 700_000_000_000_000_000n,
      fairPremium: () => [1_000_000n, 50_000_000_000_000_000n, 700_000_000_000_000_000n],
    })
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.getMarketPricing(demo.marketId_fee500_7d, GEOM)
    expect(r.available).toBe(true)
    if (!r.available) return
    expect(r.fairPremium).toBe(1_000_000n)
    expect(r.fairRateWad).toBe(50_000_000_000_000_000n)
    expect(r.sigmaRefWad).toBe(700_000_000_000_000_000n)
    // σ_ref 0.7 is in the NORMAL band → baseLoad = 3000bps = 0.30 WAD.
    expect(r.baseLoadWad).toBe(300_000_000_000_000_000n)
    expect(r.regime).toBe('normal')
    // util 0.6 > knee 0.45 → util skew > 0; conc 0.25 > 0 → disp skew > 0.
    expect(r.utilSkewWad).toBeGreaterThan(0n)
    expect(r.dispSkewWad).toBeGreaterThan(0n)
    expect(r.totalLoadBps).toBe(wadToBps(r.load.totalLoadWad))
    // poolPremium = ceil(fair·(1+load)) > fair, capped at MaxIL.
    expect(r.poolPremium).toBeGreaterThan(r.fairPremium)
    expect(r.poolPremium).toBeLessThanOrEqual(GEOM.maxIL)
  })

  it('degrades (fair-premium-revert) when the FVO reverts on out-of-range geometry', async () => {
    const pub = makeMockPublic({ fairPremium: () => ({ revert: true }) })
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.getMarketPricing(demo.marketId_fee500_7d, GEOM)
    expect(r.available).toBe(false)
    if (r.available) return
    expect(r.reason).toBe('fair-premium-revert')
  })

  it('degrades (market-unknown) for an unregistered market (token0 == 0)', async () => {
    const pub = makeMockPublic({
      markets: () => [ZERO, ZERO, 0, 0, ZERO, 0, 0, 0, false],
    })
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.getMarketPricing(demo.marketId_fee500_7d, GEOM)
    expect(r.available).toBe(false)
    if (r.available) return
    expect(r.reason).toBe('market-unknown')
  })
})

// ─── Offline: getPoolLoadToBeat (the streamable, geometry-free signal) ────────

describe('getPoolLoadToBeat — geometry-free load to beat', () => {
  it('returns totalLoadBps + components + regime, no geometry needed', async () => {
    const pub = makeMockPublic({
      inventory: () => [100n, 60n, 40n, 600_000_000_000_000_000n, 250_000_000_000_000_000n],
      sigmaRef: () => 1_100_000_000_000_000_000n, // stressed band
    })
    const mm = new MmClient({ publicClient: pub })
    const tick = await mm.getPoolLoadToBeat(demo.marketId_fee500_7d)
    expect(tick.available).toBe(true)
    expect(tick.regime).toBe('stressed')
    expect(tick.totalLoadBps).toBeDefined()
    expect(tick.totalLoadBps!).toBeGreaterThan(0n)
    expect(tick.load?.baseLoadWad).toBe(500_000_000_000_000_000n) // 5000bps stressed
  })

  it('degrades vol-uninitialized when sigmaRef reverts', async () => {
    const pub = makeMockPublic({ sigmaRef: () => ({ revert: true }) })
    const mm = new MmClient({ publicClient: pub })
    const tick = await mm.getPoolLoadToBeat(demo.marketId_fee500_7d)
    expect(tick.available).toBe(false)
    expect(tick.reason).toBe('vol-uninitialized')
  })

  it('streamPoolLoadToBeat emits a tick per market then stops cleanly', async () => {
    const pub = makeMockPublic({
      inventory: () => [100n, 0n, 100n, 0n, 0n],
      sigmaRef: () => 500_000_000_000_000_000n, // calm
    })
    const mm = new MmClient({ publicClient: pub })
    const ticks: PoolLoadTick[] = []
    const handle = mm.streamPoolLoadToBeat([demo.marketId_fee500_7d], (t) => ticks.push(t), {
      intervalMs: 10_000,
    })
    // Wait for the immediate (void poll()) first emission.
    await vi.waitFor(() => expect(ticks.length).toBeGreaterThanOrEqual(1))
    handle.stop()
    expect(ticks[0]!.available).toBe(true)
    expect(ticks[0]!.regime).toBe('calm')
  })
})

// ─── Offline: signQuote guards (I10 + below-pool) ────────────────────────────

function buildQuote(loadBps: number, marketId: Hex): SignedQuote {
  return {
    mm: MM_ADDR,
    marketId,
    loadBps,
    minMaxILRatioBps: 0,
    maxMaxILRatioBps: 10_000,
    quotePrice: 0n,
    priceBandBps: 100,
    model: CollateralModel.FULL,
    partialRatioBps: 0,
    maxNotionalV0: (1n << 128n) - 1n,
    validUntil: BigInt(Math.floor(Date.now() / 1000) + 10),
    quoteId: `0x${'00'.repeat(31)}01` as Hex,
    nonce: 1n,
  }
}

describe('signQuote guards (MM-6)', () => {
  it('throws i10-exceeded when loadBps > maxLoadBps', async () => {
    const pub = makeMockPublic({
      sigmaRef: () => 700_000_000_000_000_000n,
      inventory: () => [0n, 0n, 0n, 0n, 0n],
    })
    const mm = new MmClient({ publicClient: pub })
    await expect(
      mm.signQuote(MM_KEY, buildQuote(20_000, demo.marketId_fee500_7d)),
    ).rejects.toMatchObject({ code: 'i10-exceeded' })
  })

  it('throws not-below-pool when loadBps >= live pool load', async () => {
    // calm σ_ref, util 0 → pool load = baseLoad 2000bps. A 2500bps quote does NOT undercut.
    const pub = makeMockPublic({
      sigmaRef: () => 500_000_000_000_000_000n,
      inventory: () => [0n, 0n, 0n, 0n, 0n],
    })
    const mm = new MmClient({ publicClient: pub })
    await expect(
      mm.signQuote(MM_KEY, buildQuote(2_500, demo.marketId_fee500_7d)),
    ).rejects.toMatchObject({ code: 'not-below-pool' })
  })

  it('signs when loadBps undercuts the pool load + reports the check', async () => {
    const pub = makeMockPublic({
      sigmaRef: () => 500_000_000_000_000_000n, // calm → 2000bps base, util 0 → 2000bps total
      inventory: () => [0n, 0n, 0n, 0n, 0n],
    })
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.signQuote(MM_KEY, buildQuote(1_000, demo.marketId_fee500_7d))
    expect(r.i10Ok).toBe(true)
    expect(r.belowPoolChecked).toBe(true)
    expect(r.poolLoadBps).toBe(2_000n)
    expect(r.envelope.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(r.envelope.quote.loadBps).toBe(1_000)
  })

  it('skips the below-pool check (does not throw) when the pool load is unreadable', async () => {
    const pub = makeMockPublic({ sigmaRef: () => ({ revert: true }) })
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.signQuote(MM_KEY, buildQuote(1_000, demo.marketId_fee500_7d))
    expect(r.belowPoolChecked).toBe(false)
    expect(r.poolLoadBps).toBeUndefined()
    expect(r.envelope.quote.loadBps).toBe(1_000)
  })

  it('hard-errors on unreadable pool load when requirePoolCheck is set', async () => {
    const pub = makeMockPublic({ sigmaRef: () => ({ revert: true }) })
    const mm = new MmClient({ publicClient: pub })
    await expect(
      mm.signQuote(MM_KEY, buildQuote(1_000, demo.marketId_fee500_7d), { requirePoolCheck: true }),
    ).rejects.toMatchObject({ code: 'pool-load-unreadable' })
  })
})

// ─── Offline: isQuoteFilled (coarse) + capacity-remaining ────────────────────

describe('isQuoteFilled (MM-8, COARSE)', () => {
  it('reports spent=true as coarse filled-or-cancelled', async () => {
    const pub = {
      readContract: vi.fn(async (a: { functionName: string }) => {
        if (a.functionName === 'isNonceUsed') return true
        throw new Error('unexpected')
      }),
    } as unknown as PublicClient
    const mm = new MmClient({ publicClient: pub })
    const s = await mm.isQuoteFilled(MM_ADDR, 1n)
    expect(s.spent).toBe(true)
    expect(s.precision).toBe('coarse')
    expect(s.detail).toContain('FILLED-OR-CANCELLED')
  })

  it('degrades (spent=false, coarse) without throwing when the read fails', async () => {
    const pub = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    } as unknown as PublicClient
    const mm = new MmClient({ publicClient: pub })
    const s = await mm.isQuoteFilled(MM_ADDR, 1n)
    expect(s.spent).toBe(false)
    expect(s.precision).toBe('coarse')
    expect(s.detail).toContain('failed')
  })
})

describe('capacityRemaining (I7)', () => {
  it('computes remaining = max − consumed, clamped, with exhausted flag', async () => {
    const pub = {
      readContract: vi.fn(async (a: { functionName: string }) => {
        if (a.functionName === 'consumedNotional') return 30n
        throw new Error('unexpected')
      }),
    } as unknown as PublicClient
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.capacityRemaining(`0x${'11'.repeat(32)}` as Hex, 100n)
    expect(r.available).toBe(true)
    if (!r.available) return
    expect(r.remaining).toBe(70n)
    expect(r.consumed).toBe(30n)
    expect(r.exhausted).toBe(false)
  })

  it('clamps remaining to 0 + exhausted when consumed >= max', async () => {
    const pub = {
      readContract: vi.fn(async () => 150n),
    } as unknown as PublicClient
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.capacityRemaining(`0x${'11'.repeat(32)}` as Hex, 100n)
    expect(r.available).toBe(true)
    if (!r.available) return
    expect(r.remaining).toBe(0n)
    expect(r.exhausted).toBe(true)
  })

  it('degrades available:false when the read throws', async () => {
    const pub = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    } as unknown as PublicClient
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.capacityRemaining(`0x${'11'.repeat(32)}` as Hex, 100n)
    expect(r.available).toBe(false)
  })
})

// ─── Offline: cancelNonces requires a signer ─────────────────────────────────

describe('cancelNonces (MM-9, write)', () => {
  it('builds the tx without a wallet', () => {
    const pub = makeMockPublic({})
    const mm = new MmClient({ publicClient: pub })
    const tx = mm.buildCancelNoncesTx([1n, 2n])
    expect(tx.to).toBe(core.inflexionCore)
    expect(tx.data).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(tx.value).toBe(0n)
  })

  it('throws no-signer when no wallet client is injected', async () => {
    const pub = makeMockPublic({})
    const mm = new MmClient({ publicClient: pub })
    await expect(mm.cancelNonces([1n])).rejects.toMatchObject({ code: 'no-signer' })
  })

  it('sends via the injected wallet client', async () => {
    const pub = makeMockPublic({})
    const sendTransaction = vi.fn(async () => '0xdead' as Hex)
    const wallet = {
      account: { address: MM_ADDR },
      chain: null,
      sendTransaction,
    } as unknown as WalletClient
    const mm = new MmClient({ publicClient: pub, walletClient: wallet })
    const h = await mm.cancelNonces([1n, 2n])
    expect(h).toBe('0xdead')
    expect(sendTransaction).toHaveBeenCalledOnce()
  })
})

// ─── Offline: getBook filters ACTIVE swaps by mm + inferred path ─────────────

describe('getBook (MM-4)', () => {
  function bookClient(swaps: Record<string, readonly unknown[]>, next: bigint): PublicClient {
    return {
      readContract: vi.fn(async (a: { functionName: string; args?: readonly unknown[] }) => {
        if (a.functionName === 'nextSwapId') return next
        if (a.functionName === 'swaps') {
          const id = String(a.args![0])
          const rec = swaps[id]
          if (rec === undefined) throw new Error('no swap')
          return rec
        }
        throw new Error(`unexpected ${a.functionName}`)
      }),
    } as unknown as PublicClient
  }

  it('returns only ACTIVE swaps for the mm + aggregates exposure + infers path', async () => {
    // swap 1: ACTIVE, mm = convexityVault (Path A). swap 2: ACTIVE, mm = MM_ADDR (Path B).
    // swap 3: SETTLED (excluded). swap 4: ACTIVE but a different mm (excluded).
    const rec = (
      tokenId: bigint,
      mm: Address,
      v0: bigint,
      maxIL: bigint,
      status: number,
    ): readonly unknown[] => [
      tokenId,
      ZERO,
      mm,
      v0,
      maxIL,
      maxIL,
      1n,
      0,
      0,
      100n,
      700n,
      0n,
      0n,
      1n,
      status,
    ]
    const pub = bookClient(
      {
        '1': rec(10n, core.convexityVault, 1000n, 100n, 1),
        '2': rec(11n, MM_ADDR, 2000n, 200n, 1),
        '3': rec(12n, MM_ADDR, 3000n, 300n, 2),
        '4': rec(13n, '0x00000000000000000000000000000000000000aa' as Address, 4000n, 400n, 1),
      },
      5n,
    )
    const mm = new MmClient({ publicClient: pub })
    const a = await mm.getBook(MM_ADDR)
    expect(a.available).toBe(true)
    if (!a.available) return
    expect(a.count).toBe(1)
    expect(a.positions[0]!.swapId).toBe(2n)
    expect(a.positions[0]!.isPathA).toBe(false)
    expect(a.exposureV0).toBe(2000n)
    expect(a.exposureMaxIL).toBe(200n)

    // The pool (Path A) book picks up swap 1 only.
    const poolBook = await mm.getBook(core.convexityVault)
    expect(poolBook.available && poolBook.count).toBe(1)
    if (poolBook.available) expect(poolBook.positions[0]!.isPathA).toBe(true)
  })

  it('degrades available:false on nextSwapId read failure', async () => {
    const pub = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    } as unknown as PublicClient
    const mm = new MmClient({ publicClient: pub })
    const r = await mm.getBook(MM_ADDR)
    expect(r.available).toBe(false)
  })
})

// ─── LIVE (gated on an RPC) ──────────────────────────────────────────────────

describe('MmClient — live on-chain (gated on RPC)', () => {
  const rpc = resolveRpcUrl()
  const maybe = rpc === undefined ? it.skip : it

  maybe('getPoolLoadToBeat returns a live tick for the demo market', async () => {
    const mm = new MmClient({ publicClient: makePublicClient() })
    const tick = await mm.getPoolLoadToBeat(demo.marketId_fee500_7d)
    // Either available with a real bps load, or a typed degrade (oracle/vol) — never throws.
    if (tick.available) {
      expect(tick.totalLoadBps!).toBeGreaterThanOrEqual(0n)
      expect(['calm', 'normal', 'stressed']).toContain(tick.regime)
    } else {
      expect(['vol-uninitialized', 'inventory-revert', 'market-unknown', 'no-rpc']).toContain(
        tick.reason,
      )
    }
  })

  maybe('getMarketPricing composes fair + pool for the demo geometry', async () => {
    const mm = new MmClient({ publicClient: makePublicClient() })
    const r = await mm.getMarketPricing(demo.marketId_fee500_7d, GEOM)
    if (r.available) {
      expect(r.fairPremium).toBeGreaterThanOrEqual(0n)
      expect(r.poolPremium).toBeGreaterThanOrEqual(r.fairPremium)
    } else {
      expect([
        'fair-premium-revert',
        'inventory-revert',
        'vol-uninitialized',
        'market-unknown',
        'no-rpc',
      ]).toContain(r.reason)
    }
  })
})
