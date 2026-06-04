/**
 * Re-export of the EIP-712 quote helpers from `@inflexion/engine/quote`. The SDK
 * NEVER reimplements EIP-712 — `signQuote`/`verifyQuote`/`quoteDigest`/the
 * `SignedQuote` type / `encodeQuote`/`decodeQuote` and the domain ("Inflexion","1")
 * are the single source of truth in the engine, matched to SIGNED_QUOTE_TYPEHASH.
 *
 * Exposed both as `@inflexion/sdk/quote` (the package subpath export) and folded
 * into the top-level `@inflexion/sdk` index so MM surfaces (MM-6 `signQuote`) can
 * import it directly.
 */
export * from '@inflexion/engine/quote'
