# 05 — The Inflexion SDK (`@inflexion/sdk`)

> Source-of-truth KB entry for the public docs + founder judge-prep. Every technical
> claim cites `file:line`. Live deployment: **Arbitrum Sepolia (chainId 421614)**,
> fresh full redeploy **2026-06-05** at block **274081134**
> (`deployments/arbitrum-sepolia.json:38-41`). The subgraph deploy is pending, so
> all history/aggregate surfaces degrade to a typed pending state — never an error.

---

## 0. What the SDK *is*, and why it exists

`@inflexion/sdk` is the typed access layer over the live deployment. It is the
**only layer that holds a signer** and the only one that can answer the load-bearing
question: _"what dollar premium will I be charged on THIS position if I sign in the
next block?"_ — a fresh on-chain `FairValueOracle` read plus the position's geometry
(`packages/sdk/src/index.ts:1-9`).

Two design properties run through the whole package and you must repeat them in any
docs/Q&A:

1. **Reads are graceful.** Anything that needs a reverting oracle, an absent rich
   event, or the not-yet-deployed subgraph returns a **typed degraded envelope**
   (`{ available:false, reason }` / `{ priceable:false, reason }` /
   `precision:'coarse'`), **never throws** (`types.ts:17-48`, `index.ts:5-8`).
2. **Writes degrade, never crash at construction.** With no `walletClient`, LP/MM
   writes throw a *clear error on call* (the one place a missing signer is a hard
   error), and DepositorClient returns `WriteResult { status:'deferred-no-wallet' }`
   carrying the unsigned tx for an external signer (`lp.ts:1222-1229`,
   `depositor.ts:559-577`).

The SDK is the *foundation* (addresses, ABIs, viem client factory, shared types,
tuple decoders, `resolveMarket`, the `CvammPricing` TS port under `cvamm`) **plus**
five stakeholder surfaces **plus** the re-exported EIP-712 quote helpers
(`index.ts:10-18, 30-53`).

### The three pillars the SDK surfaces (the "why")

- **On-chain FairValue** — an exact closed-form Φ-sum, the Stylus `FairValueOracle`
  (`fairPremium`/`fairRate`). **Never reimplemented off-chain** (`lp.ts:11-14`,
  `mm.ts:9-11`). The SDK *reads* it; it only re-evaluates the deterministic, `pure`
  **load** stack client-side via the parity-locked TS port (the single permitted
  duplication — see §8).
- **The cvAMM pool (Path A)** — always-on, signature-free underwriter
  (`ConvexityVault`). This is the depositor surface.
- **MM competition (Path B)** — firm EIP-712 signed quotes, **no last look**
  (`mm.ts` + `quote.ts`). `createSwapRouted` gives the LP the **cheaper of pool vs
  MM** (`lp.ts:656-716`).

---

## 1. `createInflexionSdk(config)` — the one-call factory

`createInflexionSdk(config: InflexionSdkConfig = {}): InflexionSdk` wires one public
(read) client + one optional wallet (write) client into all five surfaces at once
(`index.ts:121-174`). **No address is ever passed in** — every contract address loads
from `deployments/arbitrum-sepolia.json` via `addresses.ts` (CLAUDE.md hard rule;
`index.ts:117-119`, `addresses.ts:1-10`).

### 1.1 Every config field (`InflexionSdkConfig`, `index.ts:60-81`)

| Field | Type | Purpose |
| --- | --- | --- |
| `rpcUrl` | `string?` | Explicit RPC URL; falls back to env then chain default public RPC. |
| `transport` | `Transport?` | Inject a custom transport (e.g. a test mock). **Overrides `rpcUrl`.** |
| `publicClient` | `PublicClient?` | A pre-built read client. **Overrides `rpcUrl`/`transport`.** |
| `walletClient` | `WalletClient?` | A pre-built write client. **Overrides `privateKey`/`account`.** |
| `privateKey` | `Hex?` | Raw signer key for writes; falls back to env. Absent ⇒ writes deferred. |
| `account` | `Account?` | A pre-built viem account for writes. **Overrides `privateKey`.** |
| `engineBaseUrl` | `string?` | Engine base for Path-B quotes + the `previewPremium` telemetry ping. |
| `telemetryUrl` | `string?` | Override the telemetry endpoint (default `${engineBaseUrl}/telemetry/preview`). |
| `fetchImpl` | `typeof fetch?` | Injected fetch (tests). Defaults to global `fetch` when present. |
| `chainId` | `number?` | EIP-712 chain id for quote signing (defaults to the live chain, `421614`). |

### 1.2 Resolution order (the graceful-degradation contract, `index.ts:121-138`)

- **Read client:** `config.publicClient` ?? `makePublicClient({ rpcUrl, transport })`.
  `rpcUrl` falls back to `process.env.ARBITRUM_SEPOLIA_RPC` → `SEPOLIA_RPC` → the
  chain's default public RPC (`client.ts:30-33, 53-56`).
- **Write client:** `config.walletClient` ?? `makeWalletClient({ account, privateKey,
  transport, rpcUrl })`. `makeWalletClient` **returns `undefined`** when no signer is
  available (no account, no key arg, no env key) — the SDK then degrades every write
  rather than crashing (`client.ts:72-77`, `index.ts:129-136`).
- Env key fallback for writes: `DEPLOYER_PRIVATE_KEY` → `PRIVATE_KEY`
  (`client.ts:36-39`).
- `chainId = config.chainId ?? CHAIN_ID` (= `421614`, `index.ts:138`,
  `addresses.ts:13`).

### 1.3 What the factory returns (`InflexionSdk`, `index.ts:83-104, 163-173`)

`{ publicClient, walletClient?, chainId, lp, depositor, mm, data, greeks, hedge }`.
Only `lp` receives `engineBaseUrl`/`telemetryUrl`/`fetchImpl`; only `mm` receives
`chainId`; `depositor`/`data`/`greeks`/`hedge` get just the clients
(`index.ts:140-161`).

### 1.4 Two instantiation modes

**(a) Browser / wagmi — inject pre-built viem clients** (recommended; avoids a second
RPC). Pattern lives in `apps/web/INTEGRATION_MAP.md:38-62`:

```ts
// apps/web/lib/use-sdk.ts
'use client'
import { useMemo } from 'react'
import { usePublicClient, useWalletClient, useAccount } from 'wagmi'
import { createInflexionSdk, type InflexionSdk } from '@inflexion/sdk'

export function useInflexionSdk(): InflexionSdk {
  const publicClient = usePublicClient()             // reads
  const { data: walletClient } = useWalletClient()   // writes (undefined until connected)
  const { address } = useAccount()

  return useMemo(
    () =>
      createInflexionSdk({
        publicClient,                                  // overrides rpcUrl/transport
        ...(walletClient ? { walletClient } : {}),     // omit → writes throw a clear error on call
        chainId: 421614,                               // EIP-712 chainId for quote signing
        engineBaseUrl: process.env.NEXT_PUBLIC_ENGINE_URL,
        fetchImpl: fetch,
      }),
    [publicClient, walletClient, address],
  )
}
```

`walletClient.account` is used directly — wagmi's `useWalletClient()` already carries
`.account` and `.chain`; pass no explicit `account` (`INTEGRATION_MAP.md:68`).

**(b) Server / key-based — let the SDK build the clients from env or explicit key:**

```ts
import { createInflexionSdk } from '@inflexion/sdk'

const sdk = createInflexionSdk({
  rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC,
  privateKey: process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`, // → funded write client
  engineBaseUrl: process.env.ENGINE_URL,
})
// sdk.lp / sdk.depositor / sdk.mm / sdk.data / sdk.greeks / sdk.hedge are all wired.
```

With **no args at all**, the SDK still constructs: env-resolved RPC + key, and
graceful degradation if either is absent (`index.ts:57-59`).

---

## 2. Addresses, decimals, units (`addresses.ts`)

Import from the SDK — **never hardcode** (`addresses.ts:1-8`):

```ts
import { core, stylus, libs, tokens, demo, chainlink, uniswap, npm, CHAIN_ID } from '@inflexion/sdk'
```

| Symbol | Address | Role |
| --- | --- | --- |
| `core.inflexionCore` | `0xC19865cF8403F59B8Eca835833aFEe3Aa8DA4848` | State machine; **EIP-712 `verifyingContract`** (`addresses.ts:23`) |
| `core.convexityVault` | `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d` | Path-A pooled underwriter; also `swap.mm` when Path A (`addresses.ts:35`) |
| `core.underwriterVault` | `0x4Fb459F3393D206c2b7faD7f0fC9C35a78348D64` | Per-MM Path-B collateral (`addresses.ts:33`) |
| `core.oracleManager` | `0x2c18147B6ec75dcb330d9A48B6B96a4d1a8b529b` | Live price; **reverts** on stale/seq-down (`addresses.ts:25`) |
| `core.volOracle` | `0xfdEafBB381192FC5337499d041eaead04d565Ed9` | σ_ref EWMA; `sigmaRef` reverts if uninitialised (`addresses.ts:27`) |
| `core.ilMath` | `0x7e90362bc6Df9cb5faA13952e07853ab16c77bd2` | IL math (`computeIL`/`computeMaxIL`/`getAmountsForLiquidity`) (`addresses.ts:29`) |
| `stylus.fairValueOracle` | `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c` | Stylus Φ-sum — **never reimplemented** (`addresses.ts:43`) |
| `libs.tickMath` | `0xbf02bbc82e0fb1a4b9828bb90fc9dd9e97578965` | tick → sqrtPriceX96 (`addresses.ts:49`) |
| `libs.cvammPricing` | `0x4a053d29a55a64172140f9ebbc27c321c0ba2b53` | **delegatecall-only** load stack (`addresses.ts:51`) |
| `npm` (Uniswap NPM) | `0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65` | `positions(tokenId)`, ownership enumeration (`addresses.ts:70`) |
| `tokens.demoUsdc` | `0xB89630Dc6e020ae2A84aE72b7d9EEDBDfb2C544d` | **numéraire, 6 decimals** (all premiums/collateral) (`addresses.ts:88`) |
| `tokens.demoWeth` | `0xA8C07E1B245B346c5D1910c5055Efe67bF9E7D1D` | demo volatile token (18 dec) (`addresses.ts:85`) |
| `demo.marketId_fee500_7d` | `0x67c4bee1…6479d69` | demo fee-500 7-day market (`addresses.ts:100`) |
| `demo.lpPositionTokenId` | `3218` | seeded UNPROTECTED LP NFT for previews (`addresses.ts:98`) |
| `chainlink.ethUsd` | `0xd30e2101…7A35165` | real ETH/USD feed (8-dec) the demo prices dWETH against (`addresses.ts:60`) |

### Decimals & units (load-bearing — `types.ts:12-15`, `INTEGRATION_MAP.md:311`)

- **dUSDC / USDC = 6 decimals** — every `maxPremium`, `amount`, `V0`, `maxIL`,
  collateral figure is **6-dec raw bigint** (`1 dUSDC = 1_000_000n`). dWETH = 18.
  Chainlink feeds = 8.
- **WAD = 1e18** for ratios (`aWad`, `bWad`, `*Wad`, σ_ref, regime bands,
  load components). `math.ts:19`.
- `sqrtPriceX96` is the Uniswap Q64.96 sqrt price. Conversions:
  `cvamm.abFromSqrt(sqrtP0, sqrtPa, sqrtPb)` → `{aWad, bWad}` where
  `a = (sqrtPa/sqrtP0)²`, `b = (sqrtPb/sqrtP0)²` (`math.ts:152-160`);
  `sqrtToPriceWad(sqrtPX96)` → price (WAD) = `(sqrtP/2^96)² · 1e18` (`lp.ts:1358-1362`).

---

## 3. The 5 surfaces — concept map

| Surface | Class | Claim it carries | Default writes spender |
| --- | --- | --- | --- |
| **LpClient** (`lp.ts`) | LP buys IL protection (claim A) | `noBadDebtFull: true` (qualified) | **InflexionCore** (`buyProtection`) |
| **DepositorClient** (`depositor.ts`) | passive/active underwriter (claim B) | `capitalNotGuaranteed: true` | **ConvexityVault** (`deposit`) |
| **MmClient** (`mm.ts`) | Path-B market making | (sign-only + cancel) | **InflexionCore** (`cancelNonces`); collateral is a separate UnderwriterVault flow |
| **DataClient** (`data.ts`) | the data moat | — (read-only) | none |
| **GreeksEngine + HedgeSuggester** (`hedge.ts`) | read-only analytics | — (read-only) | none (never sends a tx) |

**Claims are NEVER merged.** Claim (A) "LPs are always paid — no bad debt in FULL
(I1), qualified by capped payout + solvent USDC + oracle/settlement liveness" lives on
the LP surface only (`depositor.ts:66-69`). Claim (B) "depositor capital is NOT
guaranteed (junior first-loss; senior protected from underwriting loss only, takes the
systemic tail)" lives on the depositor surface only (`depositor.ts:57-61`). Both are
exported verbatim as `LP_CLAIM_A` / `DEPOSITOR_CLAIM_B`.

---

## 4. LpClient — buying in-range IL protection (claim A)

Source: `packages/sdk/src/lp.ts`. Every read needing P0 catches an `OracleManager.getPrice`
revert and returns `NotPriceable { priceable:false, reason:'oracle-degraded' }` rather
than throwing (`lp.ts:103-124, 307-319`).

### 4.1 Method reference

| Method | Args | Returns | R/W | Contract fn(s) | Degradation |
| --- | --- | --- | --- | --- | --- |
| `getLoadParams` | — | `LoadParams` (cached) | R | Core `loadParams` (`lp.ts:218-243`) | throws on no-RPC (cached after first) |
| `resolveGeometry` | `tokenId, marketId` | `Priceable<{ geometry: LpGeometry }>` | R | NPM `positions`, Core `markets`/`oracleDerivedSqrtPriceX96`, TickMath, OracleManager `getPrice`, ILMath `computeMaxIL`/`getAmountsForLiquidity` (`lp.ts:255-367`) | `market-unknown` / `position-unknown` / `oracle-degraded` |
| `listEligiblePositions` | `owner, opts?{durations?}` | `EligiblePosition[]` | R | NPM `balanceOf`/`tokenOfOwnerByIndex`/`positions`, then `resolveGeometry` per (pos × duration) (`lp.ts:383-459`) | empty array on no-NPM; per-row `inRange:undefined` if oracle degraded |
| `previewPremium` | `tokenId, marketId, opts?{poke?, engineBaseUrl?}` | `Priceable<PreviewResult>` | R (+opt poke W) | FVO `fairPremium`, ConvexityVault `inventory`, Core `loadParams`/`markets`; engine `GET /quote`; TS-port load; opt `VolOracle.poke` (`lp.ts:483-582`) | `NotPriceable` if oracle degraded; Path B silently absent if engine unreachable |
| `getPayoffCurve` | `tokenId, marketId, opts?{points?}` | `Priceable<PayoffCurve>` | R | ILMath `computeIL` over a sqrt-price grid (`lp.ts:597-652`) | `NotPriceable` if oracle degraded |
| `buyProtection` | `BuyProtectionParams` | `Hex` (txHash) | **W** | NPM `approve`, dUSDC `allowance`/`approve`, Core `createSwapRouted` / `createSwapPathA` / `createSwap` (`lp.ts:668-716`) | throws clear error if no wallet |
| `getProtectionStatus` | `swapId` | `ProtectionStatus \| {available:false,reason}` | R | Core `swaps` + `settlePreview` (via `simulateContract`), OracleManager `getPrice`, Core `oracleDerivedSqrtPriceX96` (`lp.ts:771-862`) | `available:false` on unknown swap; `ilToDate` is itself `Priceable` |
| `getClaimableFees` | `swapId` | `ClaimableFees \| {available:false}` | R | Core `swaps`, NPM `positions` (checkpointed `tokensOwed0/1`) (`lp.ts:877-904`) | UNDER-states; precise needs subgraph |
| `settle` | `swapId, opts?{hintRoundId?}` | `Hex` (txHash) | **W** | Core `swaps` (recover expiry), Chainlink round-walk if no hint, Core `settle(swapId, hintRoundId)` (`lp.ts:915-993`) | throws clear error if no wallet |
| `autoProtect` | `AutoProtectOptions` | `AutoProtectResult[]` | **W** (unless `dryRun`) | orchestrates list→preview→buy; scans `swaps`/`nextSwapId` for ACTIVE dedupe (`lp.ts:1010-1135`) | per-row `skipped`/`error` rows; never throws |
| `poke` | `token` | `Hex` (txHash) | **W** | `VolOracle.poke(token)` (`lp.ts:1140-1151`) | throws if no wallet |
| `findHintRoundId` | `oracleToken, expiry, opts?{maxWalk?}` | `bigint` | R | Chainlink `latestRoundData`/`getRoundData` backwards walk (`lp.ts:952-993`) | returns best round on un-fetchable phase boundary |

**`LpGeometry`** (`lp.ts:128-147`): `{ tokenId, token0, token1, fee, tickLower,
tickUpper, liquidity, sqrtPaX96, sqrtPbX96, sqrtP0X96, aWad, bWad, amount0Entry,
amount1Entry, maxIL, inRange }`. `inRange = sqrtP0 >= sqrtPa && sqrtP0 <= sqrtPb` — the
`createSwap` in-range gate (`lp.ts:329`).

**`PreviewResult`** (`types.ts:163-176`): `{ marketId, maxIL, fairPremium, fairRateWad,
sigmaRefWad, premiumA, premiumB?, best, path:'A'|'B' }`. `premiumB`/`path:'B'` present
only when an MM quote beat the pool.

**`ProtectionStatus`** (`types.ts:228-247`): carries `status` (0=UNINITIALIZED,
1=ACTIVE, 2=SETTLED), `isPathA = (mm == convexityVault)` (`lp.ts:792`),
`ilToDate: Priceable<{ il, payout, capHit }>` (where `capHit = payout < il`,
`lp.ts:856`), and `noBadDebtFull: true`.

### 4.2 How premium is computed (the mechanics — `lp.ts:483-549`)

1. **Path A (the load-bearing on-chain read):** `FairValueOracle.fairPremium(token,
   aWad, bWad, durationSeconds, maxIL)` → `(premium, fairRateWad, sigmaRefWad)`
   (`lp.ts:518-526`, ABI `abis.ts:499-516`). The Φ-sum is never reimplemented.
2. Read `ConvexityVault.inventory()` → `(total, locked, free, util, conc)` and
   `loadParams()` (`lp.ts:529-537`).
3. Finish the **load stack client-side** with the parity-locked TS port:
   `totalLoad = cvamm.totalLoadWad(sigmaRef, util, conc, params)`, then
   `premiumA = cvamm.premiumFromLoad(fairPremium, totalLoad)` capped at MaxIL — this
   is exactly `_pricePathAFromFair` on-chain (`lp.ts:540-542`, `math.ts:118-131`).
4. **Path B (best-effort):** `GET ${engineBaseUrl}/quote?marketId=…` for the cheapest
   live signed MM quote; `premiumB = cvamm.pathBPremium(fairPremium, loadBps, maxIL) =
   ceil(fairPremium·(1+loadBps/BPS))` capped at the SAME MaxIL (`lp.ts:544-549`,
   `math.ts:133-137`). An absent/unreachable engine leaves `premiumB` undefined and
   routes Path A — never an error (`lp.ts:1167-1188`).
5. `best`/`path` = the cheaper of the two (`lp.ts:551-552`).
6. A **fire-and-forget telemetry ping** (latent-demand Signal 4) is sent — never
   awaited into the result, never throws (`lp.ts:1190-1220`).

### 4.3 Approvals (the spender is **InflexionCore**, `lp.ts:718-757`)

When `buyProtection` runs with `approve` not explicitly false (default true), the SDK
sends **two** approvals before the create call:

- NPM `approve(core.inflexionCore, tokenId)` — the position NFT to the core
  (`lp.ts:721-734`).
- dUSDC: read `allowance(account, core.inflexionCore)`; if `< maxPremium`, send
  `approve(core.inflexionCore, maxPremium)` — **spender is InflexionCore**
  (`lp.ts:736-756`).

### 4.4 Which create call fires (`lp.ts:687-716`)

| `escapeHatch` | Contract fn | Notes |
| --- | --- | --- |
| `undefined` (default) | `createSwapRouted(quoteTuple, signature, tokenId, maxPremium)` | best-of {pool, MM}. A missing quote uses the **EMPTY_QUOTE sentinel** (`mm == address(0)`, empty signature) so the router falls back to the pool (`lp.ts:707-715, 1305-1322`). |
| `'A'` | `createSwapPathA(marketId, tokenId, maxPremium)` | force the always-on pool (`lp.ts:692-698`). |
| `'B'` | `createSwap(quoteTuple, signature, tokenId, maxPremium)` | force a specific signed MM quote; requires `{quote, signature}` or throws (`lp.ts:699-706, 1237-1242`). |

`maxPremium` is the LP's slippage guard (numéraire raw, 6-dec). The on-chain create
reverts if the routed premium would exceed it.

### 4.5 Worked example — buy protection (routed, best-of)

```ts
import { createInflexionSdk, demo, tokens } from '@inflexion/sdk'

const sdk = createInflexionSdk({ publicClient, walletClient, engineBaseUrl })
const lp = sdk.lp

// 1. Price it (Path A pool + best engine MM quote, capped at MaxIL).
const preview = await lp.previewPremium(demo.lpPositionTokenId, demo.marketId_fee500_7d)
if (!preview.priceable) throw new Error(`not priceable: ${preview.reason}`)
console.log(preview.best, preview.path)        // e.g. 8_930_000n (=$8.93), 'B'

// 2. maxPremium = best + 1% slippage (raw 6-dec; round up).
const maxPremium = (preview.best * 10_100n) / 10_000n + 1n

// 3. Buy (default approvals: NPM approve + dUSDC approve to InflexionCore).
const txHash = await lp.buyProtection({
  tokenId: demo.lpPositionTokenId,
  marketId: demo.marketId_fee500_7d,
  maxPremium,
  // omit quote/signature → createSwapRouted picks the cheaper of pool vs MM on-chain
})

// 4. Later, after expiry: settle (round-walk finds the bracketing Chainlink round).
const settleTx = await lp.settle(/* swapId */ 2n)
```

To route a *specific* MM quote (Path B), pass `{ quote, signature, escapeHatch:'B' }`
where `quote` is the `SignedQuote` and `signature` the EIP-712 sig (§6).

---

## 5. DepositorClient — passive/active underwriting (claim B)

Source: `packages/sdk/src/depositor.ts`. Defaults: `vaultAddress = core.convexityVault`,
`usdcAddress = tokens.demoUsdc`, `sigmaToken = tokens.demoWeth`
(`depositor.ts:120-129, 603-612`). Every state/yield result carries
`capitalNotGuaranteed: true` (`depositor.ts:254, 307`).

### 5.1 Method reference

| Method | Args | Returns | R/W | Contract fn(s) | Degradation |
| --- | --- | --- | --- | --- | --- |
| `getLoadParams` | — | `LoadParams` (cached) | R | Core `loadParams` (`depositor.ts:134-145`) | — |
| `getVaultState` | `opts?{marketIds?}` | `Degraded<VaultState>` | R | ConvexityVault `inventory`/`seniorAssets`/`juniorAssets`/`lockedByMarket`, VolOracle `sigmaRef` (`depositor.ts:159-257`) | `no-rpc` / `vol-uninitialized` |
| `getPosition` | `owner` | `Degraded<DepositorPosition>` | R | ConvexityVault `senior/juniorBalanceOf`/`senior/juniorWithdraw`/`convertToAssets` (`depositor.ts:267-323`) | `no-rpc` |
| `convertToAssets` | `tranche, shares` | `bigint` | R | ConvexityVault `convertToAssets` (`depositor.ts:326-334`) | returns 0n for 0 shares |
| `getWithdrawalCooldown` | — | `bigint` (seconds) | R | ConvexityVault `withdrawalCooldown` (`depositor.ts:337-344`) | — |
| `getRegime` | — | `{available, regime, sigmaRefWad} \| {available:false}` | R | VolOracle `sigmaRef`, Core `loadParams` (`depositor.ts:353-371`) | `vol-uninitialized` |
| `watchUtilization` | `thresholdWad, handlers{onTick?,onThreshold?,onError?}, opts?{intervalMs?}` | `() => void` (stop) | R (poll, 12s default) | ConvexityVault `utilizationWad` (`depositor.ts:380-421`) | swallows poll errors → `onError` |
| `buildDeposit` | `tranche, amount` | `{to,data,value}` | build | ConvexityVault `deposit` calldata (`depositor.ts:426-433`) | — |
| `buildApprove` | `amount` | `{to,data,value}` | build | ERC20 `approve(vault, amount)` calldata (`depositor.ts:436-443`) | — |
| `deposit` | `tranche, amount, opts?{autoApprove?,owner?}` | `WriteResult` | **W** | ERC20 `allowance`/`approve` (if autoApprove), ConvexityVault `deposit` (`depositor.ts:450-476`) | `deferred-no-wallet` / `error` |
| `requestWithdrawal` | `tranche, shares` | `WriteResult` | **W** | ConvexityVault `requestWithdrawal` (`depositor.ts:479-486`) | `deferred-no-wallet` |
| `withdraw` | `tranche` | `WriteResult` | **W** | ConvexityVault `withdraw` (reverts `JuniorBelowLocked` → `error` result) (`depositor.ts:493-500`) | surfaces revert as `error` |
| `rebalance` | `from, to, shares` | `StagedWrite` | **W** (staged) | step1 `requestWithdrawal` (sent); steps 2 `withdraw` + 3 `deposit` returned **unsent** across the cooldown (`depositor.ts:515-555`) | — |

`Tranche = 'senior' | 'junior'`; `TRANCHE_ENUM = { senior:0, junior:1 }`
(`types.ts:180-183`). `WriteResult = { tx, txHash?, status:'sent'|'deferred-no-wallet'|'error', detail? }`
(`depositor.ts:74-81`).

**`VaultState`** (`types.ts:185-206`): `totalAssets`, `seniorAssets`, `juniorAssets`,
`totalLocked`, `freeAssets`, `utilWad`, `concWad`, the load decomposition
(`baseLoadWad`/`utilSkewWad`/`dispSkewWad`/`totalLoadWad`), `lockedByMarket` (a colour
map keyed by **caller-supplied** marketIds — free collateral is pool-wide fungible, so
this is HHI/concentration colour, NOT a per-market budget, `depositor.ts:213-235`),
`sigmaRefWad`, `regime`, `instYieldWad?` (subgraph-only → omitted live,
`depositor.ts:252-253`), `capitalNotGuaranteed: true`.

### 5.2 The tranche waterfall (the "why" of claim B)

Junior is **first-loss** and captures most of the premium; senior is structurally
protected from *underwriting* loss only — the on-chain `totalLocked ≤ juniorAssets`
junior-first waterfall — **not** from a systemic tail (USDC depeg, oracle/settlement
failure, contract bug) (`depositor.ts:57-61`). `withdraw` enforces the
`JuniorBelowLocked` gate on-chain so junior can't drain below the locked amount and
break senior protection (`depositor.ts:488-500`). Always render the
`capitalNotGuaranteed` disclosure.

### 5.3 Worked example — deposit to a tranche

```ts
import { createInflexionSdk } from '@inflexion/sdk'

const sdk = createInflexionSdk({ publicClient, walletClient })
const dep = sdk.depositor

// Deposit 10,000 dUSDC (6-dec raw) into the JUNIOR tranche; auto-approve to the vault.
const res = await dep.deposit('junior', 10_000_000_000n, { autoApprove: true })
// res.status === 'sent' | 'deferred-no-wallet' | 'error'

// Read pool + my position (claim B is carried on both).
const state = await dep.getVaultState()           // Degraded<VaultState>
if (state.available) console.log(state.utilWad, state.regime, state.capitalNotGuaranteed)

const me = await dep.getPosition(walletClient.account.address)
if (me.available) console.log(me.juniorShares, me.juniorAssets)

// Withdraw is cooldown-gated: request, wait, then withdraw.
await dep.requestWithdrawal('junior', /* shares */ 5_000_000_000n)
// …after the on-chain withdrawalCooldown elapses:
const w = await dep.withdraw('junior')            // reverts JuniorBelowLocked → status:'error'
```

The deposit spender is **ConvexityVault**, not Core (`depositor.ts:436-443`,
`INTEGRATION_MAP.md:309`).

---

## 6. MmClient — Path-B market making (pricing, quoting, book, fills)

Source: `packages/sdk/src/mm.ts`. Defaults: `coreAddress = core.inflexionCore`,
`npmAddress = npm`, `chainId = 421614` (`mm.ts:204-210`). Caches `loadParams` and per-
market configs (immutable post-freeze, `mm.ts:199-202`).

### 6.1 Method reference

| Method | Args | Returns | R/W | Contract fn(s) |
| --- | --- | --- | --- | --- |
| `getLoadParams` | — | `LoadParams` (cached) | R | Core `loadParams` (`mm.ts:215-225`) |
| `getMarketConfig` | `marketId` | `MarketConfig \| undefined` | R | Core `markets` (`undefined` if `token0 == 0`) (`mm.ts:229-254`) |
| `getMarketPricing` | `marketId, geometry: PricingGeometry` | `MarketPricingResult` | R | **ONE multicall**: FVO `fairPremium` + ConvexityVault `inventory` + VolOracle `sigmaRef`; load via TS port (`mm.ts:268-380`) |
| `getPoolLoadToBeat` | `marketId` | `PoolLoadTick` | R | multicall: `inventory` + `sigmaRef` (geometry-free); TS-port load (`mm.ts:390-457`) |
| `streamPoolLoadToBeat` | `marketIds, onTick, opts?{intervalMs?}` | `StreamHandle` | R (poll, 4s) | per-market `getPoolLoadToBeat` (`mm.ts:465-502`) |
| `getSigmaRef` | `token` | `bigint \| undefined` | R | VolOracle `sigmaRef` (`mm.ts:508-519`) |
| `getSigmaComponents` | `token` | `SigmaComponents \| undefined` | R | VolOracle `sigmaComponents` (`mm.ts:523-540`) |
| `getPositionGeometry` | `tokenId, durationSeconds` | `{priceable:true, geometry, marketId, config} \| {priceable:false, reason}` | R | NPM `positions`, TickMath, OracleManager `getPrice`, Core `oracleDerivedSqrtPriceX96`, ILMath `getAmountsForLiquidity`/`computeMaxIL` (`mm.ts:556-689`) |
| `getBook` | `mm, opts?{fromSwapId?, swapIds?, withGreeks?}` | `BookResult` | R | Core `nextSwapId`/`swaps` scan; ILMath greeks if requested (`mm.ts:725-815`) |
| `greeksForSwap` | `swapId` | `Greeks \| undefined` | R | finite-diff ILMath `computeIL` over ±1% P0 (`mm.ts:824-957`) |
| `signQuote` | `privateKey, quote, opts?{requirePoolCheck?, verifyingContract?, chainId?}` | `SignQuoteResult` | **sign** (no tx) | EIP-712 + I10 + below-pool guards (`mm.ts:973-1017`) |
| `quoteStream` | `QuoteStreamOptions` | `StreamHandle` | sign loop (5s) | reads pool load, builds/signs/publishes each tick (`mm.ts:1034-1072`) |
| `isQuoteFilled` | `mm, nonce` | `NonceStatus` (coarse) | R | Core `isNonceUsed` (`mm.ts:1086-1112`) |
| `watchFills` | `mm, onFill, opts?{intervalMs?, fromBlock?, onError?}` | `StreamHandle` | R (log poll, 6s) | `SwapCreated` logs filtered by `mm` (coarse) (`mm.ts:1123-1186`) |
| `cancelNonces` | `nonces: bigint[]` | `Hex` (txHash) | **W** | Core `cancelNonces` (throws `no-signer` w/o wallet) (`mm.ts:1196-1219`) |
| `buildCancelNoncesTx` | `nonces: bigint[]` | `{to,data,value}` | build | Core `cancelNonces` calldata (`mm.ts:1222-1229`) |
| `capacityRemaining` | `quoteId, maxNotionalV0` | `{available, remaining, consumed, max, exhausted} \| {available:false}` | R | Core `consumedNotional` (I7) (`mm.ts:1236-1269`) |
| `getMmCollateral` | `mm` | `{deposited, locked, available} \| undefined` | R | UnderwriterVault `deposited`/`locked`/`availableBalance` (`mm.ts:1273-1304`) |

Exported utils (`mm.ts:1310-1318, 91-93`): `encodeNonce(word, bit) = (word<<8)|bit`
(bit ∈ [0,255]); `decodeNonce(nonce) = { word: nonce>>8, bit: nonce & 0xff }`;
`wadToBps(wad) = floor(wad·10000/1e18)`.

**`PricingGeometry`** input (`mm.ts:138-150`): `{ aWad, bWad, durationSeconds, maxIL,
oracleToken? }`. **`MmMarketPricing`** result (`mm.ts:109-136`): `fairPremium`,
`fairRateWad`, `sigmaRefWad`, `poolPremium` (= `ceil(fairPremium·(1+totalLoad))` capped
at MaxIL), `maxIL`, `load: LoadBreakdown`, `totalLoadBps`, the per-component
`baseLoadWad`/`utilSkewWad`/`dispSkewWad`, `util`, `conc`, `regime`.

### 6.2 The unit of risk + why an MM quote is per-MARKET, not per-NFT

MaxIL is both (a) the load-bearing cap and (b) the **unit of risk**: pure geometry,
frozen at creation, identical across durations, L-independent in the fair-rate sense —
which makes positions **fungible** to an underwriter within a market. So an MM quote is
**per-market**: a single `loadBps` (a load over the on-chain FairPremium) + a
`[minMaxILRatioBps, maxMaxILRatioBps]` band + `maxNotionalV0` capacity — it is **never
per-NFT**. The geometry-independent "load to beat" is the first-class streamable signal
`getPoolLoadToBeat` / `streamPoolLoadToBeat` (`mm.ts:382-457`): the pure pool floor an
MM must undercut, with the `baseLoad/util/disp` decomposition, needing no position
geometry.

### 6.3 EIP-712 `SignedQuote` signing — the definitive reference

Source of truth: `packages/engine/src/quote.ts`, re-exported via `@inflexion/sdk` and
`@inflexion/sdk/quote` (`quote.ts:1-11`, `sdk/src/quote.ts:11`). The field order + types
+ domain MUST match `InflexionCore.SIGNED_QUOTE_TYPEHASH` exactly or
`createSwap`/`createSwapRouted` rejects the signature.

**Domain** (`engine/quote.ts:20-22`):
```ts
{ name: 'Inflexion', version: '1', chainId: 421614n, verifyingContract: core.inflexionCore }
```

**Types** — field order = struct order (`SignedQuoteTypes`, `engine/quote.ts:25-41`):
```ts
SignedQuote: [
  { name: 'mm',               type: 'address' },
  { name: 'marketId',         type: 'bytes32' },
  { name: 'loadBps',          type: 'uint16'  },  // ≤ loadParams.maxLoadBps (I10)
  { name: 'minMaxILRatioBps', type: 'uint16'  },
  { name: 'maxMaxILRatioBps', type: 'uint16'  },
  { name: 'quotePrice',       type: 'uint128' },  // oracle price the MM signed against (Fork-2 band anchor)
  { name: 'priceBandBps',     type: 'uint16'  },
  { name: 'model',            type: 'uint8'   },  // CollateralModel: FULL=0, PARTIAL=1
  { name: 'partialRatioBps',  type: 'uint16'  },
  { name: 'maxNotionalV0',    type: 'uint128' },
  { name: 'validUntil',       type: 'uint64'  },  // absolute ts; on-chain bound to now + [5,15]s
  { name: 'quoteId',          type: 'bytes32' },
  { name: 'nonce',            type: 'uint256' },  // bitmap (word<<8)|bit
]
```

Typehash pre-image (`SIGNED_QUOTE_TYPE_STRING`, `engine/quote.ts:44-45`):
`SignedQuote(address mm,bytes32 marketId,uint16 loadBps,uint16 minMaxILRatioBps,uint16 maxMaxILRatioBps,uint128 quotePrice,uint16 priceBandBps,uint8 model,uint16 partialRatioBps,uint128 maxNotionalV0,uint64 validUntil,bytes32 quoteId,uint256 nonce)`

`CollateralModel = { FULL: 0, PARTIAL: 1 }` — **FULL is the only supported mode in v1**
(`engine/quote.ts:47-48`).

Field types in TS: `quotePrice`, `maxNotionalV0`, `validUntil`, `nonce` are **bigint**;
`loadBps`, `*Bps`, `model` are plain `number` (< 2^53, safe) (`engine/quote.ts:54-71`).
On the wire (engine WS/log) bigints become **decimal strings** (`QuoteWire`,
`engine/quote.ts:136-186`) — convert back to bigint before re-signing/verifying.

**Exported helpers** (`engine/quote.ts`):
- `signQuote(privateKey, quote, chainId, verifyingContract): Promise<QuoteEnvelope>` —
  **positional args**, builds a viem account from the raw key. Server/key-based only;
  **do not use the raw-key path in the browser** (`engine/quote.ts:90-104`).
- `quoteDigest(quote, chainId, verifyingContract): Hex` — the on-chain digest
  `hashTypedData(...)` (`engine/quote.ts:80-87`).
- `verifyQuote(env, chainId, verifyingContract): Promise<boolean>` /
  `recoverQuoteSigner(...)` — EOA path (EIP-1271 contract signers verify on-chain)
  (`engine/quote.ts:107-129`).
- `encodeQuote` / `decodeQuote` — `SignedQuote ⇄ QuoteWire` (`engine/quote.ts:152-186`).

#### (a) Key-based signing via `mm.signQuote` (adds the I10 + below-pool guards)

`mm.signQuote(privateKey, quote, opts?)` delegates to the engine signer (never
reimplemented) and **enforces, before returning** (`mm.ts:973-1017`):
1. **I10**: `loadBps ≤ loadParams.maxLoadBps` — else `MmQuoteError('i10-exceeded')`.
2. **below-pool**: `loadBps < live pool-load-bps` (from `getPoolLoadToBeat`) — else
   `MmQuoteError('not-below-pool')`. If pool load is unreadable, the check is skipped
   (reported in the result) unless `requirePoolCheck:true` (→ `'pool-load-unreadable'`).

Returns `SignQuoteResult { envelope, belowPoolChecked, poolLoadBps?, i10Ok:true }`
(`mm.ts:1352-1360`). `MmQuoteError.code ∈ {i10-exceeded, not-below-pool,
pool-load-unreadable, no-signer, bad-nonce}` (`mm.ts:1395-1409`).

```ts
import { createInflexionSdk, encodeNonce, core, CHAIN_ID } from '@inflexion/sdk'

const sdk = createInflexionSdk({ rpcUrl, privateKey: MM_KEY })
const mm = sdk.mm

// Per-MARKET quote (NOT per-NFT). loadBps must beat the live pool floor.
const tick = await mm.getPoolLoadToBeat(marketId)         // PoolLoadTick
const quote = {
  mm: MM_ADDRESS,
  marketId,
  loadBps: Number(tick.totalLoadBps) - 50,                // undercut the pool by 50 bps
  minMaxILRatioBps: 0,
  maxMaxILRatioBps: 10_000,
  quotePrice: liveOraclePrice,                            // bigint, the Fork-2 band anchor
  priceBandBps: 50,
  model: 0,                                               // FULL
  partialRatioBps: 0,
  maxNotionalV0: 1_000_000_000_000n,                      // capacity (numéraire raw)
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 30),
  quoteId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  nonce: encodeNonce(0n, 0),                              // (word<<8)|bit
}
const signed = await mm.signQuote(MM_KEY, quote)          // throws on I10 / below-pool
// → publish signed.envelope to the engine WS (or hand to an LP for createSwap)
```

#### (b) Browser (wagmi) signing — recommended for `/underwrite`

No private key in the browser. Sign with the connected wallet, then enforce I10 +
below-pool **yourself** (mirror `mm.signQuote`'s guards, `INTEGRATION_MAP.md:236-261`):

```ts
import { SignedQuoteTypes, quoteDomain, core, CHAIN_ID } from '@inflexion/sdk'

// 1. enforce I10 + below-pool BEFORE signing
const params = await mm.getLoadParams()
if (quote.loadBps > params.maxLoadBps) throw new Error('i10-exceeded')
const pool = await mm.getPoolLoadToBeat(quote.marketId)
if (pool.available && quote.loadBps >= Number(pool.totalLoadBps)) throw new Error('not-below-pool')

// 2. sign via wagmi walletClient (EIP-712)
const signature = await walletClient.signTypedData({
  account: walletClient.account,
  domain: quoteDomain(CHAIN_ID, core.inflexionCore),   // { 'Inflexion','1',421614, core }
  types: SignedQuoteTypes,
  primaryType: 'SignedQuote',
  message: quote,                                        // bigints for uint128/64/256
})
const envelope = { quote, signature }                    // → publish / hand to LP buyProtection
```

### 6.4 Auto-requote loop + fills + capacity

- `quoteStream({ privateKey, marketId, build, publish?, onQuote?, onError?,
  intervalMs?, ... })` (`mm.ts:1034-1072, 1362-1377`): each tick reads
  `getPoolLoadToBeat`, calls `build(poolLoad)` (return `undefined` to skip), signs via
  `signQuote` (re-enforces I10 + below-pool), then hands the envelope to the **injected**
  `publish` transport (the SDK does not depend on `ws`). Degrades silently per tick.
- **Fill attribution is COARSE on-chain.** `isNonceUsed(mm, nonce)` is set on **both**
  fill and cancel, and `SwapCreated`/`SwapRouted` carry no quoteId/nonce, so
  `isQuoteFilled` returns `NonceStatus { spent, precision:'coarse', detail }` — never a
  precise filled/cancelled distinction (`mm.ts:1074-1112`, `types.ts:314-328`).
  `watchFills` polls `SwapCreated` logs by `mm` (works today, coarse). The **precise**
  path is the now-live `QuoteFilled` event (`swapId, mm, quoteId, nonce, loadBps` —
  emitted since the 2026-06-05 deploy, `abis.ts:299-309`), available once the subgraph
  indexes it.
- `capacityRemaining(quoteId, maxNotionalV0)` enforces **I7**: `remaining =
  max(0, maxNotionalV0 − consumedNotional(quoteId))` (`mm.ts:1231-1269`).

### 6.5 MM collateral (a separate flow — UnderwriterVault)

MM collateral is **not** part of `signQuote`. An MM posts collateral to the
**UnderwriterVault** via a separate ERC-20 approve + deposit before its quotes can be
filled; the SDK reads it with `getMmCollateral(mm)` → `{ deposited, locked, available }`
(`mm.ts:1273-1304`, `INTEGRATION_MAP.md:95, 310`). On a Path-B fill, the MM's own
collateral is locked at MaxIL and pays the LP at settlement (lifecycle demo:
`deployments/arbitrum-sepolia.json:92-105`).

---

## 7. DataClient — the data moat

Source: `packages/sdk/src/data.ts`. Splits the data-moat surfaces into two classes
(`data.ts:4-42`):

| Method | Args | Returns | Status | Backed by |
| --- | --- | --- | --- | --- |
| `getCurrentLoadSurface` | `{ markets:{marketId, geometry?}[] }` | `LoadSurface` | **LIVE** | RPC multicall: Core `loadParams`/`markets`, ConvexityVault `inventory`, FVO `fairPremium`; load via TS port (`data.ts:214-382`) |
| `getSurfaceSigmaRef` | `token` | `Degraded<{sigmaRefWad, regime}>` | **LIVE** | VolOracle `sigmaRef` + Core `loadParams` (`data.ts:387-413`) |
| `getLoadSurfaceHistory` | `{marketId, from?, to?, bucket?}` | `ApiPending` | pending | subgraph `/data/load-surface` (`data.ts:433-445`) |
| `getQuoteCompetition` | `{marketId?, from?, to?}` | `ApiPending` | pending | subgraph + engine COMPETITION_LOG `/data/quote-competition` (`data.ts:457-467`) |
| `getDemandRequests` | `{marketId?, from?, to?}` | `ApiPending` | pending **by design** | engine DEMAND_LOG (off-chain only) `/data/demand-requests` (`data.ts:479-489`) |
| `getNavHistory` | `{from?, to?, bucket?}` | `ApiPending` | pending | subgraph `/pool/nav-history` (carries claim B) (`data.ts:500-512`) |
| `getNetGamma` | `{marketId?}` | `ApiPending` | pending | off-chain compute `/data/net-gamma` (`data.ts:524-528`) |

**The one live surface.** `getCurrentLoadSurface` is the only DataClient method that
hits live RPC: it fans the same read set MM `getMarketPricing` does across a set of
markets — one shared `loadParams`+`inventory`, a per-market `markets` multicall, then a
per-market `fairPremium` multicall, finished with the TS-port load stack
(`data.ts:214-382`). Per-market graceful degradation: an unknown/inactive market or a
reverting oracle yields an inlined degraded `SurfaceRow` (`oracle-degraded` /
`market-unknown`), never a thrown call (`data.ts:106-126, 274-371`). If a market gives
no geometry, a neutral reference geometry is used (the **load %** is geometry-
independent; only the dollar `fairPremium`/`poolPremium` scale with `a/b/maxIL`,
`data.ts:133-141, 312`).

**`ApiPending`** (`data.ts:76-87`): `{ available:false, reason:'no-history-source',
endpoint, query, detail }` — names the FUTURE API route + the query that *would* be
sent, so the UI can show "coming from `<route>`" and the API can be wired later with
zero re-derivation. The SDK **never fabricates history** (`data.ts:13-15`).

### The five behavioral signals (the moat — the "why")

The first public view into the microstructure of the DeFi LP volatility-risk premium,
all **non-circular** (structures present day-one; dynamics mature with MM + flow
volume): (1) clearing-load surface over a transparent σ_ref bucketed by geometry
(`getLoadSurfaceHistory`); (2) pool-vs-MM load spread + win-rate
(`getQuoteCompetition`); (3) convexity term structure (subgraph `/data/term-structure`);
(4) demand skew incl. **latent** unfilled interest — off-chain telemetry that never
touches the chain by I7 (`getDemandRequests`); (5) net gamma the protocol is short
(`getNetGamma`) (`data.ts:56-67, 423-528`).

### Worked example — read the live load surface

```ts
import { createInflexionSdk, demo, tokens } from '@inflexion/sdk'

const sdk = createInflexionSdk({ publicClient })
const surface = await sdk.data.getCurrentLoadSurface({
  markets: [{ marketId: demo.marketId_fee500_7d }],   // geometry optional → neutral ref geom
})
for (const row of surface.rows) {
  if (row.available) {
    console.log(row.marketId, row.fairPremium, row.poolPremium, row.load.totalLoadWad, row.regime)
  } else {
    console.log(row.marketId, 'degraded:', row.reason)  // 'oracle-degraded' | 'market-unknown'
  }
}
const sig = await sdk.data.getSurfaceSigmaRef(tokens.demoWeth)  // Degraded<{sigmaRefWad, regime}>
```

---

## 8. GreeksEngine + HedgeSuggester — read-only analytics

Source: `packages/sdk/src/hedge.ts`. The capped IL claim the MM writes is **long-gamma,
long-vega convexity** (LP is long it; MM short). All analytics derive from the
protocol's OWN deployed math — **no parallel pricing model** (`hedge.ts:1-15`).

| Method | Args | Returns | Source |
| --- | --- | --- | --- |
| `greeks` | `position: PositionGeometry, durationSeconds, sigmaRefWad, opts?` | `Priceable<Greeks>` | δ/γ via finite-diff ILMath `computeIL`; vega/θ via finite-diff FVO `fairRate` (`hedge.ts:132-155`) |
| `bookGreeks` | `positions[], opts?` | `{greeks, counted, skipped}` | aggregates `greeks`; skips degraded, never throws (`hedge.ts:159-183`) |
| `suggestHedge` | `HedgeInput, opts?{venue?, overlayInstrument?, stripStrikes?}` | `HedgeSuggestion` | strip (Carr-Madan/BL) + on-chain inverse + delta overlay; carries `caveat` (`hedge.ts:323-333`) |
| `suggestHedgeChecked` | `HedgeInput, opts?` | `Priceable<{suggestion}>` | same, explicit envelope (`hedge.ts:337-377`) |
| `executeOnPanoptic` | `suggestion` | `PanopticPlan` (`executed:false`) | pure; **never submits a tx** (`hedge.ts:535-550`) |

- **Price greeks** finite-difference the deployed `ILMath.computeIL` of the capped
  payoff `min(IL(P_T), MaxIL)` in P — so δ/γ are exact w.r.t. the reference settlement
  math (`hedge.ts:185-230`). Reported per unit price-RATIO (P/P0), decimals-independent.
- **Vol greeks** finite-difference the on-chain `FairValueOracle.fairRate(a,b,σ,T)`
  (pure) in σ (vega, per 1.0 vol) and T (theta, per year) — anchored to the protocol's
  own fair value, never a reimplemented Φ-sum (`hedge.ts:232-280`).
- **Three-leg hedge**: (1) a vanilla long-gamma options **strip** (Breeden-Litzenberger
  second differences of the convex payoff → per-strike option notionals; puts below P0,
  calls above), (2) an **onChainInverse** long-gamma range over `[Pa, Pb]` (Panoptic /
  GammaSwap), (3) a residual **deltaOverlay** (`hedge.ts:379-512`).

**The caveat is load-bearing for judge Q&A** (`HEDGE_CAVEAT`, attached verbatim to
**every** suggestion, `hedge.ts:47-53`): the hedge is APPROXIMATE relative to the
fixed-maturity IL claim (mismatched expiry/funding/discretisation), it is the MM's own
residual-risk choice, and is **NOT relied upon for pool solvency** — **invariant I1 (no
bad debt, FULL) is structural and oracle-independent, fully collateralised at MaxIL
regardless of whether the MM hedges.** `executeOnPanoptic` always returns
`executed:false` — analytics only (`hedge.ts:515-550`).

---

## 9. The `cvamm` math port + foundation re-exports

`@inflexion/sdk` exports the foundation (`index.ts:30-53`):
`export * from addresses/abis/client/types/decode/resolveMarket`, the quote helpers
from `./quote.js`, and the math port **namespaced** as `cvamm` (to avoid clobbering
type names like `WAD`/`LoadParams`/`Regime`, `index.ts:38-40`).

The `cvamm` namespace (`math.ts`) is the **PERMANENT off-chain mirror** of the deployed
`CvammPricing` library — the **only** duplication the architecture permits (the load
math, NOT the fairRate Φ-sum). It is parity-locked byte-equal to the deployed Solidity
in `math.parity.test.ts` (`math.ts:1-16`). It exists permanently because the on-chain
`CvammPricing` library IS deployed but is **DELEGATECALL-ONLY** — a direct `eth_call`
to `libs.cvammPricing` reverts (Solidity guards deployed libraries; confirmed on the
2026-06-05 deploy). The lib runs on-chain only via the core's delegatecall during
pricing (`math.ts:6-12`, `mm.ts:16-19`, `data.ts:207-212`).

Key `cvamm` functions: `totalLoadWad`/`loadComponents(sigmaRef, util, conc, params)`,
`premiumFromLoad(fairPremium, totalLoad) = ceil(fairPremium·(1+totalLoad))`,
`pathBPremium(fairPremium, loadBps, maxIL)`, `regimeOf(sigmaRef, params)`,
`abFromSqrt(...)` (`math.ts:96-160`). The load stack: `baseLoad` (by σ_ref regime band)
+ `utilSkew` (flat below knee, convex `powWad` above, capped) + `dispSkew` (HHI
dispersion, capped), clamped to `maxLoadBps` (= I10) (`math.ts:69-126`).

`resolveMarket(client, swap)`: a `SwapRecord` carries **no marketId** (compact
on-chain); it is recovered by reproducing `_marketIdForSwap` —
`marketId = keccak256(abi.encodePacked(token0, token1, fee, uint32(expiry−createdAt)))`
read from `NPM.positions(tokenId)` (`resolveMarket.ts:1-78`). `computeMarketId(token0,
token1, fee, durationSeconds)` is the standalone helper (`resolveMarket.ts:21-33`).

---

## 10. Approvals, spenders, and decimals — the one-glance table

| Action | Spender / vault | Approval flow | Decimals |
| --- | --- | --- | --- |
| `lp.buyProtection` | **InflexionCore** | NPM `approve(core, tokenId)` + dUSDC `approve(core, maxPremium)` (auto when `approve !== false`) (`lp.ts:718-757`) | dUSDC 6-dec |
| `depositor.deposit` | **ConvexityVault** | dUSDC `approve(vault, amount)` (auto when `autoApprove:true`) then `deposit(tranche, amount)` (`depositor.ts:450-476`) | dUSDC 6-dec |
| MM collateral | **UnderwriterVault** | separate ERC-20 approve + deposit (not in `signQuote`) (`mm.ts:1273-1304`) | dUSDC 6-dec |
| `lp.settle` / `depositor.requestWithdrawal`/`withdraw` / `mm.cancelNonces` | — | **no approval** | — |

---

## 11. Degradation envelope cheat-sheet (`types.ts:17-48`)

- `Degraded<T> = ({available:true} & T) | {available:false, reason:string}` — vault
  state, position, regime, surface sigma.
- `Priceable<T> = ({priceable:true} & T) | NotPriceable` — anything needing P0;
  `NotPriceable = {priceable:false, reason: DegradeReason, detail?}`.
- `DegradeReason ∈ {oracle-degraded, no-rpc, rich-events-absent, no-history-source,
  vol-uninitialized, market-unknown, position-unknown}`.
- `ApiPending = {available:false, reason:'no-history-source', endpoint, query, detail}`
  — DataClient history methods.
- `NonceStatus.precision = 'coarse' | 'precise'` — MM fill attribution.
- `WriteResult.status = 'sent' | 'deferred-no-wallet' | 'error'` — DepositorClient
  writes (LP/MM writes throw a clear error instead when no wallet).

**Live today** (no subgraph needed): premium preview, current load surface, σ_ref,
market pricing, vault state, protection status, position geometry, `getBook` (on-chain
scan), `watchFills` (coarse). **Subgraph-pending** (degrade to typed pending, render the
state — not an error): all DataClient history, precise `QuoteFilled` fill attribution,
full fee accounting, NAV history (`INTEGRATION_MAP.md:313`).

---

## 12. Framing that must be exactly right (judge Q&A guardrails)

- **In-range convexity hedge, NOT "IL insurance".** Entry requires `Pa ≤ P0 ≤ Pb`
  (out-of-range rejected at creation, enforced by the `inRange` gate in
  `resolveGeometry`, `lp.ts:329, 448, 507`). Payout = `min(realized_IL, MaxIL)`; the
  **cap is load-bearing** for the no-bad-debt guarantee (`getPayoffCurve`/`ilToDate`
  apply it, `lp.ts:640, 856`).
- **No-bad-debt is exact ONLY under the full clause** — FULL collateralisation + capped
  payoff + solvent USDC + oracle/settlement liveness + no rehypothecation breach. Never
  state it unqualified (`lp.ts:5-7`, `depositor.ts:66-69`).
- **Depositor/MM capital is NOT guaranteed** — junior first-loss; senior protected from
  underwriting loss only, takes the systemic tail (`depositor.ts:57-61`).
- **MaxIL is the unit of risk** → positions are fungible to an underwriter within a
  market → an MM quote is per-MARKET (load + MaxIL-ratio band + capacity), never
  per-NFT (`mm.ts` §6.2).
- **The Φ-sum is read on-chain, never reimplemented**; only the deterministic load
  stack is mirrored off-chain (parity-locked) because the deployed lib is
  delegatecall-only (`math.ts:1-16`).
