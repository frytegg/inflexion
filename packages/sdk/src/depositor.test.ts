/**
 * DepositorClient spec.
 *
 * Two assertion paths (mirroring the foundation tests):
 *  1. ALWAYS (offline, mocked transport): the composite reads decode correctly,
 *     the component skews come from the math.ts port, graceful degradation fires
 *     on a reverting σ_ref / no-RPC, writes DEFER without a wallet, claim (B) is
 *     carried and never merged with claim (A).
 *  2. WHEN AN RPC IS AVAILABLE (gated): a live `getVaultState` / `getRegime`
 *     against the deployment returns a typed result (available or degraded) and
 *     never throws.
 *
 * The mocked transport is a viem custom transport whose `request` answers the
 * specific `eth_call`s the client makes, keyed by the function selector — so the
 * test exercises the real viem encode/decode round-trip without a network.
 */
import { describe, expect, it } from 'vitest'
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  toFunctionSelector,
  type EIP1193RequestFn,
  type PublicClient,
} from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { DepositorClient, DEPOSITOR_CLAIM_B, LP_CLAIM_A, type WriteResult } from './depositor.js'
import { core, tokens } from './addresses.js'
import { loadComponents, regimeOf } from './math.js'
import type { LoadParams } from './types.js'
import { resolveRpcUrl, makePublicClient } from './client.js'

// ─── The live loadParams (mirrors math.parity.test.ts / the cvAMM block) ──────
const P: LoadParams = {
  baseLoadCalmBps: 2000n,
  baseLoadNormalBps: 3000n,
  baseLoadStressedBps: 5000n,
  regimeCalmBelowWad: 600_000_000_000_000_000n,
  regimeStressedAtWad: 1_025_000_000_000_000_000n,
  utilKneeWad: 450_000_000_000_000_000n,
  utilSlopeWad: 600_000_000_000_000_000n,
  utilPowerWad: 2_000_000_000_000_000_000n,
  utilCapWad: 600_000_000_000_000_000n,
  dispSlopeWad: 500_000_000_000_000_000n,
  dispPowerWad: 1_500_000_000_000_000_000n,
  dispCapWad: 500_000_000_000_000_000n,
  maxLoadBps: 16_000n,
}

// ─── A scripted fixture for the mocked transport ──────────────────────────────
interface Fixture {
  totalAssets: bigint
  seniorAssets: bigint
  juniorAssets: bigint
  totalLocked: bigint
  free: bigint
  utilWad: bigint
  concWad: bigint
  sigmaRefWad: bigint
  /** When true, a sigmaRef read reverts (VolOracle uninitialized). */
  sigmaReverts?: boolean
  /** Per-market locked answers keyed by marketId. */
  lockedByMarket?: Record<string, bigint>
  /** Per-owner position answers. */
  position?: {
    seniorShares: bigint
    juniorShares: bigint
    seniorAssetsForShares: bigint
    juniorAssetsForShares: bigint
    seniorWithdraw: [bigint, bigint]
    juniorWithdraw: [bigint, bigint]
  }
}

const SEL = {
  inventory: toFunctionSelector('function inventory()'),
  seniorAssets: toFunctionSelector('function seniorAssets()'),
  juniorAssets: toFunctionSelector('function juniorAssets()'),
  loadParams: toFunctionSelector('function loadParams()'),
  sigmaRef: toFunctionSelector('function sigmaRef(address)'),
  lockedByMarket: toFunctionSelector('function lockedByMarket(bytes32)'),
  seniorBalanceOf: toFunctionSelector('function seniorBalanceOf(address)'),
  juniorBalanceOf: toFunctionSelector('function juniorBalanceOf(address)'),
  seniorWithdraw: toFunctionSelector('function seniorWithdraw(address)'),
  juniorWithdraw: toFunctionSelector('function juniorWithdraw(address)'),
  convertToAssets: toFunctionSelector('function convertToAssets(uint8,uint256)'),
  utilizationWad: toFunctionSelector('function utilizationWad()'),
  withdrawalCooldown: toFunctionSelector('function withdrawalCooldown()'),
} as const

const u256 = [{ type: 'uint256' as const }]

function enc(types: { type: string }[], values: unknown[]): `0x${string}` {
  // viem's encodeAbiParameters takes AbiParameter[] — cast through unknown.
  return encodeAbiParameters(types as never, values as never)
}

/** Build a viem PublicClient over a mock transport that answers from a Fixture. */
function mockClient(fx: Fixture): PublicClient {
  const request = (async ({
    method,
    params,
  }: {
    method: string
    params?: unknown
  }): Promise<unknown> => {
    if (method !== 'eth_call') {
      // chainId / misc — answer benignly.
      if (method === 'eth_chainId') return '0x66eee'
      return '0x'
    }
    const call = (params as [{ data: `0x${string}` }])[0]
    const data = call.data
    const sel = data.slice(0, 10)

    switch (sel) {
      case SEL.inventory:
        return enc(
          [
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [fx.totalAssets, fx.totalLocked, fx.free, fx.utilWad, fx.concWad],
        )
      case SEL.seniorAssets:
        return enc(u256, [fx.seniorAssets])
      case SEL.juniorAssets:
        return enc(u256, [fx.juniorAssets])
      case SEL.utilizationWad:
        return enc(u256, [fx.utilWad])
      case SEL.withdrawalCooldown:
        return enc(u256, [86_400n])
      case SEL.loadParams:
        return enc(
          Array.from({ length: 13 }, () => ({ type: 'uint256' })),
          [
            P.baseLoadCalmBps,
            P.baseLoadNormalBps,
            P.baseLoadStressedBps,
            P.regimeCalmBelowWad,
            P.regimeStressedAtWad,
            P.utilKneeWad,
            P.utilSlopeWad,
            P.utilPowerWad,
            P.utilCapWad,
            P.dispSlopeWad,
            P.dispPowerWad,
            P.dispCapWad,
            P.maxLoadBps,
          ],
        )
      case SEL.sigmaRef:
        if (fx.sigmaReverts) throw new Error('execution reverted: VolOracle not initialized')
        return enc(u256, [fx.sigmaRefWad])
      case SEL.lockedByMarket: {
        // marketId is the 32-byte arg after the selector.
        const id = ('0x' + data.slice(10)).toLowerCase()
        const v = fx.lockedByMarket?.[id] ?? 0n
        return enc(u256, [v])
      }
      case SEL.seniorBalanceOf:
        return enc(u256, [fx.position?.seniorShares ?? 0n])
      case SEL.juniorBalanceOf:
        return enc(u256, [fx.position?.juniorShares ?? 0n])
      case SEL.convertToAssets: {
        // tranche is the first 32-byte word, shares the second.
        const trancheWord = data.slice(10, 10 + 64)
        const isSenior = BigInt('0x' + trancheWord) === 0n
        return enc(u256, [
          isSenior
            ? (fx.position?.seniorAssetsForShares ?? 0n)
            : (fx.position?.juniorAssetsForShares ?? 0n),
        ])
      }
      case SEL.seniorWithdraw:
        return enc(
          [{ type: 'uint256' }, { type: 'uint64' }],
          fx.position?.seniorWithdraw ?? [0n, 0n],
        )
      case SEL.juniorWithdraw:
        return enc(
          [{ type: 'uint256' }, { type: 'uint64' }],
          fx.position?.juniorWithdraw ?? [0n, 0n],
        )
      default:
        throw new Error(`mock: unexpected selector ${sel}`)
    }
  }) as unknown as EIP1193RequestFn

  return createPublicClient({
    chain: arbitrumSepolia,
    transport: custom({ request }),
  }) as PublicClient
}

const BASE_FX: Fixture = {
  totalAssets: 1_000_000_000n, // $1,000 (6-dec)
  seniorAssets: 400_000_000n,
  juniorAssets: 600_000_000n,
  totalLocked: 300_000_000n,
  free: 700_000_000n,
  utilWad: 300_000_000_000_000_000n, // 0.30
  concWad: 250_000_000_000_000_000n, // 0.25 HHI
  sigmaRefWad: 700_000_000_000_000_000n, // 0.70 → normal regime
}

describe('DepositorClient.getVaultState — composite + component skews (offline)', () => {
  it('returns fine inventory with the math.ts component skews + banded regime', async () => {
    const client = new DepositorClient({ publicClient: mockClient(BASE_FX) })
    const res = await client.getVaultState()
    expect(res.available).toBe(true)
    if (!res.available) return

    expect(res.totalAssets).toBe(BASE_FX.totalAssets)
    expect(res.seniorAssets).toBe(BASE_FX.seniorAssets)
    expect(res.juniorAssets).toBe(BASE_FX.juniorAssets)
    expect(res.totalLocked).toBe(BASE_FX.totalLocked)
    expect(res.freeAssets).toBe(BASE_FX.free)
    expect(res.utilWad).toBe(BASE_FX.utilWad)
    expect(res.concWad).toBe(BASE_FX.concWad)
    expect(res.sigmaRefWad).toBe(BASE_FX.sigmaRefWad)

    // Component skews EXACTLY match the math.ts port for these inputs.
    const want = loadComponents(BASE_FX.sigmaRefWad, BASE_FX.utilWad, BASE_FX.concWad, P)
    expect(res.baseLoadWad).toBe(want.baseLoadWad)
    expect(res.utilSkewWad).toBe(want.utilSkewWad)
    expect(res.dispSkewWad).toBe(want.dispSkewWad)
    expect(res.totalLoadWad).toBe(want.totalLoadWad)

    // Regime banded from σ_ref (0.70 ∈ [calm,stressed) → normal).
    expect(res.regime).toBe(regimeOf(BASE_FX.sigmaRefWad, P))
    expect(res.regime).toBe('normal')

    // instYieldWad is undefined until a subgraph is wired.
    expect(res.instYieldWad).toBeUndefined()

    // CLAIM (B) is carried.
    expect(res.capitalNotGuaranteed).toBe(true)
  })

  it('bands the regime to calm/stressed at the σ_ref boundaries', async () => {
    const calm = new DepositorClient({
      publicClient: mockClient({ ...BASE_FX, sigmaRefWad: 500_000_000_000_000_000n }),
    })
    const stressed = new DepositorClient({
      publicClient: mockClient({ ...BASE_FX, sigmaRefWad: 1_100_000_000_000_000_000n }),
    })
    const c = await calm.getRegime()
    const s = await stressed.getRegime()
    expect(c.available && c.regime).toBe('calm')
    expect(s.available && s.regime).toBe('stressed')
  })

  it('includes ONLY caller-supplied marketIds in lockedByMarket (flagged, pool-wide free)', async () => {
    const id1 = ('0x' + '11'.repeat(32)) as `0x${string}`
    const id2 = ('0x' + '22'.repeat(32)) as `0x${string}`
    const fx: Fixture = {
      ...BASE_FX,
      lockedByMarket: { [id1.toLowerCase()]: 120_000_000n, [id2.toLowerCase()]: 180_000_000n },
    }
    const client = new DepositorClient({ publicClient: mockClient(fx) })
    const res = await client.getVaultState({ marketIds: [id1, id2] })
    expect(res.available).toBe(true)
    if (!res.available) return
    expect(res.lockedByMarket[id1]).toBe(120_000_000n)
    expect(res.lockedByMarket[id2]).toBe(180_000_000n)
    // With no ids supplied, the map is empty (no per-market budget concept).
    const noIds = await client.getVaultState()
    expect(noIds.available && Object.keys(noIds.lockedByMarket).length).toBe(0)
  })
})

describe('DepositorClient — graceful degradation (offline)', () => {
  it('degrades getVaultState when σ_ref reverts (VolOracle uninitialized)', async () => {
    const client = new DepositorClient({
      publicClient: mockClient({ ...BASE_FX, sigmaReverts: true }),
    })
    const res = await client.getVaultState()
    expect(res.available).toBe(false)
    if (res.available) return
    expect(res.reason).toContain('vol-uninitialized')
  })

  it('degrades getRegime when σ_ref reverts — never throws', async () => {
    const client = new DepositorClient({
      publicClient: mockClient({ ...BASE_FX, sigmaReverts: true }),
    })
    const res = await client.getRegime()
    expect(res.available).toBe(false)
  })
})

describe('DepositorClient.getPosition (offline)', () => {
  it('returns shares + NAV-converted assets + a pending withdrawal queue', async () => {
    const owner = ('0x' + 'ab'.repeat(20)) as `0x${string}`
    const fx: Fixture = {
      ...BASE_FX,
      position: {
        seniorShares: 100_000_000n,
        juniorShares: 50_000_000n,
        seniorAssetsForShares: 110_000_000n, // NAV > 1: some yield accrued
        juniorAssetsForShares: 55_000_000n,
        // a senior withdrawal request unlocking 1 hour from now
        seniorWithdraw: [40_000_000n, BigInt(Math.floor(Date.now() / 1000) + 3600)],
        juniorWithdraw: [0n, 0n], // none
      },
    }
    const client = new DepositorClient({ publicClient: mockClient(fx) })
    const res = await client.getPosition(owner)
    expect(res.available).toBe(true)
    if (!res.available) return

    expect(res.seniorShares).toBe(100_000_000n)
    expect(res.juniorShares).toBe(50_000_000n)
    expect(res.seniorAssets).toBe(110_000_000n)
    expect(res.juniorAssets).toBe(55_000_000n)
    // pending senior withdraw decoded with a positive secondsRemaining
    expect(res.seniorWithdraw?.shares).toBe(40_000_000n)
    expect((res.seniorWithdraw?.secondsRemaining ?? 0n) > 0n).toBe(true)
    // no junior request → undefined (not a zeroed object)
    expect(res.juniorWithdraw).toBeUndefined()
    expect(res.capitalNotGuaranteed).toBe(true)
  })

  it('reports zero balances and no withdraw queue for an unknown owner', async () => {
    const client = new DepositorClient({ publicClient: mockClient(BASE_FX) })
    const res = await client.getPosition(('0x' + 'cd'.repeat(20)) as `0x${string}`)
    expect(res.available).toBe(true)
    if (!res.available) return
    expect(res.seniorShares).toBe(0n)
    expect(res.juniorShares).toBe(0n)
    expect(res.seniorAssets).toBe(0n)
    expect(res.juniorWithdraw).toBeUndefined()
  })
})

describe('DepositorClient writes — graceful defer without a wallet (offline)', () => {
  const client = new DepositorClient({ publicClient: mockClient(BASE_FX) })

  function expectDeferred(r: WriteResult): void {
    expect(r.status).toBe('deferred-no-wallet')
    expect(r.txHash).toBeUndefined()
    expect(r.tx.to).toBe(core.convexityVault)
    expect(r.tx.value).toBe(0n)
    expect(r.tx.data.startsWith('0x')).toBe(true)
  }

  it('deposit DEFERS (built, not sent) when no wallet is configured', async () => {
    expectDeferred(await client.deposit('senior', 1_000_000n))
  })

  it('requestWithdrawal + withdraw DEFER without a wallet', async () => {
    expectDeferred(await client.requestWithdrawal('junior', 10_000n))
    expectDeferred(await client.withdraw('junior'))
  })

  it('buildDeposit / buildApprove return correct targets', () => {
    const dep = client.buildDeposit('junior', 5n)
    expect(dep.to).toBe(core.convexityVault)
    const appr = client.buildApprove(5n)
    expect(appr.to).toBe(tokens.demoUsdc) // USDC approval target is the token
  })

  it('rebalance stages across the cooldown (step 1 deferred, steps 2/3 built)', async () => {
    const staged = await client.rebalance('senior', 'junior', 1_000n)
    expect(staged.steps).toHaveLength(3)
    expect(staged.steps[0]?.result.status).toBe('deferred-no-wallet') // requestWithdrawal
    expect(staged.steps[1]?.result.tx.to).toBe(core.convexityVault) // withdraw built
    expect(staged.steps[2]?.result.tx.to).toBe(core.convexityVault) // deposit built
    expect(staged.note).toContain('cooldown')
  })

  it('rebalance is a no-op when from === to', async () => {
    const staged = await client.rebalance('senior', 'senior', 1_000n)
    expect(staged.steps).toHaveLength(0)
  })
})

describe('DepositorClient — the two never-merged claims', () => {
  it('carries claim (B) on every state/position result and keeps it distinct from claim (A)', async () => {
    const client = new DepositorClient({ publicClient: mockClient(BASE_FX) })
    const state = await client.getVaultState()
    const pos = await client.getPosition(('0x' + '00'.repeat(20)) as `0x${string}`)
    expect(state.available && state.capitalNotGuaranteed).toBe(true)
    expect(pos.available && pos.capitalNotGuaranteed).toBe(true)

    // The two claims are textually distinct and never folded together.
    expect(DEPOSITOR_CLAIM_B).toContain('NOT guaranteed')
    expect(LP_CLAIM_A).toContain('no bad debt in FULL')
    expect(DEPOSITOR_CLAIM_B).not.toBe(LP_CLAIM_A)
    expect(DEPOSITOR_CLAIM_B.includes('always paid')).toBe(false)
  })
})

// ─── Live (gated on RPC): never throws; returns typed available/degraded ──────
describe('DepositorClient — live (gated on RPC)', () => {
  const rpc = resolveRpcUrl()
  const maybe = rpc === undefined ? it.skip : it

  maybe('getVaultState against the live ConvexityVault returns a typed result', async () => {
    const client = new DepositorClient({ publicClient: makePublicClient() })
    const res = await client.getVaultState({ marketIds: [] })
    // Either available (σ_ref initialized) or a typed degraded — never a throw.
    expect(typeof res.available).toBe('boolean')
    if (res.available) {
      expect(res.totalAssets).toBeGreaterThanOrEqual(0n)
      expect(res.capitalNotGuaranteed).toBe(true)
      // total ≥ locked (I5/solvency mirror) on a healthy pool.
      expect(res.totalAssets).toBeGreaterThanOrEqual(res.totalLocked)
    } else {
      expect(typeof res.reason).toBe('string')
    }
  })

  maybe('getRegime against live VolOracle returns calm/normal/stressed or degraded', async () => {
    const client = new DepositorClient({ publicClient: makePublicClient() })
    const res = await client.getRegime()
    if (res.available) {
      expect(['calm', 'normal', 'stressed']).toContain(res.regime)
    } else {
      expect(typeof res.reason).toBe('string')
    }
  })
})
