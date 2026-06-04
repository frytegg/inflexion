/**
 * Barrel + factory smoke tests (offline).
 *
 * Proves the public SDK surface: `createInflexionSdk` wires one read client + an
 * optional write client into all five surfaces; the factory never throws at
 * construction even with no signer (writes degrade); and the re-exports (the
 * surface classes, the namespaced `cvamm` math, and the engine quote helpers)
 * are all reachable from the single `@inflexion/sdk` entrypoint.
 */
import { describe, expect, it } from 'vitest'
import type { PublicClient, WalletClient } from 'viem'

import {
  CHAIN_ID,
  DataClient,
  DepositorClient,
  GreeksEngine,
  HedgeSuggester,
  LpClient,
  MmClient,
  createInflexionSdk,
  cvamm,
  signQuote,
  verifyQuote,
  quoteDigest,
  encodeQuote,
  decodeQuote,
  CollateralModel,
} from './index.js'

describe('createInflexionSdk (offline)', () => {
  it('wires all five surfaces with a default (env-resolved) read client', () => {
    const sdk = createInflexionSdk()
    expect(sdk.chainId).toBe(CHAIN_ID)
    expect(sdk.lp).toBeInstanceOf(LpClient)
    expect(sdk.depositor).toBeInstanceOf(DepositorClient)
    expect(sdk.mm).toBeInstanceOf(MmClient)
    expect(sdk.data).toBeInstanceOf(DataClient)
    expect(sdk.greeks).toBeInstanceOf(GreeksEngine)
    expect(sdk.hedge).toBeInstanceOf(HedgeSuggester)
    expect(sdk.publicClient).toBeDefined()
  })

  it('degrades writes (walletClient undefined) when no signer is available', () => {
    const sdk = createInflexionSdk()
    // No DEPLOYER_PRIVATE_KEY/PRIVATE_KEY/account/walletClient → writes deferred.
    expect(sdk.walletClient).toBeUndefined()
  })

  it('accepts an injected read client (no env / RPC needed)', () => {
    const fake = { readContract: async () => 0n } as unknown as PublicClient
    const sdk = createInflexionSdk({ publicClient: fake })
    expect(sdk.publicClient).toBe(fake)
    expect(sdk.walletClient).toBeUndefined()
  })

  it('threads an injected wallet client into every write surface', () => {
    const fakePub = { readContract: async () => 0n } as unknown as PublicClient
    const fakeWallet = {
      account: { address: '0x0000000000000000000000000000000000000001' },
      chain: null,
      sendTransaction: async () => '0xdead',
    } as unknown as WalletClient
    const sdk = createInflexionSdk({ publicClient: fakePub, walletClient: fakeWallet })
    expect(sdk.walletClient).toBe(fakeWallet)
  })

  it('honours an explicit chainId override', () => {
    const sdk = createInflexionSdk({
      publicClient: {} as unknown as PublicClient,
      chainId: 31337,
    })
    expect(sdk.chainId).toBe(31337)
  })
})

describe('barrel re-exports', () => {
  it('re-exports the namespaced CvammPricing math port', () => {
    expect(cvamm.WAD).toBe(1_000_000_000_000_000_000n)
    expect(typeof cvamm.totalLoadWad).toBe('function')
    expect(typeof cvamm.regimeOf).toBe('function')
  })

  it('re-exports the engine EIP-712 quote helpers (never reimplemented)', () => {
    expect(typeof signQuote).toBe('function')
    expect(typeof verifyQuote).toBe('function')
    expect(typeof quoteDigest).toBe('function')
    expect(typeof encodeQuote).toBe('function')
    expect(typeof decodeQuote).toBe('function')
    expect(CollateralModel.FULL).toBe(0)
  })
})
