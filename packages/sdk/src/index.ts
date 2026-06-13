/**
 * `@inflexion/sdk` — the typed access layer over the live Arbitrum Sepolia
 * deployment (chainId 421614). It is the only layer that holds a signer and the
 * only one that can answer "what dollar premium will I be charged on THIS
 * position if I sign in the next block" (a fresh on-chain `FairValueOracle` read
 * + the position geometry). Reads are graceful: anything that needs a reverting
 * oracle / an absent rich event / a not-yet-built subgraph returns a typed
 * degraded result, never throws.
 *
 * This barrel exports:
 *  - the FOUNDATION (addresses, ABIs, viem client factory, shared types, tuple
 *    decoders, `resolveMarket`, the `CvammPricing` TS port under `cvamm`);
 *  - the four stakeholder surfaces + the hedging surface (LpClient /
 *    DepositorClient / MmClient / DataClient / GreeksEngine + HedgeSuggester);
 *  - the EIP-712 quote helpers, RE-EXPORTED from `@inflexion/engine/quote`
 *    (NEVER reimplemented — single source of truth in the engine);
 *  - a `createInflexionSdk(config)` factory that wires one public (read) client
 *    + an optional wallet (write) client into all five surfaces at once.
 */
import type { Account, Hex, PublicClient, Transport, WalletClient } from 'viem'

import { makePublicClient, makeWalletClient } from './client.js'
import { LpClient } from './lp.js'
import { DepositorClient } from './depositor.js'
import { MmClient } from './mm.js'
import { DataClient } from './data.js'
import { GreeksEngine, HedgeSuggester } from './hedge.js'
import { CHAIN_ID } from './addresses.js'

// ─── Foundation ─────────────────────────────────────────────────────────────
export * from './addresses.js'
export * from './abis.js'
export * from './client.js'
export * from './types.js'
export * from './decode.js'
export * from './resolveMarket.js'

// Math port — namespaced to avoid clobbering type names (e.g. the WAD constant
// and `LoadBreakdown`/`LoadParams`/`Regime` which also live in types.js).
export * as cvamm from './math.js'

// ─── Surface modules ─────────────────────────────────────────────────────────
// `lp`/`depositor`/`data`/`hedge` have no name collisions. `mm.ts` deliberately
// re-exports `SignedQuote`/`QuoteEnvelope` (same engine symbols as `quote.js`)
// and `signQuoteRaw`; those resolve to one declaration so `export *` is safe.
export * from './lp.js'
export * from './depositor.js'
export * from './mm.js'
export * from './data.js'
export * from './hedge.js'

// ─── EIP-712 quote helpers (re-exported from the engine — NEVER reimplemented) ─
export * from './quote.js'

// ─── createInflexionSdk — the one-call factory ────────────────────────────────

/** Configuration for {@link createInflexionSdk}. Everything is optional: with no
 *  args the SDK uses env-resolved RPC / key (ARBITRUM_SEPOLIA_RPC / SEPOLIA_RPC,
 *  DEPLOYER_PRIVATE_KEY / PRIVATE_KEY) and degrades reads gracefully if absent. */
export interface InflexionSdkConfig {
  /** Explicit RPC URL; falls back to env, then the chain's default public RPC. */
  rpcUrl?: string
  /** Inject a custom transport (e.g. a mock for tests). Overrides `rpcUrl`. */
  transport?: Transport
  /** A pre-built read client (overrides `rpcUrl`/`transport`). */
  publicClient?: PublicClient
  /** A pre-built wallet (write) client (overrides `privateKey`/`account`). */
  walletClient?: WalletClient
  /** A raw signer key for writes; falls back to env. Absent ⇒ writes deferred. */
  privateKey?: Hex
  /** A pre-built viem account for writes (overrides `privateKey`). */
  account?: Account
  /** Engine base URL for Path-B quotes + the previewPremium telemetry ping. */
  engineBaseUrl?: string
  /** Public REST API base URL for history/aggregate surfaces (NAV history, etc.).
   *  Absent ⇒ those `DataClient` surfaces return typed `ApiPending` (graceful). */
  apiBaseUrl?: string
  /** Override the telemetry endpoint (defaults to `${engineBaseUrl}/telemetry/preview`). */
  telemetryUrl?: string
  /** Injected fetch (tests). Defaults to global fetch when present. */
  fetchImpl?: typeof fetch
  /** EIP-712 chain id for quote signing (defaults to the live chain, 421614). */
  chainId?: number
}

/** The wired SDK surface — one read/write client behind all five stakeholder
 *  surfaces, plus the resolved viem clients for ad-hoc reads. */
export interface InflexionSdk {
  /** The read client every surface shares. */
  publicClient: PublicClient
  /** The write client (undefined when no signer is available — writes degrade). */
  walletClient?: WalletClient
  /** Chain id the SDK is wired to. */
  chainId: number
  /** LP surface — buying in-range IL protection (claim A). */
  lp: LpClient
  /** Depositor surface — passive + active underwriting (claim B). */
  depositor: DepositorClient
  /** MM surface — Path-B market making (pricing, quoting, book, fills). */
  mm: MmClient
  /** Public data surface — the data moat (one live load surface + API-pending). */
  data: DataClient
  /** Read-only Greeks of the capped IL claim (finite-difference the on-chain math). */
  greeks: GreeksEngine
  /** Read-only hedge suggester (strip + on-chain inverse + delta overlay). */
  hedge: HedgeSuggester
}

/**
 * Wire one public (read) client + an optional wallet (write) client into all
 * five SDK surfaces at once.
 *
 * Resolution order:
 *  - read client: `config.publicClient` ?? `makePublicClient({ rpcUrl, transport })`
 *  - write client: `config.walletClient` ?? `makeWalletClient({ account, privateKey,
 *    transport, rpcUrl })` (returns `undefined` if no signer is available — then
 *    every write surface returns a typed deferred/clear-error result, never crashes
 *    at construction).
 *
 * No address is passed in: every contract address is loaded from
 * `deployments/arbitrum-sepolia.json` via `addresses.ts` (the single source of
 * truth — CLAUDE.md hard rule).
 */
export function createInflexionSdk(config: InflexionSdkConfig = {}): InflexionSdk {
  const publicClient =
    config.publicClient ??
    makePublicClient({
      ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.transport !== undefined ? { transport: config.transport } : {}),
    })

  const walletClient =
    config.walletClient ??
    makeWalletClient({
      ...(config.account !== undefined ? { account: config.account } : {}),
      ...(config.privateKey !== undefined ? { privateKey: config.privateKey } : {}),
      ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.transport !== undefined ? { transport: config.transport } : {}),
    })

  const chainId = config.chainId ?? CHAIN_ID

  const lp = new LpClient({
    publicClient,
    ...(walletClient !== undefined ? { walletClient } : {}),
    ...(config.engineBaseUrl !== undefined ? { engineBaseUrl: config.engineBaseUrl } : {}),
    ...(config.telemetryUrl !== undefined ? { telemetryUrl: config.telemetryUrl } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  })

  const depositor = new DepositorClient({
    publicClient,
    ...(walletClient !== undefined ? { walletClient } : {}),
  })

  const mm = new MmClient({
    publicClient,
    ...(walletClient !== undefined ? { walletClient } : {}),
    chainId,
  })

  const data = new DataClient(publicClient, {
    ...(config.apiBaseUrl !== undefined ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  })
  const greeks = new GreeksEngine(publicClient)
  const hedge = new HedgeSuggester(publicClient)

  return {
    publicClient,
    ...(walletClient !== undefined ? { walletClient } : {}),
    chainId,
    lp,
    depositor,
    mm,
    data,
    greeks,
    hedge,
  }
}
