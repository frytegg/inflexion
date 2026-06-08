# Frontend Integration Map

Canonical reference for building the functional Next.js frontend against `@inflexion/sdk` and the live Arbitrum Sepolia deployment (chainId **421614**).

> **Read first:** the SDK is the only layer that holds a signer and the only one that can answer "what dollar premium will I be charged on THIS position if I sign in the next block." Every read is **graceful** — anything needing a reverting oracle, an absent rich event, or a not-yet-deployed subgraph returns a typed `{ available: false }` / `{ priceable: false }` envelope, **never throws**. Writes throw a clear error only when no `walletClient` is wired.

---

## 0. Sources & key addresses (Arbitrum Sepolia, deployed 2026-06-05, block 274081134)

All addresses load from `deployments/arbitrum-sepolia.json` via `packages/sdk/src/addresses.ts`. **Never hardcode** — import from the SDK (`import { core, stylus, libs, tokens, demo, CHAIN_ID } from '@inflexion/sdk'`).

| Symbol                    | Address                                                              | Role                                                       |
| ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `core.inflexionCore`      | `0xC19865cF8403F59B8Eca835833aFEe3Aa8DA4848`                         | State machine; **EIP-712 `verifyingContract`** for quotes  |
| `core.convexityVault`     | `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d`                         | Path-A pooled underwriter (also = `mm` field when isPathA) |
| `core.underwriterVault`   | `0x4Fb459F3393D206c2b7faD7f0fC9C35a78348D64`                         | Per-MM Path-B collateral                                   |
| `core.oracleManager`      | `0x2c18147B6ec75dcb330d9A48B6B96a4d1a8b529b`                         | Live price; **reverts** on stale/seq-down                  |
| `core.volOracle`          | `0xfdEafBB381192FC5337499d041eaead04d565Ed9`                         | σ_ref EWMA (`sigmaRef` reverts if uninitialised)           |
| `core.ilMath`             | `0x7e90362bc6Df9cb5faA13952e07853ab16c77bd2`                         | IL math (computeIL / computeMaxIL)                         |
| `stylus.fairValueOracle`  | `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c`                         | Stylus Φ-sum — **never reimplemented**                     |
| `libs.tickMath`           | `0xbf02bbc82e0fb1a4b9828bb90fc9dd9e97578965`                         | tick → sqrtPriceX96                                        |
| `libs.cvammPricing`       | `0x4a053d29a55a64172140f9ebbc27c321c0ba2b53`                         | **delegatecall-only** load stack — see Gotchas             |
| `npm` (Uniswap NPM)       | `0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65`                         | `positions(tokenId)`, ownership enumeration                |
| `tokens.demoUsdc`         | `0xB89630Dc6e020ae2A84aE72b7d9EEDBDfb2C544d`                         | **numéraire, 6 decimals** (all premiums/collateral)        |
| `tokens.demoWeth`         | `0xA8C07E1B245B346c5D1910c5055Efe67bF9E7D1D`                         | demo volatile token (18 dec)                               |
| Demo market (fee 500, 7d) | `0x67c4bee1ee037851fbe2a8ecfdd0b8ae3d358283e940750c268621f776479d69` | `demo.marketId_fee500_7d`                                  |
| Demo LP NFT (unprotected) | `3218`                                                               | `demo.lpPositionTokenId`                                   |

---

## 1. SDK instantiation from wagmi

The wagmi config is already in `apps/web/lib/wagmi.ts` (RainbowKit `getDefaultConfig`, chain `arbitrumSepolia`, `ssr: true`). The SDK accepts **pre-built viem clients**, so inject wagmi's clients directly — do **not** let the SDK build a second RPC.

### Exact pattern (hook)

```ts
// apps/web/lib/use-sdk.ts
'use client'
import { useMemo } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { createInflexionSdk, type InflexionSdk } from '@inflexion/sdk'

export function useInflexionSdk(): InflexionSdk {
  const publicClient = usePublicClient() // reads
  const { data: walletClient } = useWalletClient() // writes (undefined until connected)
  const { address } = useAccount() // connected account

  return useMemo(
    () =>
      createInflexionSdk({
        publicClient, // overrides rpcUrl/transport
        ...(walletClient ? { walletClient } : {}), // omit → writes throw clear error
        chainId: 421614, // EIP-712 chainId for quote signing
        engineBaseUrl: process.env.NEXT_PUBLIC_ENGINE_URL, // Path-B quotes + telemetry
        fetchImpl: fetch, // browser fetch (engine + telemetry)
      }),
    [publicClient, walletClient, address],
  )
}
```

### Resolution order (`packages/sdk/src/index.ts:121-174`)

- **Read client:** `config.publicClient` → else `makePublicClient({ rpcUrl, transport })`. `rpcUrl` falls back to `process.env.ARBITRUM_SEPOLIA_RPC` → `SEPOLIA_RPC` → chain default public RPC.
- **Write client:** `config.walletClient` → else `makeWalletClient({ account, privateKey, ... })`. **Returns `undefined`** with no signer; all write surfaces then return a deferred/clear-error result instead of crashing.
- **`walletClient.account` is used directly** — wagmi's `useWalletClient()` already carries `.account` and `.chain`; pass no explicit `account`.

### Notes on the SDK factory (`index.ts:140-161`)

- `lp` receives `engineBaseUrl`, `telemetryUrl`, `fetchImpl`. `mm` receives `chainId`. `depositor`/`data`/`greeks`/`hedge` get only the clients.
- The factory returns `{ publicClient, walletClient?, chainId, lp, depositor, mm, data, greeks, hedge }`.

### Env vars

| Var                                                       | Default / fallback                                | Used by                                               | Effect if unset                                          |
| --------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_RPC_URL`                                     | (none)                                            | wagmi `http()` transport (`lib/wagmi.ts:13`)          | No RPC; all reads fail at transport layer                |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`                    | `'inflexion-dev-placeholder'` (`lib/wagmi.ts:10`) | RainbowKit                                            | WalletConnect non-functional; build stays green          |
| `NEXT_PUBLIC_ENGINE_URL`                                  | `undefined`                                       | `lp.previewPremium`, `lp.fetchEngineQuote`, telemetry | Path-B quotes unavailable → premium falls back to Path A |
| `NEXT_PUBLIC_API_URL`                                     | `undefined`                                       | DataClient history surfaces / REST calls              | API surfaces return `{ available: false }` pending       |
| (server-side, SDK) `ARBITRUM_SEPOLIA_RPC` / `SEPOLIA_RPC` | (none)                                            | SDK RPC fallback if no `publicClient`                 | irrelevant when wagmi client injected                    |

---

## 2. Per-page capability table

Pages live under `apps/web/app/(app)/{protect,earn,underwrite,dashboard,markets,data}/page.tsx`.

| Page                                   | SDK client(s) + methods                                                                                                                                                                                                                                                                                                          | READS                                                                                                                                                                                                                                                                                                       | WRITES (+ ERC-20 approvals)                                                                                                                                                                                          | Engine / API / Subgraph dep + degradation                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **/protect** (LP buys IL protection)   | `lp.listEligiblePositions`, `lp.previewPremium`, `lp.getPayoffCurve`, `lp.buyProtection`, `lp.getProtectionStatus`, `lp.settle`                                                                                                                                                                                                  | NPM `positions`/`balanceOf`/`tokenOfOwnerByIndex`, Core `markets`/`oracleDerivedSqrtPriceX96`/`loadParams`/`swaps`/`settlePreview`, OracleManager `getPrice`, ILMath `computeIL`/`computeMaxIL`/`getAmountsForLiquidity`, FairValueOracle `fairPremium`, ConvexityVault `inventory`                         | **buyProtection**: NPM `approve(core, tokenId)` + dUSDC `approve(core, maxPremium)` then `createSwapRouted`/`createSwapPathA`/`createSwap`; **settle**: `settle(swapId, hintRoundId)` (no approval)                  | **Engine** `GET /quote` for Path-B premium (best-effort; absent → Path A only, `premiumB` undefined). Oracle revert → `inRange: undefined`, premium not priceable. No subgraph needed for the core flow                                                                                                                                                |
| **/earn** (passive depositor, claim B) | `depositor.getVaultState`, `getPosition`, `getLoadParams`, `getRegime`, `getWithdrawalCooldown`, `convertToAssets`, `watchUtilization`, `deposit`, `requestWithdrawal`, `withdraw`                                                                                                                                               | ConvexityVault `inventory`/`seniorAssets`/`juniorAssets`/`seniorBalanceOf`/`juniorBalanceOf`/`seniorWithdraw`/`juniorWithdraw`/`convertToAssets`/`lockedByMarket`/`withdrawalCooldown`/`utilizationWad`, VolOracle `sigmaRef`, Core `loadParams`                                                            | **deposit** (`autoApprove:true`): dUSDC `approve(convexityVault, amount)` then `deposit(tranche, amount)`; **requestWithdrawal**(tranche, shares); **withdraw**(tranche) — no approval                               | Pure RPC. NAV history (`data.getNavHistory`) is API/subgraph-pending → `{ available:false }`. Always render **"capital NOT guaranteed"** (`capitalNotGuaranteed: true` on `VaultState`/`DepositorPosition`)                                                                                                                                            |
| **/underwrite** (Path-B MM)            | `mm.getMarketPricing`, `getPoolLoadToBeat`/`streamPoolLoadToBeat`, `getPositionGeometry`, `getBook`, `greeksForSwap`, `getMmCollateral`, `getSigmaRef`/`getSigmaComponents`, `capacityRemaining`, `isQuoteFilled`, `watchFills`, **`signQuote`**, `quoteStream`, `cancelNonces`/`buildCancelNoncesTx`; plus EIP-712 helpers (§4) | Core `markets`/`loadParams`/`swaps`/`nextSwapId`/`consumedNotional`/`isNonceUsed`, FairValueOracle `fairPremium`, VolOracle `sigmaRef`/`sigmaComponents`, ConvexityVault `inventory`, NPM `positions`, TickMath, ILMath, UnderwriterVault `deposited`/`locked`/`availableBalance`, OracleManager `getPrice` | **EIP-712 sign** (no tx — `walletClient.signTypedData` or SDK `signQuote`); **cancelNonces**(nonces) → Core `cancelNonces` (no approval). UnderwriterVault deposit is a separate ERC-20 approve+deposit (collateral) | **Engine WS** publish signed quotes; **Engine REST** consumes them. Fill attribution is **coarse** on-chain (`isNonceUsed` can't distinguish fill vs cancel); precise via `QuoteFilled` event → **subgraph-pending**. `watchFills` polls `SwapCreated` logs (works now, coarse)                                                                        |
| **/dashboard** (per-user portfolio)    | LP: `getProtectionStatus`, `getClaimableFees`, `getPayoffCurve`, `settle`; Depositor: `getPosition`, `getVaultState`; MM: `getBook`, `getMmCollateral`, `capacityRemaining`                                                                                                                                                      | Core `swaps`/`settlePreview`, NPM `positions`, OracleManager `getPrice`, ConvexityVault/UnderwriterVault balances, ILMath                                                                                                                                                                                   | LP `settle(swapId)`; Depositor `withdraw`/`requestWithdrawal`; MM `cancelNonces` (all as above)                                                                                                                      | Position discovery degrades: without subgraph, LP/MM books are found by **on-chain swap scan** (`autoProtect` `scanLimit`, `getBook` over `nextSwapId`). `getClaimableFees` **under-states** (checkpointed `tokensOwed` only); full fee accounting needs subgraph                                                                                      |
| **/markets** (market browser)          | `data.getCurrentLoadSurface`, `data.getSurfaceSigmaRef`; per-row `mm.getMarketConfig`, `mm.getMarketPricing`                                                                                                                                                                                                                     | Core `loadParams`/`markets`, ConvexityVault `inventory`, FairValueOracle `fairPremium`, VolOracle `sigmaRef`; pool premium computed client-side via **CvammPricing TS port**                                                                                                                                | none                                                                                                                                                                                                                 | **Fully live via RPC multicall** (no subgraph). Per-market rows degrade inline (`{ available:false, reason:'oracle-degraded'                                                                                                                                                                                                                           | 'market-unknown' }`); never throws |
| **/data** (data moat)                  | `data.getCurrentLoadSurface`, `getSurfaceSigmaRef` (live); `getLoadSurfaceHistory`, `getQuoteCompetition`, `getDemandRequests`, `getNavHistory`, `getNetGamma` (API-backed)                                                                                                                                                      | live: same as /markets. history: API/subgraph                                                                                                                                                                                                                                                               | none                                                                                                                                                                                                                 | **One live surface** (current load) via RPC. All time-series are **API-pending** today: history/nav/term-structure → subgraph (events live since deploy block, indexing pending); quote-competition + demand-requests latent half → **engine logs only** (off-chain, never on-chain). Each returns `ApiPending` `{ available:false, endpoint, query }` |

---

## 3. Full method inventory per client

Read = `eth_call` (or `simulateContract`); Write = `eth_sendTransaction`. All read methods degrade to typed envelopes.

### LpClient (`packages/sdk/src/lp.ts`) — LP / claim A

| Method                  | Args                                                                                                                   | Returns                                   | R/W                     | Contract fn(s)                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listEligiblePositions` | `owner: Address, opts?: { durations? }`                                                                                | `EligiblePosition[]`                      | R                       | NPM `balanceOf`/`tokenOfOwnerByIndex`/`positions`, Core `markets`/`oracleDerivedSqrtPriceX96`, OracleManager `getPrice`, TickMath, ILMath `computeMaxIL`/`getAmountsForLiquidity` |
| `previewPremium`        | `tokenId, marketId, opts?: { poke?, engineBaseUrl? }`                                                                  | `Priceable<PreviewResult>`                | R (+opt poke W)         | FairValueOracle `fairPremium`, ConvexityVault `inventory`, Core `loadParams`/`markets`; engine `GET /quote`; TS-port cvamm load; opt `VolOracle.poke`                             |
| `getPayoffCurve`        | `tokenId, marketId, opts?: { points? }`                                                                                | `Priceable<PayoffCurve>`                  | R                       | ILMath `computeIL` over price grid                                                                                                                                                |
| `buyProtection`         | `BuyProtectionParams { tokenId, marketId, maxPremium, quote?, signature?, escapeHatch?, approve? }`                    | `Hex` (txHash)                            | **W**                   | NPM `approve`, dUSDC `allowance`/`approve`, Core `createSwapRouted` (default) / `createSwapPathA` (`escapeHatch:'A'`) / `createSwap` (`'B'`)                                      |
| `getProtectionStatus`   | `swapId`                                                                                                               | `ProtectionStatus \| { available:false }` | R                       | Core `swaps` + `settlePreview` (via `simulateContract`), OracleManager `getPrice`, Core `oracleDerivedSqrtPriceX96`                                                               |
| `getClaimableFees`      | `swapId`                                                                                                               | `ClaimableFees \| { available:false }`    | R                       | Core `swaps`, NPM `positions` (checkpointed `tokensOwed` — under-states)                                                                                                          |
| `settle`                | `swapId, opts?: { hintRoundId? }`                                                                                      | `Hex` (txHash)                            | **W**                   | Core `swaps` (recover expiry), Chainlink feed round-walk if no hint, Core `settle(swapId, hintRoundId)`                                                                           |
| `autoProtect`           | `AutoProtectOptions { owner, minV0?, durations?, maxPremium?, slippageBps?, protectedTokenIds?, scanLimit?, dryRun? }` | `AutoProtectResult[]`                     | **W** (unless `dryRun`) | orchestrates `listEligiblePositions`→`previewPremium`→`buyProtection`; scans `swaps` for ACTIVE                                                                                   |

`PreviewResult`: `{ marketId, maxIL, fairPremium, fairRateWad, sigmaRefWad, premiumA, premiumB?, best, path:'A'|'B' }`. `ProtectionStatus.status`: `0=UNINITIALIZED, 1=ACTIVE, 2=SETTLED`; carries `isPathA = (mm == convexityVault)`, `ilToDate: Priceable<{ il, payout, capHit }>`, `noBadDebtFull: true`.

### DepositorClient (`packages/sdk/src/depositor.ts`) — claim B

Defaults: `vaultAddress = core.convexityVault`, `usdcAddress = demoUsdc`, `sigmaToken = demoWeth`.

| Method                  | Args                                               | Returns                                                     | R/W            | Contract fn(s)                                                                                  |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `getLoadParams`         | —                                                  | `LoadParams` (cached)                                       | R              | Core `loadParams`                                                                               |
| `getVaultState`         | `opts?: { marketIds? }`                            | `Degraded<VaultState>`                                      | R              | ConvexityVault `inventory`/`seniorAssets`/`juniorAssets`/`lockedByMarket`, VolOracle `sigmaRef` |
| `getPosition`           | `owner`                                            | `Degraded<DepositorPosition>`                               | R              | ConvexityVault `senior/juniorBalanceOf`/`senior/juniorWithdraw`/`convertToAssets`               |
| `convertToAssets`       | `tranche, shares`                                  | `bigint`                                                    | R              | ConvexityVault `convertToAssets`                                                                |
| `getWithdrawalCooldown` | —                                                  | `bigint` (seconds)                                          | R              | ConvexityVault `withdrawalCooldown`                                                             |
| `getRegime`             | —                                                  | `{ available, regime, sigmaRefWad } \| { available:false }` | R              | VolOracle `sigmaRef`, Core `loadParams`                                                         |
| `watchUtilization`      | `thresholdWad, handlers, opts?: { intervalMs? }`   | `() => void` (stop)                                         | R (poll)       | ConvexityVault `utilizationWad`                                                                 |
| `buildDeposit`          | `tranche, amount`                                  | `{ to, data, value }`                                       | build          | ConvexityVault `deposit` calldata                                                               |
| `buildApprove`          | `amount`                                           | `{ to, data, value }`                                       | build          | ERC20 `approve(vault, amount)` calldata                                                         |
| `deposit`               | `tranche, amount, opts?: { autoApprove?, owner? }` | `WriteResult`                                               | **W**          | ERC20 `allowance`/`approve` (if autoApprove), ConvexityVault `deposit`                          |
| `requestWithdrawal`     | `tranche, shares`                                  | `WriteResult`                                               | **W**          | ConvexityVault `requestWithdrawal`                                                              |
| `withdraw`              | `tranche`                                          | `WriteResult`                                               | **W**          | ConvexityVault `withdraw` (reverts `JuniorBelowLocked` → error WriteResult)                     |
| `rebalance`             | `from, to, shares`                                 | `StagedWrite`                                               | **W** (staged) | step1 `requestWithdrawal` (sent); step2 `withdraw` + step3 `deposit` returned **unsent**        |

`Tranche = 'senior' | 'junior'`. `WriteResult = { tx, txHash?, status:'sent'|'deferred-no-wallet'|'error', detail? }`.

### MmClient (`packages/sdk/src/mm.ts`) — Path-B

Defaults: `coreAddress = core.inflexionCore`, `npmAddress = npm`, `chainId = 421614`.

| Method                 | Args                                                                                                 | Returns                                                                     | R/W              | Contract fn(s)                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `getLoadParams`        | —                                                                                                    | `LoadParams` (cached)                                                       | R                | Core `loadParams`                                                                                                                     |
| `getMarketConfig`      | `marketId`                                                                                           | `MarketConfig \| undefined`                                                 | R                | Core `markets`                                                                                                                        |
| `getMarketPricing`     | `marketId, geometry: PricingGeometry`                                                                | `MarketPricingResult`                                                       | R                | FairValueOracle `fairPremium`, ConvexityVault `inventory`, VolOracle `sigmaRef`                                                       |
| `getPoolLoadToBeat`    | `marketId`                                                                                           | `PoolLoadTick`                                                              | R                | ConvexityVault `inventory`, VolOracle `sigmaRef`                                                                                      |
| `streamPoolLoadToBeat` | `marketIds, onTick, opts?: { intervalMs? }`                                                          | `StreamHandle`                                                              | R (poll)         | as above per market                                                                                                                   |
| `getSigmaRef`          | `token`                                                                                              | `bigint \| undefined`                                                       | R                | VolOracle `sigmaRef`                                                                                                                  |
| `getSigmaComponents`   | `token`                                                                                              | `SigmaComponents \| undefined`                                              | R                | VolOracle `sigmaComponents`                                                                                                           |
| `getPositionGeometry`  | `tokenId, durationSeconds`                                                                           | `{ priceable:true, geometry, marketId, config } \| { priceable:false }`     | R                | NPM `positions`, TickMath, OracleManager `getPrice`, Core `oracleDerivedSqrtPriceX96`, ILMath `getAmountsForLiquidity`/`computeMaxIL` |
| `getBook`              | `mm, opts?: { fromSwapId?, swapIds?, withGreeks? }`                                                  | `BookResult`                                                                | R                | Core `nextSwapId`/`swaps`; ILMath greeks if requested                                                                                 |
| `greeksForSwap`        | `swapId`                                                                                             | `Greeks \| undefined`                                                       | R                | finite-diff ILMath over ±1% P0                                                                                                        |
| `isQuoteFilled`        | `mm, nonce`                                                                                          | `NonceStatus` (coarse)                                                      | R                | Core `isNonceUsed`                                                                                                                    |
| `watchFills`           | `mm, onFill, opts?: { intervalMs?, fromBlock?, onError? }`                                           | `StreamHandle`                                                              | R (log poll)     | `SwapCreated` logs by mm (coarse attribution)                                                                                         |
| `capacityRemaining`    | `quoteId, maxNotionalV0`                                                                             | `{ available, remaining, consumed, max, exhausted } \| { available:false }` | R                | Core `consumedNotional` (I7)                                                                                                          |
| `getMmCollateral`      | `mm`                                                                                                 | `{ deposited, locked, available } \| undefined`                             | R                | UnderwriterVault `deposited`/`locked`/`availableBalance`                                                                              |
| `signQuote`            | `privateKey, quote: SignedQuote, opts?: { requirePoolCheck?, verifyingContract?, chainId? }`         | `SignQuoteResult`                                                           | **sign** (no tx) | EIP-712 (§4); guards I10 `loadBps ≤ maxLoadBps` + below-pool-load                                                                     |
| `quoteStream`          | `QuoteStreamOptions { privateKey, marketId, build, publish?, onQuote?, onError?, intervalMs?, ... }` | `StreamHandle`                                                              | sign loop        | reads pool load, builds/signs/publishes each tick                                                                                     |
| `cancelNonces`         | `nonces: bigint[]`                                                                                   | `Hex` (txHash)                                                              | **W**            | Core `cancelNonces` (throws `no-signer` w/o wallet)                                                                                   |
| `buildCancelNoncesTx`  | `nonces: bigint[]`                                                                                   | `{ to, data, value }`                                                       | build            | Core `cancelNonces` calldata (external signer)                                                                                        |

Utils (exported): `encodeNonce(word, bit) = (word<<8)|bit`; `decodeNonce(nonce) = { word: nonce>>8, bit: nonce & 0xff }`; `wadToBps(wad) = wad*10000/1e18`.

### DataClient (`packages/sdk/src/data.ts`) — data moat

| Method                  | Args                                     | Returns                             | R/W | Source / status                                                                                                                                        |
| ----------------------- | ---------------------------------------- | ----------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCurrentLoadSurface` | `{ markets: { marketId, geometry? }[] }` | `LoadSurface`                       | R   | **LIVE** RPC multicall (Core `loadParams`/`markets`, ConvexityVault `inventory`, FairValueOracle `fairPremium`); pool premium via CvammPricing TS port |
| `getSurfaceSigmaRef`    | `token`                                  | `Degraded<{ sigmaRefWad, regime }>` | R   | **LIVE** VolOracle `sigmaRef` + Core `loadParams`                                                                                                      |
| `getLoadSurfaceHistory` | `{ marketId, from?, to?, bucket? }`      | `ApiPending`                        | R   | subgraph `/data/load-surface` — **pending**                                                                                                            |
| `getQuoteCompetition`   | `{ marketId?, from?, to? }`              | `ApiPending`                        | R   | subgraph + engine COMPETITION_LOG `/data/quote-competition` — **pending**                                                                              |
| `getDemandRequests`     | `{ marketId?, from?, to? }`              | `ApiPending`                        | R   | engine DEMAND_LOG (off-chain only) `/data/demand-requests` — **pending by design**                                                                     |
| `getNavHistory`         | `{ from?, to?, bucket? }`                | `ApiPending`                        | R   | subgraph `/pool/nav-history` — **pending**                                                                                                             |
| `getNetGamma`           | `{ marketId? }`                          | `ApiPending`                        | R   | off-chain compute `/data/net-gamma` — **pending**                                                                                                      |

### GreeksEngine + HedgeSuggester (`packages/sdk/src/hedge.ts`) — read-only analytics

| Method                | Args                                                               | Returns                                 | R/W | Source                                                                     |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------- | --- | -------------------------------------------------------------------------- |
| `greeks`              | `position: PositionGeometry, durationSeconds, sigmaRefWad, opts?`  | `Priceable<Greeks>`                     | R   | finite-diff ILMath `computeIL` (δ/γ) + FairValueOracle `fairRate` (vega/θ) |
| `bookGreeks`          | `positions[], opts?`                                               | `{ greeks, counted, skipped }`          | R   | aggregates `greeks`; skips degraded, never throws                          |
| `suggestHedge`        | `HedgeInput, opts?: { venue?, overlayInstrument?, stripStrikes? }` | `HedgeSuggestion`                       | R   | strip (Carr-Madan) + on-chain inverse + delta overlay; carries `caveat`    |
| `suggestHedgeChecked` | `HedgeInput, opts?`                                                | `Priceable<{ suggestion }>`             | R   | as above, explicit envelope                                                |
| `executeOnPanoptic`   | `suggestion`                                                       | `PanopticPlan` (pure, `executed:false`) | R   | never submits tx                                                           |

`Greeks = { delta, gamma, vega, theta }` (numbers). `HedgeSuggestion.caveat` is attached verbatim — the hedge is **approximate and NOT relied upon for I1** (solvency is structural).

---

## 4. SignedQuote EIP-712 signing flow (/underwrite)

Source of truth: `packages/engine/src/quote.ts` (re-exported via `@inflexion/sdk` and `@inflexion/sdk/quote`). The field order + types + domain MUST match `InflexionCore.SIGNED_QUOTE_TYPEHASH` exactly or `createSwap`/`createSwapRouted` rejects the signature.

### Domain (`quote.ts:20-22`)

```ts
{ name: 'Inflexion', version: '1', chainId: 421614n, verifyingContract: core.inflexionCore }
```

### Types (`SignedQuoteTypes`, `quote.ts:25-41`) — field order = struct order

```ts
SignedQuote: [
  { name: 'mm', type: 'address' },
  { name: 'marketId', type: 'bytes32' },
  { name: 'loadBps', type: 'uint16' }, // ≤ loadParams.maxLoadBps (I10)
  { name: 'minMaxILRatioBps', type: 'uint16' },
  { name: 'maxMaxILRatioBps', type: 'uint16' },
  { name: 'quotePrice', type: 'uint128' }, // oracle price MM signed against (Fork-2 band anchor)
  { name: 'priceBandBps', type: 'uint16' },
  { name: 'model', type: 'uint8' }, // CollateralModel: FULL=0, PARTIAL=1
  { name: 'partialRatioBps', type: 'uint16' },
  { name: 'maxNotionalV0', type: 'uint128' },
  { name: 'validUntil', type: 'uint64' }, // absolute ts; on-chain bound now + [5,15]s
  { name: 'quoteId', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' }, // bitmap (word<<8)|bit
]
```

Typehash pre-image (`SIGNED_QUOTE_TYPE_STRING`, `quote.ts:44`):
`SignedQuote(address mm,bytes32 marketId,uint16 loadBps,uint16 minMaxILRatioBps,uint16 maxMaxILRatioBps,uint128 quotePrice,uint16 priceBandBps,uint8 model,uint16 partialRatioBps,uint128 maxNotionalV0,uint64 validUntil,bytes32 quoteId,uint256 nonce)`

### Helpers (exported, `quote.ts`)

- `signQuote(privateKey, quote, chainId, verifyingContract): Promise<QuoteEnvelope>` — **positional args**, builds a viem account from the raw key. **Server/key-based only** — do not use the raw-key path in the browser.
- `mm.signQuote(privateKey, quote, opts?)` — SDK wrapper that **also enforces I10** (`loadBps ≤ maxLoadBps`) and the below-pool-load check; returns `SignQuoteResult { envelope, belowPoolChecked, poolLoadBps?, i10Ok:true }`; throws `MmQuoteError` (`i10-exceeded` / `not-below-pool` / `pool-load-unreadable`).
- `quoteDigest(quote, chainId, verifyingContract): Hex` — the on-chain digest `_hashTypedDataV4(hashQuote(q))`.
- `verifyQuote(env, chainId, verifyingContract): Promise<boolean>` / `recoverQuoteSigner(...)`.

### Browser (wagmi) signing — recommended for /underwrite

No private key in the browser. Sign with the connected wallet, then enforce I10 yourself (mirror `mm.signQuote` guards):

```ts
import { SignedQuoteTypes, quoteDomain } from '@inflexion/sdk'
import { core, CHAIN_ID } from '@inflexion/sdk'

// 1. enforce I10 + below-pool BEFORE signing
const params = await mm.getLoadParams()
if (quote.loadBps > params.maxLoadBps) throw new Error('i10-exceeded')
const pool = await mm.getPoolLoadToBeat(quote.marketId)
if (pool.available && quote.loadBps >= Number(pool.totalLoadBps)) throw new Error('not-below-pool')

// 2. sign via wagmi walletClient (EIP-712)
const signature = await walletClient.signTypedData({
  account: walletClient.account,
  domain: quoteDomain(CHAIN_ID, core.inflexionCore), // { 'Inflexion', '1', 421614, core }
  types: SignedQuoteTypes,
  primaryType: 'SignedQuote',
  message: quote, // SignedQuote (bigints for uint128/64/256)
})
const envelope = { quote, signature } // → publish to engine WS / hand to LP buyProtection
```

`SignedQuote` bigint fields: `quotePrice`, `maxNotionalV0`, `validUntil`, `nonce`. Small fields (`loadBps`, `*Bps`, `model`) are plain `number`. On the wire (engine), bigints become **decimal strings** (`QuoteWire`) — convert back to `bigint` before re-signing/verifying.

---

## 5. Engine + API reference

### Engine (Path-B relayer) — `NEXT_PUBLIC_ENGINE_URL`

| Surface                   | Shape                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS (`ws[s]://…`)          | MM → `{ type:'quote', quote: QuoteWire, signature }`; server → `{ type:'ack', marketId, loadBps }` or `{ type:'rejected', reason }`. Engine verifies signature + freshness (`validUntil ∈ (now, now+maxValiditySkewS≈60s]`)            |
| `GET /quote?marketId=0x…` | `{ quote: QuoteWire, signature, loadBps, note }` — **cheapest** live quote (lowest `loadBps`, unexpired). SDK consumes this in `previewPremium` / `fetchEngineQuote`. URL built as `${base}/quote?marketId=${marketId}` (`lp.ts:1175`) |
| `POST /telemetry/preview` | body `{ marketId, widthBucket?, distanceBucket?, durationBucket?, previewedPremium? }` → `{ ok, logged }` (latent-demand Signal 4; fire-and-forget, never affects the read)                                                            |
| `GET /health`             | `{ ok, markets, telemetry: { demand, competition } }`                                                                                                                                                                                  |

Engine env/defaults: `PORT=8787`, `CHAIN_ID=421614`, `VERIFYING_CONTRACT=InflexionCore` (from deployment), optional `QUOTE_LOG` / `DEMAND_LOG` / `COMPETITION_LOG` (append-only JSONL).

### API (public REST) — `NEXT_PUBLIC_API_URL`

Response envelope: success `{ available:true, ...data }`; pending `{ available:false, reason:'subgraph-not-deployed'|'subgraph-unreachable'|'rpc-unavailable'|'telemetry-sink-absent', detail, query? }`; 500 `{ available:false, reason:'internal', detail }`. Cache `public, max-age=5`.

| Path                           | Query                                       | Returns                                          | Backed by                                        | Live now? |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ | --------- |
| `GET /health`                  | —                                           | `{ ok, subgraph.configured, live, telemetry }`   | —                                                | yes       |
| `GET /markets`, `/markets/:id` | —                                           | `{ markets }` / `{ market }`                     | subgraph                                         | pending   |
| `GET /pool`                    | `marketIds=0x..,0x..`                       | `{ pool, disclosure }`                           | SDK DepositorClient (RPC)                        | **yes**   |
| `GET /pool/load-surface`       | `marketIds=…`                               | `{ surface, note, disclosure }`                  | SDK DataClient (RPC)                             | **yes**   |
| `GET /pool/nav-history`        | `bucket=day\|hour`                          | `{ snapshots, disclosure }`                      | subgraph                                         | pending   |
| `GET /pricing/preview`         | `marketId=0x..&a=WAD&b=WAD&maxIL=RAW`       | `{ pricing, note }`                              | SDK DataClient (RPC)                             | **yes**   |
| `GET /swaps`, `/swaps/:swapId` | `status=active\|settled&mm=&market=&first=` | `{ swaps }` / `{ swap }`                         | subgraph                                         | pending   |
| `GET /data/load-surface`       | `marketId=0x..`                             | `{ snapshots }`                                  | subgraph                                         | pending   |
| `GET /data/convexity-surface`  | —                                           | `{ buckets }` (Signal 1/2)                       | subgraph                                         | pending   |
| `GET /data/term-structure`     | `width=&distance=`                          | `{ points }` (Signal 3)                          | subgraph                                         | pending   |
| `GET /data/demand-requests`    | `marketId=&since=`                          | `{ realized, latent, latentEnabled }` (Signal 4) | subgraph (realized) + engine DEMAND_LOG (latent) | partial   |
| `GET /data/quote-competition`  | `marketId=&since=`                          | `{ competition, enabled }` (Signal 2)            | engine COMPETITION_LOG                           | pending   |
| `GET /data/net-gamma`          | —                                           | `{ snapshots, protocolState }` (Signal 5)        | subgraph                                         | pending   |
| `GET /data/supply-depth`       | —                                           | `{ activeSwaps }`                                | subgraph                                         | pending   |
| `GET /mm/:address/fills`       | —                                           | `{ marketMaker, swaps }`                         | subgraph                                         | pending   |
| `GET /sigma/:token/history`    | —                                           | `{ points }`                                     | subgraph                                         | pending   |

API server env: `PORT=8088`, `SUBGRAPH_URL` (absent → queries pending), `ARBITRUM_SEPOLIA_RPC`/`SEPOLIA_RPC`, `DEMAND_LOG`, `COMPETITION_LOG`.

---

## 6. Gotchas

1. **ERC-20 approvals + spender.** Premiums and collateral are paid in **dUSDC** (`tokens.demoUsdc`).
   - **buyProtection** (default `approve:true`): SDK auto-sends NPM `approve(core, tokenId)` **and** dUSDC `approve(core.inflexionCore, maxPremium)` — spender is **InflexionCore**.
   - **deposit** (`autoApprove:true`): SDK checks `allowance` then sends dUSDC `approve(core.convexityVault, amount)` — spender is **ConvexityVault**, not Core.
   - UnderwriterVault collateral (MM) is a separate approve+deposit.
2. **Decimals.** dUSDC and USDC are **6 decimals** — every `maxPremium`, `amount`, `V0`, `maxIL`, collateral figure is 6-dec raw (`1 dUSDC = 1_000_000n`). dWETH is 18. Chainlink feeds are 8. WAD (1e18) is used for ratios (`aWad`, `bWad`, `*Wad`, regime bands).
3. **CvammPricing is delegatecall-only.** `libs.cvammPricing` exposes public library functions intended for delegatecall from Core — **do not `eth_call` it directly**. Use the SDK **TS port** (`import * as cvamm from '@inflexion/sdk'` → `cvamm.totalLoadWad`, `cvamm.premiumFromLoad`, `cvamm.pathBPremium`), which is parity-locked to the deployed Solidity. The SDK already does this in `previewPremium`, `getMarketPricing`, and `getCurrentLoadSurface`.
4. **Subgraph-pending degradation.** Events are live on-chain since the deploy block but the subgraph isn't indexed yet. Anything historical/aggregate (DataClient history methods, most API `/data/*`, `/markets`, `/swaps`, `/pool/nav-history`, MM `QuoteFilled` precise fill attribution) returns `{ available:false, reason:'subgraph-not-deployed', ... }`. **Render the pending state, not an error.** Live paths that work today: current load surface, σ_ref, market pricing, vault state, protection status, position geometry, `getBook` (on-chain scan), `watchFills` (coarse). Position discovery without the subgraph = on-chain swap scan (`scanLimit` / `nextSwapId`).
5. **Fill attribution is coarse on-chain.** `isNonceUsed` cannot distinguish FILLED from CANCELLED (`NonceStatus.precision = 'coarse'`); `watchFills` polls `SwapCreated`. Precise per-quote attribution needs the `QuoteFilled` event → subgraph.
6. **`getClaimableFees` under-states.** It reads checkpointed `tokensOwed` only; live-uncollected fees need the subgraph. Label it accordingly.
7. **In-range / MaxIL framing (load-bearing, never drop the qualifier).** This is an **in-range convexity hedge**, not "IL insurance." Entry requires `Pa ≤ P0 ≤ Pb` (out-of-range positions are rejected at creation). Payout is `min(realized_IL, MaxIL)` — the **cap is load-bearing** for the no-bad-debt guarantee. Only claim "bad debt impossible" with the full clause: **FULL mode, capped payoff, solvent USDC, oracle/settlement liveness** (`ProtectionStatus.noBadDebtFull`). Depositor capital is **NOT guaranteed** (junior first-loss / senior systemic-tail) — always surface `capitalNotGuaranteed: true`.
8. **Writes degrade, never crash at construction.** No `walletClient` → LP/MM writes throw a clear error on call; DepositorClient returns `WriteResult { status:'deferred-no-wallet', tx }` so you can hand the unsigned tx to an external signer. Gate write buttons on `useAccount().isConnected`.
