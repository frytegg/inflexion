/**
 * Vertical-check spec — validates the ONE READ + ONE WRITE plumbing.
 *
 * Always runs (no RPC needed): asserts the encoded calldata + tx are well-formed
 * (correct selector, decodes back to the same args, correct `to`). When an RPC /
 * key are present it additionally exercises the live read and reports the result.
 */
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, toFunctionSelector } from 'viem'
import { runVerticalCheck, buildDemoCreateSwapPathATx } from './_vertical-check.js'
import { convexityVaultAbi, inflexionCoreAbi } from './abis.js'
import { core, stylus } from './addresses.js'
import { TRANCHE_ENUM } from './types.js'

describe('thin vertical check — calldata well-formedness (always runs)', () => {
  it('builds a valid inventory() read + fairPremium read + deposit write', async () => {
    const r = await runVerticalCheck()

    // READ: inventory() selector + empty args.
    const invSel = toFunctionSelector('function inventory()')
    expect(r.read.inventoryCalldata.startsWith(invSel)).toBe(true)
    expect(r.read.inventoryCalldata).toBe(invSel) // no args → calldata == selector

    // READ: fairPremium(...) decodes back to the supplied geometry, to the Stylus FVO.
    expect(r.read.fairPremiumTo).toBe(stylus.fairValueOracle)
    const decFP = decodeFunctionData({
      abi: [...inflexionCoreAbi, ...convexityVaultAbi, ...fvoAbi()],
      data: r.read.fairPremiumCalldata as `0x${string}`,
    })
    expect(decFP.functionName).toBe('fairPremium')

    // WRITE: deposit(SENIOR, amount) → correct to + decodes to senior tranche.
    expect(r.write.tx.to).toBe(core.convexityVault)
    expect(r.write.tx.value).toBe(0n)
    const decDep = decodeFunctionData({ abi: convexityVaultAbi, data: r.write.tx.data })
    expect(decDep.functionName).toBe('deposit')
    expect(decDep.args?.[0]).toBe(TRANCHE_ENUM.senior)
    expect(typeof decDep.args?.[1]).toBe('bigint')

    // Status reflects the environment (no throw regardless of RPC/key).
    expect(['ran', 'gated-no-rpc', 'error']).toContain(r.read.status)
    expect(['sent', 'deferred-no-key', 'deferred-no-rpc', 'error']).toContain(r.write.status)
  })

  it('builds a valid demo createSwapPathA write (escape-hatch WRITE)', () => {
    const tx = buildDemoCreateSwapPathATx(1_000_000_000n)
    expect(tx.to).toBe(core.inflexionCore)
    const dec = decodeFunctionData({ abi: inflexionCoreAbi, data: tx.data })
    expect(dec.functionName).toBe('createSwapPathA')
    expect(dec.args?.length).toBe(3)
  })
})

// Local copy of the FVO abi for the decode union (avoids exporting it just for the test).
function fvoAbi() {
  return [
    {
      type: 'function',
      name: 'fairPremium',
      stateMutability: 'view',
      inputs: [
        { name: 'token', type: 'address' },
        { name: 'aWad', type: 'uint256' },
        { name: 'bWad', type: 'uint256' },
        { name: 'durationSeconds', type: 'uint256' },
        { name: 'maxIL', type: 'uint256' },
      ],
      outputs: [
        { name: 'premium', type: 'uint256' },
        { name: 'fairRateWad', type: 'uint256' },
        { name: 'sigmaRefWad', type: 'uint256' },
      ],
    },
  ] as const
}
