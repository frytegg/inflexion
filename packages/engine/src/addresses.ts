/**
 * Default on-chain addresses for the engine, loaded from the deployment registry
 * — the SINGLE source of truth (CLAUDE.md: "load ALL from
 * deployments/arbitrum-sepolia.json"; NEVER hardcode an address). The engine
 * cannot import `@inflexion/sdk` for these (that package depends on the engine —
 * a cycle), so it reads the same registry JSON directly, exactly as the SDK does.
 *
 * `VERIFYING_CONTRACT` / `CHAIN_ID` can still be overridden by env for a non-default
 * deployment; the registry just supplies the correct default so a redeploy never
 * leaves a stale hardcoded core behind (which would sign quotes against a dead
 * EIP-712 domain and make `createSwapRouted` reject every Path-B fill).
 */
import { getAddress, type Address } from 'viem'
import deployment from '../../../deployments/arbitrum-sepolia.json' with { type: 'json' }

/** Arbitrum Sepolia chain id (the only network the live deployment targets). */
export const DEFAULT_CHAIN_ID = deployment.chainId as 421614

/** InflexionCore — the EIP-712 `verifyingContract` for every `SignedQuote`. */
export const DEFAULT_VERIFYING_CONTRACT: Address = getAddress(
  deployment.deployment.core.inflexionCore,
)
