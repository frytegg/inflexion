/**
 * Minimal viem `as const` ABIs — ONLY the functions/events the SDK calls,
 * transcribed from the real Solidity source in `packages/contracts/src` (+
 * `interfaces`). Kept deliberately narrow so the bindings stay readable and the
 * type inference is fast.
 *
 * GETTER-GAP NOTES (flagged for the Integrate phase; none block the foundation):
 *  - InflexionCore: there is NO public `getMarketPricing`-style aggregator view —
 *    the deployed `_pricePathAFromFair` calls `CvammPricing.loadComponents` via
 *    DELEGATECALL during pricing, but a deployed Solidity library cannot be
 *    eth_called directly (it reverts on a direct CALL; confirmed on the 2026-06-05
 *    deploy). So the SDK composes pricing from `loadParams()` +
 *    `convexityVault.inventory()` + the parity-locked `cvammPricing` TS port (see
 *    math.ts). That TS port is the PERMANENT off-chain mirror, not an interim.
 *  - InflexionCore: `markets(marketId)` is the public mapping getter; it returns
 *    the MarketConfig fields as a TUPLE (no struct names) — decoded positionally.
 *  - InflexionCore: NO `getMarkets()` enumerator (documented non-blocking gap;
 *    served via subgraph/registry).
 *  - InflexionCore: `settlePreview` is NOT `view` (returns), but the deployed
 *    ILMath.computeIL is `pure`, so it is safe to `eth_call`/simulate. Marked
 *    `nonpayable` here; the SDK calls it via `simulateContract`, never readContract.
 *  - SwapCreated / SwapRouted do NOT carry quoteId/nonce; the rich
 *    QuoteFilled/SwapPriced events are LIVE on-chain since the 2026-06-05 deploy
 *    (the lifecycle demo fired both), but PRECISE per-fill attribution from them
 *    needs them indexed (subgraph / eth_getLogs). isNonceUsed is true on BOTH fill
 *    and cancel → the direct-on-chain answer stays COARSE (documented in mm surface).
 *  - ConvexityVault per-depositor getters that EXIST in source:
 *    seniorBalanceOf/juniorBalanceOf (mappings), convertToAssets/convertToShares,
 *    seniorWithdraw/juniorWithdraw (mappings → (shares, unlockAt)),
 *    withdrawalCooldown, seniorAssets/juniorAssets, lockedByMarket. There is NO
 *    per-depositor "realized yield" getter (needs subgraph) — flagged in types.
 *  - OracleManager.getPrice REVERTS on stale/sequencer-down (not a soft view).
 *    Every LP read that needs P0 must catch the revert (see client error helper).
 *  - VolOracle.sigmaRef/sigmaComponents REVERT if the token is not initialized.
 *  - CvammPricing lib functions (totalLoadWad/loadComponents/etc.) are `public` on
 *    the deployed lib image, but it is a DELEGATECALL-ONLY library: Solidity guards
 *    deployed libraries against direct CALLs, so both selectors REVERT via eth_call
 *    to `libs.cvammPricing` (confirmed on the 2026-06-05 deploy). The lib runs
 *    on-chain only via the core's delegatecall during pricing; the SDK mirrors it
 *    with the parity-locked math.ts TS port. DO NOT eth_call it — it will revert.
 */

// ─── InflexionCore ──────────────────────────────────────────────────────────

export const inflexionCoreAbi = [
  // markets(marketId) → MarketConfig tuple (positional decode)
  {
    type: 'function',
    name: 'markets',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'durationSeconds', type: 'uint32' },
      { name: 'oracleToken', type: 'address' },
      { name: 'token0Decimals', type: 'uint8' },
      { name: 'token1Decimals', type: 'uint8' },
      { name: 'oracleDecimals', type: 'uint8' },
      { name: 'active', type: 'bool' },
    ],
  },
  // loadParams() → LoadParams tuple (the cvAMM load-stack params)
  {
    type: 'function',
    name: 'loadParams',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'baseLoadCalmBps', type: 'uint256' },
      { name: 'baseLoadNormalBps', type: 'uint256' },
      { name: 'baseLoadStressedBps', type: 'uint256' },
      { name: 'regimeCalmBelowWad', type: 'uint256' },
      { name: 'regimeStressedAtWad', type: 'uint256' },
      { name: 'utilKneeWad', type: 'uint256' },
      { name: 'utilSlopeWad', type: 'uint256' },
      { name: 'utilPowerWad', type: 'uint256' },
      { name: 'utilCapWad', type: 'uint256' },
      { name: 'dispSlopeWad', type: 'uint256' },
      { name: 'dispPowerWad', type: 'uint256' },
      { name: 'dispCapWad', type: 'uint256' },
      { name: 'maxLoadBps', type: 'uint256' },
    ],
  },
  // swaps(swapId) → SwapRecord tuple (positional decode; NO marketId field)
  {
    type: 'function',
    name: 'swaps',
    stateMutability: 'view',
    inputs: [{ name: 'swapId', type: 'uint256' }],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'lp', type: 'address' },
      { name: 'mm', type: 'address' },
      { name: 'V0', type: 'uint128' },
      { name: 'maxIL', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
      { name: 'premium', type: 'uint128' },
      { name: 'model', type: 'uint8' },
      { name: 'settlement', type: 'uint8' },
      { name: 'createdAt', type: 'uint64' },
      { name: 'expiry', type: 'uint64' },
      { name: 'amount0Entry', type: 'uint128' },
      { name: 'amount1Entry', type: 'uint128' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'status', type: 'uint8' }, // 0=UNINITIALIZED,1=ACTIVE,2=SETTLED
    ],
  },
  {
    type: 'function',
    name: 'nextSwapId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'consumedNotional',
    stateMutability: 'view',
    inputs: [{ name: 'quoteId', type: 'bytes32' }],
    outputs: [{ type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'isNonceUsed',
    stateMutability: 'view',
    inputs: [
      { name: 'mm', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'cvammEnabled',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'oracleDerivedSqrtPriceX96',
    stateMutability: 'view',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'oraclePrice', type: 'uint256' },
    ],
    outputs: [{ type: 'uint160' }],
  },
  // settlePreview: NOT view (returns) — call via simulate/eth_call only.
  {
    type: 'function',
    name: 'settlePreview',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'swapId', type: 'uint256' },
      { name: 'sqrtPTX96', type: 'uint160' },
    ],
    outputs: [
      { name: 'realisedIL', type: 'uint256' },
      { name: 'payout', type: 'uint128' },
    ],
  },
  // ─── Writes ──
  {
    type: 'function',
    name: 'cancelNonces',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'noncesToCancel', type: 'uint256[]' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createSwapPathA',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'bytes32' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'maxPremium', type: 'uint256' },
    ],
    outputs: [{ name: 'swapId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'createSwap',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'quote',
        type: 'tuple',
        components: [
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
      },
      { name: 'signature', type: 'bytes' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'maxPremium', type: 'uint256' },
    ],
    outputs: [{ name: 'swapId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'createSwapRouted',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'quote',
        type: 'tuple',
        components: [
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
      },
      { name: 'signature', type: 'bytes' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'maxPremium', type: 'uint256' },
    ],
    outputs: [{ name: 'swapId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'swapId', type: 'uint256' },
      { name: 'hintRoundId', type: 'uint80' },
    ],
    outputs: [],
  },
  // ─── Events (for fill/lifecycle watching) ──
  {
    type: 'event',
    name: 'SwapCreated',
    inputs: [
      { name: 'swapId', type: 'uint256', indexed: true },
      { name: 'lp', type: 'address', indexed: true },
      { name: 'mm', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: false },
      { name: 'V0', type: 'uint128', indexed: false },
      { name: 'maxIL', type: 'uint128', indexed: false },
      { name: 'premium', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SwapSettled',
    inputs: [
      { name: 'swapId', type: 'uint256', indexed: true },
      { name: 'realisedIL', type: 'uint256', indexed: false },
      { name: 'payout', type: 'uint128', indexed: false },
      { name: 'settlementPrice', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SwapRouted',
    inputs: [
      { name: 'swapId', type: 'uint256', indexed: true },
      { name: 'pathB', type: 'bool', indexed: false },
      { name: 'premiumA', type: 'uint256', indexed: false },
      { name: 'premiumB', type: 'uint256', indexed: false },
    ],
  },
  // NOTE: QuoteFilled / SwapPriced are LIVE on-chain since the 2026-06-05 deploy
  // (the lifecycle demo fired both). The SDK can subscribe to them today; PRECISE
  // per-fill attribution from them additionally needs them indexed (subgraph,
  // pending its Studio-slug deploy — or eth_getLogs).
  {
    type: 'event',
    name: 'QuoteFilled',
    inputs: [
      { name: 'swapId', type: 'uint256', indexed: true },
      { name: 'mm', type: 'address', indexed: true },
      { name: 'quoteId', type: 'bytes32', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'loadBps', type: 'uint16', indexed: false },
    ],
  },
] as const

// ─── ConvexityVault (Path A pooled underwriter) ─────────────────────────────

export const convexityVaultAbi = [
  {
    type: 'function',
    name: 'inventory',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'total', type: 'uint256' },
      { name: 'locked', type: 'uint256' },
      { name: 'free', type: 'uint256' },
      { name: 'util', type: 'uint256' },
      { name: 'conc', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'freeAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'utilizationWad',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'concentrationWad',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'seniorAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'juniorAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'seniorShares',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'juniorShares',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalLocked',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawalCooldown',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'seniorPremiumShareBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'lockedByMarket',
    stateMutability: 'view',
    inputs: [{ name: 'marketId', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'seniorBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'juniorBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [
      { name: 'tranche', type: 'uint8' }, // 0=SENIOR,1=JUNIOR
      { name: 'shares', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToShares',
    stateMutability: 'view',
    inputs: [
      { name: 'tranche', type: 'uint8' },
      { name: 'assets', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  // seniorWithdraw/juniorWithdraw mappings → WithdrawRequest(shares, unlockAt)
  {
    type: 'function',
    name: 'seniorWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'unlockAt', type: 'uint64' },
    ],
  },
  {
    type: 'function',
    name: 'juniorWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'unlockAt', type: 'uint64' },
    ],
  },
  // ─── Writes ──
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tranche', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'requestWithdrawal',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tranche', type: 'uint8' },
      { name: 'shares', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tranche', type: 'uint8' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const

// ─── FairValueOracle (Stylus) ───────────────────────────────────────────────

export const fairValueOracleAbi = [
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
  {
    type: 'function',
    name: 'fairRate',
    stateMutability: 'pure',
    inputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'uint256' },
      { name: 'sigma', type: 'uint256' },
      { name: 'durationSeconds', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fairRateFromPrices',
    stateMutability: 'pure',
    inputs: [
      { name: 'P0', type: 'uint256' },
      { name: 'Pa', type: 'uint256' },
      { name: 'Pb', type: 'uint256' },
      { name: 'sigmaWad', type: 'uint256' },
      { name: 'durationSeconds', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

// ─── VolOracle ──────────────────────────────────────────────────────────────

export const volOracleAbi = [
  {
    type: 'function',
    name: 'sigmaRef',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sigmaComponents',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'sigmaShortWad', type: 'uint256' },
      { name: 'sigmaLongWad', type: 'uint256' },
      { name: 'floorWad', type: 'uint256' },
      { name: 'binding', type: 'uint8' }, // 0=short,1=long,2=floor
    ],
  },
  {
    type: 'function',
    name: 'isInitialized',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // poke(token) → sigmaRefWad (signer-grade freshness)
  {
    type: 'function',
    name: 'poke',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'sigmaRefWad', type: 'uint256' }],
  },
] as const

// ─── ILMath ─────────────────────────────────────────────────────────────────

export const ilMathAbi = [
  {
    type: 'function',
    name: 'computeMaxIL',
    stateMutability: 'pure',
    inputs: [
      { name: 'sqrtPriceX96', type: 'uint256' },
      { name: 'sqrtPaX96', type: 'uint256' },
      { name: 'sqrtPbX96', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
    ],
    outputs: [{ name: 'maxIL', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'computeIL',
    stateMutability: 'pure',
    inputs: [
      { name: 'sqrtPriceTX96', type: 'uint256' },
      { name: 'sqrtPaX96', type: 'uint256' },
      { name: 'sqrtPbX96', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0Entry', type: 'uint256' },
      { name: 'amount1Entry', type: 'uint256' },
    ],
    outputs: [{ name: 'ilAmount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAmountsForLiquidity',
    stateMutability: 'pure',
    inputs: [
      { name: 'sqrtPX96', type: 'uint256' },
      { name: 'sqrtPaX96', type: 'uint256' },
      { name: 'sqrtPbX96', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
] as const

// ─── UnderwriterVault (Path B MM collateral) ────────────────────────────────

export const underwriterVaultAbi = [
  {
    type: 'function',
    name: 'availableBalance',
    stateMutability: 'view',
    inputs: [{ name: 'mm', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'locked',
    stateMutability: 'view',
    inputs: [{ name: 'mm', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'deposited',
    stateMutability: 'view',
    inputs: [{ name: 'mm', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  // ─── Writes ──
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const

// ─── OracleManager ──────────────────────────────────────────────────────────

export const oracleManagerAbi = [
  // getPrice REVERTS on stale/sequencer-down — caught by callers, never throws the call.
  {
    type: 'function',
    name: 'getPrice',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'feedDecimals',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'absBps',
    stateMutability: 'pure',
    inputs: [
      { name: 'a', type: 'int256' },
      { name: 'b', type: 'int256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

// ─── CvammPricing (deployed library image) ──────────────────────────────────
// The LoadParams struct is the same tuple as InflexionCore.loadParams() output.

const loadParamsTuple = {
  name: 'p',
  type: 'tuple',
  components: [
    { name: 'baseLoadCalmBps', type: 'uint256' },
    { name: 'baseLoadNormalBps', type: 'uint256' },
    { name: 'baseLoadStressedBps', type: 'uint256' },
    { name: 'regimeCalmBelowWad', type: 'uint256' },
    { name: 'regimeStressedAtWad', type: 'uint256' },
    { name: 'utilKneeWad', type: 'uint256' },
    { name: 'utilSlopeWad', type: 'uint256' },
    { name: 'utilPowerWad', type: 'uint256' },
    { name: 'utilCapWad', type: 'uint256' },
    { name: 'dispSlopeWad', type: 'uint256' },
    { name: 'dispPowerWad', type: 'uint256' },
    { name: 'dispCapWad', type: 'uint256' },
    { name: 'maxLoadBps', type: 'uint256' },
  ],
} as const

export const cvammPricingAbi = [
  {
    type: 'function',
    name: 'totalLoadWad',
    stateMutability: 'pure',
    inputs: [
      { name: 'sigmaRefWad', type: 'uint256' },
      { name: 'uWad', type: 'uint256' },
      { name: 'hWad', type: 'uint256' },
      loadParamsTuple,
    ],
    outputs: [{ type: 'uint256' }],
  },
  // loadComponents — DEPLOYED on the CvammPricing lib, but DELEGATECALL-ONLY: a
  // direct eth_call to `libs.cvammPricing` REVERTS (Solidity guards deployed
  // libraries; confirmed on the 2026-06-05 deploy). The ABI is kept for shape
  // reference only — DO NOT call it on-chain. The SDK permanently uses the math.ts
  // TS port (parity-locked byte-equal to the deployed Solidity in math.parity.test.ts);
  // the lib runs on-chain only via the core's delegatecall during pricing.
  {
    type: 'function',
    name: 'loadComponents',
    stateMutability: 'pure',
    inputs: [
      { name: 'sigmaRefWad', type: 'uint256' },
      { name: 'uWad', type: 'uint256' },
      { name: 'hWad', type: 'uint256' },
      loadParamsTuple,
    ],
    outputs: [
      { name: 'baseLoad', type: 'uint256' },
      { name: 'utilSkew', type: 'uint256' },
      { name: 'dispSkew', type: 'uint256' },
      { name: 'total', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'premiumFromLoad',
    stateMutability: 'pure',
    inputs: [
      { name: 'fairPremium', type: 'uint256' },
      { name: 'totalLoad', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

// ─── NonfungiblePositionManager (slim read subset) ──────────────────────────

export const npmAbi = [
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const

// ─── ERC-20 (USDC approve/balance for deposits + premiums) ──────────────────

export const erc20Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

// ─── Chainlink AggregatorV3 (round walk for settle hintRoundId) ─────────────

export const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'getRoundData',
    stateMutability: 'view',
    inputs: [{ name: 'roundId', type: 'uint80' }],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const
