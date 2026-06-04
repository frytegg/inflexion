import { describe, expect, it } from 'vitest'
import { type Address, type Hex, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type SignedQuote,
  CollateralModel,
  SIGNED_QUOTE_TYPE_STRING,
  decodeQuote,
  encodeQuote,
  quoteDigest,
  recoverQuoteSigner,
  signQuote,
  verifyQuote,
} from '../src/quote.js'

// Deterministic test signer (anvil account #0).
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ACCOUNT = privateKeyToAccount(PK)
const CHAIN_ID = 421614 // Arbitrum Sepolia
const CORE = '0x15b74EfcAB40A08281C0Cea972BeE0bbA1a9A96d' as Address

function quote(overrides: Partial<SignedQuote> = {}): SignedQuote {
  return {
    mm: ACCOUNT.address,
    marketId: `0x${'ab'.repeat(32)}` as Hex,
    loadBps: 500,
    minMaxILRatioBps: 0,
    maxMaxILRatioBps: 10_000,
    quotePrice: 3000_00000000n, // $3000 @ 8 decimals
    priceBandBps: 100,
    model: CollateralModel.FULL,
    partialRatioBps: 0,
    maxNotionalV0: (1n << 128n) - 1n,
    validUntil: 1_900_000_000n,
    quoteId: `0x${'00'.repeat(31)}01` as Hex,
    nonce: 1n,
    ...overrides,
  }
}

describe('SignedQuote EIP-712', () => {
  it('round-trips: sign -> recover == mm', async () => {
    const env = await signQuote(PK, quote(), CHAIN_ID, CORE)
    expect(await recoverQuoteSigner(env, CHAIN_ID, CORE)).toBe(ACCOUNT.address)
    expect(await verifyQuote(env, CHAIN_ID, CORE)).toBe(true)
  })

  it('digest is deterministic for the same quote + domain', async () => {
    const q = quote()
    expect(quoteDigest(q, CHAIN_ID, CORE)).toBe(quoteDigest(q, CHAIN_ID, CORE))
  })

  it('digest changes if any signed field changes (loadBps)', () => {
    const a = quoteDigest(quote({ loadBps: 500 }), CHAIN_ID, CORE)
    const b = quoteDigest(quote({ loadBps: 501 }), CHAIN_ID, CORE)
    expect(a).not.toBe(b)
  })

  it('digest is domain-separated (different verifyingContract -> different digest)', () => {
    const other = '0x000000000000000000000000000000000000dEaD' as Address
    expect(quoteDigest(quote(), CHAIN_ID, CORE)).not.toBe(quoteDigest(quote(), CHAIN_ID, other))
  })

  it('a tampered quote no longer recovers to mm', async () => {
    const env = await signQuote(PK, quote(), CHAIN_ID, CORE)
    const tampered = { ...env, quote: { ...env.quote, loadBps: 9999 } }
    expect(await verifyQuote(tampered, CHAIN_ID, CORE)).toBe(false)
  })

  it('wire codec preserves all fields (incl. bigints)', () => {
    const q = quote()
    expect(decodeQuote(encodeQuote(q))).toStrictEqual(q)
  })

  it("type string matches the contract's SIGNED_QUOTE_TYPEHASH pre-image", () => {
    // Pinned mirror of InflexionCore.SIGNED_QUOTE_TYPEHASH; keccak is stable.
    expect(SIGNED_QUOTE_TYPE_STRING).toBe(
      'SignedQuote(address mm,bytes32 marketId,uint16 loadBps,uint16 minMaxILRatioBps,uint16 maxMaxILRatioBps,uint128 quotePrice,uint16 priceBandBps,uint8 model,uint16 partialRatioBps,uint128 maxNotionalV0,uint64 validUntil,bytes32 quoteId,uint256 nonce)',
    )
    // sanity: keccak256 of the type string is a 32-byte hash
    expect(keccak256(toHex(SIGNED_QUOTE_TYPE_STRING))).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
