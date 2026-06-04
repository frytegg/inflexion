/**
 * viem client factory for the SDK.
 *
 * - A public (read) client over an injectable HTTP transport. The RPC URL is
 *   injectable explicitly, or falls back to `ARBITRUM_SEPOLIA_RPC` / `SEPOLIA_RPC`
 *   env vars (matching the engine + the vertical-check convention).
 * - An optional wallet (write) client factory — either from a raw private key
 *   (`DEPLOYER_PRIVATE_KEY` / `PRIVATE_KEY`) or an injected viem `Account`.
 * - The chain def is `viem/chains` `arbitrumSepolia` (chainId 421614).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrumSepolia } from 'viem/chains'

export { arbitrumSepolia }

/** The chain the live deployment targets. */
export const chain: Chain = arbitrumSepolia

/** Resolve an RPC URL from explicit arg or env (ARBITRUM_SEPOLIA_RPC, then SEPOLIA_RPC). */
export function resolveRpcUrl(explicit?: string): string | undefined {
  return explicit ?? process.env['ARBITRUM_SEPOLIA_RPC'] ?? process.env['SEPOLIA_RPC'] ?? undefined
}

/** Resolve a funded private key from explicit arg or env (DEPLOYER_PRIVATE_KEY, then PRIVATE_KEY). */
export function resolvePrivateKey(explicit?: Hex): Hex | undefined {
  const fromEnv = process.env['DEPLOYER_PRIVATE_KEY'] ?? process.env['PRIVATE_KEY']
  return explicit ?? (fromEnv as Hex | undefined) ?? undefined
}

export interface PublicClientOptions {
  /** Explicit RPC URL; if omitted, falls back to env. The default viem chain RPC is used if both are absent. */
  rpcUrl?: string
  /** Inject a custom transport (e.g. a mock for tests). Overrides `rpcUrl`. */
  transport?: Transport
}

/**
 * Create a read-only public client. If neither `rpcUrl` nor env is set, viem
 * uses the chain's default public RPC (rate-limited; fine for a vertical check
 * but the caller should inject their own for production).
 */
export function makePublicClient(opts: PublicClientOptions = {}): PublicClient {
  const transport = opts.transport ?? http(resolveRpcUrl(opts.rpcUrl))
  return createPublicClient({ chain, transport }) as PublicClient
}

export interface WalletClientOptions {
  rpcUrl?: string
  transport?: Transport
  /** A pre-built viem account (overrides `privateKey`). */
  account?: Account
  /** A raw private key; if omitted, falls back to env (DEPLOYER_PRIVATE_KEY / PRIVATE_KEY). */
  privateKey?: Hex
}

/**
 * Create a wallet (write) client. Returns `undefined` when no signer is
 * available (no account, no privateKey arg, no env key) — callers treat a
 * missing wallet as "writes deferred" rather than throwing.
 */
export function makeWalletClient(opts: WalletClientOptions = {}): WalletClient | undefined {
  const account = opts.account ?? accountFromKey(opts.privateKey)
  if (account === undefined) return undefined
  const transport = opts.transport ?? http(resolveRpcUrl(opts.rpcUrl))
  return createWalletClient({ account, chain, transport })
}

/** Build a viem account from an explicit key or env, or `undefined` if none. */
export function accountFromKey(privateKey?: Hex): Account | undefined {
  const key = resolvePrivateKey(privateKey)
  if (key === undefined) return undefined
  return privateKeyToAccount(key)
}
