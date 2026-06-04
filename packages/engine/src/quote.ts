/**
 * Shared EIP-712 `SignedQuote` helpers — the single source of truth for how a
 * Path-B market maker signs a quote and how anyone verifies it off-chain.
 *
 * The `SignedQuoteTypes` field order + types and the domain `("Inflexion", "1")`
 * MUST match `InflexionCore.SignedQuote` / `SIGNED_QUOTE_TYPEHASH` exactly, or the
 * on-chain verification in `createSwap` / `createSwapRouted` will reject the
 * signature. The canonical type string is mirrored in {@link SIGNED_QUOTE_TYPE_STRING}.
 */
import {
  type Address,
  type Hex,
  type TypedDataDomain,
  hashTypedData,
  recoverTypedDataAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** EIP-712 domain for InflexionCore quotes (`EIP712("Inflexion", "1")`). */
export function quoteDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: 'Inflexion', version: '1', chainId: BigInt(chainId), verifyingContract }
}

/** EIP-712 typed-data definition for `SignedQuote` (field order = struct order). */
export const SignedQuoteTypes = {
  SignedQuote: [
    { name: 'mm', type: 'address' },
    { name: 'marketId', type: 'bytes32' },
    { name: 'loadBps', type: 'uint16' },
    { name: 'minMaxILRatioBps', type: 'uint16' },
    { name: 'maxMaxILRatioBps', type: 'uint16' },
    { name: 'quotePrice', type: 'uint128' },
    { name: 'priceBandBps', type: 'uint16' },
    { name: 'model', type: 'uint8' },
    { name: 'partialRatioBps', type: 'uint16' },
    { name: 'maxNotionalV0', type: 'uint128' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'quoteId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/** Mirror of `InflexionCore.SIGNED_QUOTE_TYPEHASH`'s pre-image (for cross-checks). */
export const SIGNED_QUOTE_TYPE_STRING =
  'SignedQuote(address mm,bytes32 marketId,uint16 loadBps,uint16 minMaxILRatioBps,uint16 maxMaxILRatioBps,uint128 quotePrice,uint16 priceBandBps,uint8 model,uint16 partialRatioBps,uint128 maxNotionalV0,uint64 validUntil,bytes32 quoteId,uint256 nonce)'

/** `CollateralModel` enum (FULL is the only supported mode in v1). */
export const CollateralModel = { FULL: 0, PARTIAL: 1 } as const

/**
 * A market-maker quote. `uint128/uint64/uint256` fields are `bigint`; the small
 * `uint16/uint8` fields are `number` (always < 2^53, safe).
 */
export interface SignedQuote {
  mm: Address
  marketId: Hex
  /** Load (bps) over the on-chain FairPremium; capped at `loadParams.maxLoadBps`. */
  loadBps: number
  minMaxILRatioBps: number
  maxMaxILRatioBps: number
  /** Oracle price (uint128) the MM signed against — anchors the Fork-2 band check. */
  quotePrice: bigint
  priceBandBps: number
  model: number
  partialRatioBps: number
  maxNotionalV0: bigint
  /** Absolute expiry timestamp (uint64). Bounded on-chain to now + [5, 15] s. */
  validUntil: bigint
  quoteId: Hex
  nonce: bigint
}

/** A quote together with its EIP-712 signature — the on-the-wire unit. */
export interface QuoteEnvelope {
  quote: SignedQuote
  signature: Hex
}

/** The EIP-712 digest the contract computes (`_hashTypedDataV4(hashQuote(q))`). */
export function quoteDigest(quote: SignedQuote, chainId: number, verifyingContract: Address): Hex {
  return hashTypedData({
    domain: quoteDomain(chainId, verifyingContract),
    types: SignedQuoteTypes,
    primaryType: 'SignedQuote',
    message: quote,
  })
}

/** Sign a quote with a raw private key (the MM's signer). */
export async function signQuote(
  privateKey: Hex,
  quote: SignedQuote,
  chainId: number,
  verifyingContract: Address,
): Promise<QuoteEnvelope> {
  const account = privateKeyToAccount(privateKey)
  const signature = await account.signTypedData({
    domain: quoteDomain(chainId, verifyingContract),
    types: SignedQuoteTypes,
    primaryType: 'SignedQuote',
    message: quote,
  })
  return { quote, signature }
}

/** Recover the EOA signer of a quote. (EIP-1271 contract signers verify on-chain.) */
export async function recoverQuoteSigner(
  env: QuoteEnvelope,
  chainId: number,
  verifyingContract: Address,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: quoteDomain(chainId, verifyingContract),
    types: SignedQuoteTypes,
    primaryType: 'SignedQuote',
    message: env.quote,
    signature: env.signature,
  })
}

/** True iff the envelope's signature recovers to `quote.mm` (EOA path). */
export async function verifyQuote(
  env: QuoteEnvelope,
  chainId: number,
  verifyingContract: Address,
): Promise<boolean> {
  const signer = await recoverQuoteSigner(env, chainId, verifyingContract)
  return signer.toLowerCase() === env.quote.mm.toLowerCase()
}

// ─── Wire (JSON) codec ─────────────────────────────────────────────────────
// `bigint` is not JSON-serializable, so the WS protocol + append-only log encode
// the uint128/uint64/uint256 fields as decimal strings.

/** JSON-safe wire form of a quote (bigints as decimal strings). */
export interface QuoteWire {
  mm: Address
  marketId: Hex
  loadBps: number
  minMaxILRatioBps: number
  maxMaxILRatioBps: number
  quotePrice: string
  priceBandBps: number
  model: number
  partialRatioBps: number
  maxNotionalV0: string
  validUntil: string
  quoteId: Hex
  nonce: string
}

export function encodeQuote(q: SignedQuote): QuoteWire {
  return {
    mm: q.mm,
    marketId: q.marketId,
    loadBps: q.loadBps,
    minMaxILRatioBps: q.minMaxILRatioBps,
    maxMaxILRatioBps: q.maxMaxILRatioBps,
    quotePrice: q.quotePrice.toString(),
    priceBandBps: q.priceBandBps,
    model: q.model,
    partialRatioBps: q.partialRatioBps,
    maxNotionalV0: q.maxNotionalV0.toString(),
    validUntil: q.validUntil.toString(),
    quoteId: q.quoteId,
    nonce: q.nonce.toString(),
  }
}

export function decodeQuote(w: QuoteWire): SignedQuote {
  return {
    mm: w.mm,
    marketId: w.marketId,
    loadBps: w.loadBps,
    minMaxILRatioBps: w.minMaxILRatioBps,
    maxMaxILRatioBps: w.maxMaxILRatioBps,
    quotePrice: BigInt(w.quotePrice),
    priceBandBps: w.priceBandBps,
    model: w.model,
    partialRatioBps: w.partialRatioBps,
    maxNotionalV0: BigInt(w.maxNotionalV0),
    validUntil: BigInt(w.validUntil),
    quoteId: w.quoteId,
    nonce: BigInt(w.nonce),
  }
}
