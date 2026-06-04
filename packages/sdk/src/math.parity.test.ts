/**
 * Parity test for the `CvammPricing` TS port (math.ts) against the deployed
 * Solidity library.
 *
 * Two assertion paths:
 *  1. ALWAYS — assert the port matches the Solidity reference values captured
 *     from the contract test suite (`CvammPricing.t.sol` fixtures + a forge dump
 *     of `loadComponents` for the parity samples). Runs offline, no RPC.
 *  2. WHEN AN RPC IS AVAILABLE — `eth_call` the deployed `CvammPricing.totalLoadWad`
 *     at `libs.cvammPricing` and assert the port agrees within tolerance.
 *
 * The float-based `powWad` in the port differs from solady's integer powWad by a
 * few tens of wei on WAD-scale loads — the tolerance below (1e9 wei = 1e-9 of a
 * WAD) is far larger than the observed ~80-wei drift and far smaller than any
 * economically meaningful load difference.
 */
import { describe, expect, it } from 'vitest'
import { totalLoadWad, loadComponents } from './math.js'
import type { LoadParams } from './types.js'
import { makePublicClient, resolveRpcUrl } from './client.js'
import { cvammPricingAbi } from './abis.js'
import { libs } from './addresses.js'

/** The live deployment's load params (params.json cvAMM block; mirrored in
 *  CvammPricing.t.sol). The on-chain `loadParams()` returns these exact values. */
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

/** [sigmaRefWad, uWad, hWad] parity samples (calm/normal/stressed × util/disp). */
const SAMPLES: ReadonlyArray<readonly [bigint, bigint, bigint]> = [
  [500_000_000_000_000_000n, 0n, 0n],
  [700_000_000_000_000_000n, 600_000_000_000_000_000n, 250_000_000_000_000_000n],
  [1_100_000_000_000_000_000n, 900_000_000_000_000_000n, 1_000_000_000_000_000_000n],
  [800_000_000_000_000_000n, 750_000_000_000_000_000n, 500_000_000_000_000_000n],
]

/** Solidity ground truth (forge dump of `CvammPricing.loadComponents` for SAMPLES). */
const SOLIDITY_REF: ReadonlyArray<{ base: bigint; util: bigint; disp: bigint; total: bigint }> = [
  { base: 200_000_000_000_000_000n, util: 0n, disp: 0n, total: 200_000_000_000_000_000n },
  {
    base: 300_000_000_000_000_000n,
    util: 44_628_099_173_553_718n,
    disp: 62_500_000_000_000_000n,
    total: 407_128_099_173_553_718n,
  },
  {
    base: 500_000_000_000_000_000n,
    util: 401_652_892_561_983_469n,
    disp: 500_000_000_000_000_000n,
    total: 1_401_652_892_561_983_469n,
  },
  {
    base: 300_000_000_000_000_000n,
    util: 178_512_396_694_214_875n,
    disp: 176_776_695_296_636_880n,
    total: 655_289_091_990_851_755n,
  },
]

/** Tolerance: 1e9 wei (1e-9 of a WAD). Float powWad drifts ~80 wei at most. */
const TOL = 1_000_000_000n

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

describe('CvammPricing TS port — Solidity reference parity (offline)', () => {
  it('baseLoad component is exact (integer regime selection)', () => {
    for (let i = 0; i < SAMPLES.length; i++) {
      const s = SAMPLES[i]!
      const c = loadComponents(s[0], s[1], s[2], P)
      // baseLoad is a pure regime lookup → must be EXACT.
      expect(c.baseLoadWad).toBe(SOLIDITY_REF[i]!.base)
    }
  })

  it('util / disp / total skews match Solidity within tolerance', () => {
    for (let i = 0; i < SAMPLES.length; i++) {
      const s = SAMPLES[i]!
      const c = loadComponents(s[0], s[1], s[2], P)
      const ref = SOLIDITY_REF[i]!
      expect(absDiff(c.utilSkewWad, ref.util)).toBeLessThanOrEqual(TOL)
      expect(absDiff(c.dispSkewWad, ref.disp)).toBeLessThanOrEqual(TOL)
      expect(absDiff(c.totalLoadWad, ref.total)).toBeLessThanOrEqual(TOL)
      // totalLoadWad() and loadComponents().total agree.
      expect(totalLoadWad(s[0], s[1], s[2], P)).toBe(c.totalLoadWad)
    }
  })

  it('I10: total load never exceeds maxLoad', () => {
    const maxLoad = P.maxLoadBps * 100_000_000_000_000n
    for (const s of SAMPLES) {
      expect(totalLoadWad(s[0], s[1], s[2], P)).toBeLessThanOrEqual(maxLoad)
    }
    // a saturating input must clamp at maxLoad
    expect(
      totalLoadWad(
        2_000_000_000_000_000_000n,
        1_000_000_000_000_000_000n,
        1_000_000_000_000_000_000n,
        P,
      ),
    ).toBe(
      maxLoad < 1_000_000_000_000_000_000n + 600_000_000_000_000_000n + 500_000_000_000_000_000n
        ? maxLoad
        : 500_000_000_000_000_000n + 600_000_000_000_000_000n + 500_000_000_000_000_000n,
    )
  })
})

describe('CvammPricing TS port — live on-chain parity (gated on RPC)', () => {
  const rpc = resolveRpcUrl()
  const maybe = rpc === undefined ? it.skip : it

  maybe('matches deployed CvammPricing.totalLoadWad', async () => {
    const client = makePublicClient()
    for (const s of SAMPLES) {
      const onchain = await client.readContract({
        address: libs.cvammPricing,
        abi: cvammPricingAbi,
        functionName: 'totalLoadWad',
        args: [s[0], s[1], s[2], P],
      })
      const port = totalLoadWad(s[0], s[1], s[2], P)
      expect(absDiff(port, onchain)).toBeLessThanOrEqual(TOL)
    }
  })
})
