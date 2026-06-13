/**
 * Address registry — the SINGLE source of truth for every on-chain address the
 * SDK touches. Loaded from `deployments/arbitrum-sepolia.json`; NO address is
 * hardcoded here (CLAUDE.md: "load ALL from deployments/arbitrum-sepolia.json").
 *
 * The deployment JSON is imported (resolveJsonModule) and re-shaped into a flat,
 * typed registry so the surface modules never reach into the raw JSON layout.
 */
import { getAddress, type Address, type Hex } from 'viem'
import deployment from '../../../deployments/arbitrum-sepolia.json' with { type: 'json' }

/** Arbitrum Sepolia chain id (the only network the live deployment targets). */
export const CHAIN_ID = deployment.chainId as 421614

/** The block the live stack was deployed at — the lower bound for event scans. */
export const deployBlock = BigInt(deployment.deployment._deployBlock)

/** Checksum a raw deployment string into a viem `Address`. */
function addr(a: string): Address {
  return getAddress(a)
}

/** Core protocol contracts (Solidity stack — `deployment.core`). */
export const core = {
  /** InflexionCore — the state machine; EIP-712 `verifyingContract` for quotes. */
  inflexionCore: addr(deployment.deployment.core.inflexionCore),
  /** OracleManager — Chainlink-anchored entry/settlement price (reverts on stale/seq-down). */
  oracleManager: addr(deployment.deployment.core.oracleManager),
  /** VolOracle — σ_ref EWMA (poke + sigmaRef/sigmaComponents). */
  volOracle: addr(deployment.deployment.core.volOracle),
  /** ILMath — Q64.96 IL formulas (computeIL/computeMaxIL/getAmountsForLiquidity). */
  ilMath: addr(deployment.deployment.core.ilMath),
  /** ILVault — NFT custody during an active swap. */
  ilVault: addr(deployment.deployment.core.ilVault),
  /** UnderwriterVault — per-MM collateral (Path B). */
  underwriterVault: addr(deployment.deployment.core.underwriterVault),
  /** ConvexityVault — pooled dual-tranche cvAMM underwriter (Path A). */
  convexityVault: addr(deployment.deployment.core.convexityVault),
  /** Protocol treasury (1% premium cut). */
  treasury: addr(deployment.deployment.core.treasury),
} as const

/** Stylus contracts — the SHIPPED FairValueOracle (viem eth_call works on Stylus). */
export const stylus = {
  /** FairValueOracle — exact closed-form fair value (fairPremium/fairRate). NEVER reimplemented. */
  fairValueOracle: addr(deployment.deployment.stylus.fairValueOracle),
} as const

/** Deployed Solidity libraries (public functions, callable via delegatecall image at these addresses). */
export const libs = {
  /** TickMath — tick → sqrtPriceX96 (pure). */
  tickMath: addr(deployment.deployment.libraries.tickMath),
  /** CvammPricing — the deployed load stack (totalLoadWad/loadComponents/etc.). */
  cvammPricing: addr(deployment.deployment.libraries.cvammPricing),
  /** SwapMath — entry amounts + oracle→sqrtP conversion (pure). */
  swapMath: addr(deployment.deployment.libraries.swapMath),
  /** QuoteVerification — EIP-712 quote hashing / signature check. */
  quoteVerification: addr(deployment.deployment.libraries.quoteVerification),
} as const

/** Chainlink USD price feeds (8-decimal). */
export const chainlink = {
  ethUsd: addr(deployment.chainlink.ethUsd),
  btcUsd: addr(deployment.chainlink.btcUsd),
  arbUsd: addr(deployment.chainlink.arbUsd),
  usdcUsd: addr(deployment.chainlink.usdcUsd),
} as const

/** Uniswap v3 deployment (the NonfungiblePositionManager is the one the SDK reads). */
export const uniswap = {
  v3Factory: addr(deployment.uniswap.v3Factory),
  /** NonfungiblePositionManager — `positions(tokenId)`, ownership enumeration. */
  npm: addr(deployment.uniswap.nonfungiblePositionManager),
  swapRouter02: addr(deployment.uniswap.swapRouter02),
  quoterV2: addr(deployment.uniswap.quoterV2),
} as const

/** Convenience alias — the NPM the protocol is wired to (`core` reads this NFT). */
export const npm = uniswap.npm

/** Tokens. The `demo*` pair is the numéraire-correct mock used by the live markets. */
export const tokens = {
  weth: addr(deployment.tokens.weth),
  wethDecimals: deployment.tokens.wethDecimals,
  usdc: addr(deployment.tokens.usdc),
  usdcDecimals: deployment.tokens.usdcDecimals,
  /** dWETH — the demo volatile token (token0; oracle-priced via real Chainlink ETH/USD). */
  demoWeth: addr(deployment.deployment.demo.demoWeth),
  demoWethDecimals: deployment.deployment.demo.demoWethDecimals,
  /** dUSDC — the demo numéraire (token1, 6 decimals). */
  demoUsdc: addr(deployment.deployment.demo.demoUsdc),
  demoUsdcDecimals: deployment.deployment.demo.demoUsdcDecimals,
} as const

/** Demo market geometry + the canonical market ids the live deployment seeded. */
export const demo = {
  /** dWETH/dUSDC fee-500 v3 pool (seeded). */
  pool: addr(deployment.deployment.demo.pool),
  poolFee: deployment.deployment.demo.poolFee,
  /** A seeded in-range LP position NFT (an UNPROTECTED position for previews). */
  lpPositionTokenId: BigInt(deployment.deployment.demo.lpPositionTokenId),
  /** marketId = keccak(token0,token1,fee, 7d) — the demo fee-500 7-day market. */
  marketId_fee500_7d: deployment.deployment.demo.marketId_fee500_7d as Hex,
  /** marketId of the short (300s) lifecycle market (create→settle demo). */
  shortMarketId_fee500_300s: deployment.deployment.lifecycle.shortMarketId_fee500_300s as Hex,
  /** The demo market maker EOA that signed the Path-B fill in the lifecycle demo. */
  marketMaker: addr(deployment.deployment.lifecycle.marketMaker),
  /** A known settled swapId (smoke test). */
  smokeTestSwapId: BigInt(deployment.deployment.demo.smokeTestSwapId),
} as const

/** Flat registry — every address in one object (handy for diagnostics / a single import). */
export const addresses = {
  chainId: CHAIN_ID,
  core,
  stylus,
  libs,
  chainlink,
  uniswap,
  npm,
  tokens,
  demo,
} as const

export type AddressRegistry = typeof addresses
