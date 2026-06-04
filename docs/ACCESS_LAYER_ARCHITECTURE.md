# Access Layer Architecture — SDK / Subgraph / API

**Status:** build-ready specification. The SDK (`@inflexion/sdk`) is **built** against
this document (LP / Depositor / MM / Data + Greeks/Hedge surfaces + the
`createInflexionSdk` factory; foundation + the `CvammPricing` TS port). The subgraph
(`@inflexion/subgraph`) and API (`@inflexion/api`) are **designed here, built next
task**. The frontend is a separate workstream.

> **Build reconciliation (corrections applied while building the SDK — 2026-06).**
> This document had several mappings that disagreed with the LIVE deployment; they are
> corrected inline below and summarised here so a reader does not act on the stale text:
>
> 1. **Per-component skews are a TS port, not an on-chain call (yet).** The deployed
>    `CvammPricing` exposes only `totalLoadWad` publicly; `loadComponents` (base / util /
>    disp separately) is **coded but NOT deployed**. Until the single redeploy the SDK
>    computes the two skews from the parity-tested `CvammPricing` TS port
>    (`packages/sdk/src/math.ts`), asserted byte-equal to the on-chain `totalLoadWad`.
>    The rich on-chain `loadComponents` path activates at the redeploy with no shape
>    change. (Affects §3.2 DEP-1/DEP-6, §3.3 MM-1, §4.)
> 2. **`regime` is banded from σ_ref, NOT `sigmaComponents.binding`.** The vol regime
>    (calm / normal / stressed) is `σ_ref` vs `loadParams.regimeCalmBelowWad /
regimeStressedAtWad`. `sigmaComponents.binding` is a DIFFERENT thing — which EWMA
>    window (short / long / floor) currently binds σ_ref. Never use `binding` for regime.
>    (Affects §3.2 DEP-7.)
> 3. **`resolveMarket(swapId)` is a shared helper — `SwapRecord` carries NO `marketId`.**
>    Recover it: `NPM.positions(s.tokenId) → (token0, token1, fee)`, then `marketId =
keccak256(abi.encodePacked(token0, token1, fee, uint32(s.expiry − s.createdAt)))`,
>    then `cfg = InflexionCore.markets(marketId)`. Every LP/MM surface that starts from a
>    swapId uses this one helper (`packages/sdk/src/resolveMarket.ts`). (Affects §3.1
>    LP-5/LP-6, §3.3 MM-4.)
> 4. **`OracleManager.getPrice` REVERTS on stale feed / sequencer-down / lone-spike** —
>    it is NOT a soft view. Every LP/MM read that needs P0 catches the revert set and
>    returns a typed degraded result (`{ priceable:false, reason:'oracle-degraded' }`)
>    per position/market, never throwing the whole call. (Affects §3.1, §3.3.)
> 5. **`getPayoffCurve` entry amounts come from on-chain `ILMath.getAmountsForLiquidity`.**
>    For an UNPROTECTED position the `(a0Entry, a1Entry)` fed to `computeIL` are read from
>    `ILMath.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L)` (public, no SwapMath port);
>    for an active swap they are read from `swaps(id)`. (Affects §3.1 LP-3.)
> 6. **MM fill attribution is COARSE on the live deploy.** `SwapCreated` / `SwapRouted`
>    carry NO `quoteId`/`nonce`, and `isNonceUsed(mm, nonce)` is `true` on BOTH a fill
>    AND a cancel. So `isQuoteFilled` can only honestly say "nonce spent: filled-or-
>    cancelled" (`precision:'coarse'`). Path is inferable everywhere via
>    `mm == convexityVault` (Path A) else Path B. Precise attribution + the rich path
>    activate post-redeploy via the new `QuoteFilled` / `SwapPriced` events. (Affects
>    §3.3 MM-8, §5.7.)
> 7. **Day-one off-chain telemetry is LIVE now.** Signals 2 & 4's dynamic halves are
>    captured by the engine from the first interaction (`packages/engine/src/telemetry.ts`
>    → `DEMAND_LOG` / `COMPETITION_LOG`); the SDK `previewPremium` fires the best-effort
>    `POST /telemetry/preview` ping. See `docs/ENGINE_TELEMETRY.md`. (Affects §5.6, §8.2.)

**Authority:** this document is adjudicated against the **live Arbitrum Sepolia
deployment** (chainId 421614, `deployments/arbitrum-sepolia.json`) and the actual
contract source in `packages/contracts/src`. Every mapping below was checked against
the real ABI — not the mapper JSON, which this document supersedes where it disagrees.

**Hard rules inherited from `CLAUDE.md` (never violated by any layer):**

- The SDK reads pricing from the **on-chain `FairValueOracle` closed form** — the
  single source of truth. It NEVER reimplements or approximates the Φ-sum fair rate.
  (It MAY re-evaluate the _load stack_ client-side, because `CvammPricing` is a
  deterministic `pure` library whose inputs are all public reads — see §4.)
- No layer touches `settle` / `MaxIL` / invariants I1–I9 semantics.
- No layer reads or edits `quant/params.json` or `quant/params.py`. The on-chain
  `loadParams` getter is the canonical mirror of the cvAMM block.
- The two depositor claims are **never merged**: (A) "LPs are always paid, no bad debt
  in FULL (qualified: capped payoff + solvent USDC + oracle/settlement liveness)";
  (B) "depositor capital is NOT guaranteed (junior is first-loss; senior is structurally
  protected from underwriting loss only, not systemic tail)." Any SDK/API surface that
  reports depositor yield or NAV carries claim (B); any LP payout surface carries claim (A).

---

## 1. The three-layer model — what lives where

| Layer        | Package               | Specialty                                   | Reads from                                      | Writes? | Needs RPC key? |
| ------------ | --------------------- | ------------------------------------------- | ----------------------------------------------- | ------- | -------------- |
| **SDK**      | `@inflexion/sdk`      | Instant freshness + transactions            | live RPC (viem) + engine `/quote` + engine WS   | **Yes** | Yes (caller's) |
| **Subgraph** | `@inflexion/subgraph` | Historical / aggregate event reconstruction | on-chain **event logs** + occasional `eth_call` | No      | (indexer's)    |
| **API**      | `@inflexion/api`      | Frictionless public read access (cached)    | **the subgraph** + cached RPC snapshots         | No      | No (public)    |

### The routing rule (state this verbatim in every onboarding doc)

> **Needs to write, or needs the exact price _right now_ to sign/settle → SDK.**
> **Needs history or an aggregate (NAV/day, all settled swaps, clearing-load time series) → Subgraph (consumed via the API).**
> **Needs frictionless public access with no wallet and no RPC key → API.**

Concretely:

- **SDK** is the only layer that holds a signer and sends transactions
  (`deposit`, `createSwapRouted`, `settle`, `requestWithdrawal`, `cancelNonces`,
  `volOracle.poke`). It is also the only layer that can answer _"what dollar premium
  will I be charged on THIS position if I sign in the next block"_ — because that
  requires a fresh oracle read plus the position geometry, evaluated against the
  live `FairValueOracle`.
- **Subgraph** is **internal infrastructure**. It indexes the on-chain event stream
  into a queryable store and computes time-bucketed snapshots (NAV/day, util/hour,
  per-market volume, the clearing-load surface). It is the _only_ way to answer
  "history" questions cheaply, because the contracts store **current** state only and
  emit events for the rest. Nobody queries the subgraph directly in production except
  the API.
- **API** is a thin, cached, read-only **facade over the subgraph** (+ a small set of
  cached live RPC reads for "current fair premium" style endpoints). It is the public
  product surface: dashboards, researchers, vol traders. No wallet, no RPC key.

### Pricing lives in BOTH SDK and API (decided answer Q1)

- **SDK** computes live pricing by reading the on-chain `FairValueOracle` directly
  (instant, signer-grade freshness; can poke first for a fresh σ_ref).
- **API** computes pricing by reading the same on-chain `FairValueOracle` via a
  short-TTL cached RPC read (frictionless, no key, eventually-fresh).
- Both READ the same closed form. Neither reimplements it. This is the only acceptable
  duplication: same source, two freshness/access profiles.

---

## 2. The pricing data flow (the single most important contract interaction)

Every premium in the protocol is `FairPremium × (1 + load)`, capped at `MaxIL`. The
SDK must reproduce this **exactly** because both rails derive from it on-chain.

```
                 VolOracle.poke(token)         [TX, non-view, permissionless]
                        │  refreshes σ_ref EWMA (no-op if < minSampleInterval)
                        ▼
 FairValueOracle.fairPremium(token, aWad, bWad, durationSeconds, maxIL)   [VIEW]
        │  reads LAST-poked σ_ref from VolOracle.sigmaRef(token)
        │  computes the exact Φ-sum fairRate, returns (premium, fairRateWad, sigmaRefWad)
        ▼
 ── Path A (pool) ──────────────────────────────  ── Path B (MM) ──────────────────
 inventory() → (total, locked, free, util, conc)   signed quote carries loadBps
 load = CvammPricing.totalLoadWad(σ_ref,util,conc,  premiumB = ceil(fairPrem·(1+loadBps)/BPS)
        loadParams)   [public pure]                          capped at MaxIL
 premiumA = CvammPricing.premiumFromLoad(           (I10: loadBps ≤ loadParams.maxLoadBps)
        fairPrem, load)  [public pure], cap MaxIL
        ▼                                                   ▼
            createSwapRouted picks min(premiumA, premiumB); tie → Path A
```

**Code-verified freshness nuance (the load-bearing detail for MM/LP pricing):**

- `FairValueOracle.fairPremium(...)` is a **`view`** — it reads the **last-poked**
  `σ_ref`. An `eth_call` returns instantly but the σ_ref may be slightly stale.
- `VolOracle.poke(token)` is the **only mutation** in the pricing path. To price
  against a _fresh_ σ_ref, the SDK sends a `poke` tx first (or relies on the poke that
  `createSwapRouted`/`createSwap`/`createSwapPathA` fold in at execution time —
  `InflexionCore._fairPremium` calls `volOracle.poke` before reading `fairPremium`).
- `FairValueOracle.fairRate(a,b,σ,T)` and `fairRateFromPrices(...)` are **`pure`** —
  fully reproducible off-chain at any historical block via `eth_call`. This anchors the
  Greeks/net-gamma surface (§5.5) and the fair-premium curve to the protocol's own math.
  Note: inverting `fairRate` to recover an "implied vol" is **circular** and is NOT a moat
  (it just returns our published σ_ref) — the §5 moat is behavioral, built from MM/LP
  CHOICES (`QuoteFilled.loadBps`, LP geometry), measured against this mechanical baseline.

**Position geometry → pricing inputs (the SDK helper every surface depends on):**

```
NPM.positions(tokenId) → token0, token1, fee, tickLower, tickUpper, liquidity
sqrtPa = TickMath.getSqrtRatioAtTick(tickLower)        [pure; lib at 0xc6e5… or TS port]
sqrtPb = TickMath.getSqrtRatioAtTick(tickUpper)
P0     = OracleManager.getPrice(oracleToken)           [view]
sqrtP0 = InflexionCore.oracleDerivedSqrtPriceX96(marketId, P0)   [view — the exact on-chain conversion]
a = (sqrtPa/sqrtP0)²  ;  b = (sqrtPb/sqrtP0)²          (WAD; matches _fairPremium)
maxIL  = ILMath.computeMaxIL(sqrtP0, sqrtPa, sqrtPb, liquidity)  [pure, deployed 0xC203…]
marketId = keccak256(abi.encodePacked(token0, token1, fee, durationSeconds))
```

`oracleDerivedSqrtPriceX96` is a public view that exposes the contract's exact
oracle→sqrtP conversion, so the SDK never has to guess the decimal scaling.

---

## 3. SDK surface inventory — all four stakeholders

The SDK is organised into five modules. Every floor use case maps to a concrete
method below. Method names are normative for the build.

### 3.1 `LpClient` — buying protection (claim A surface)

> **Oracle degraded-mode (correction #4):** every LP read that needs P0 calls
> `OracleManager.getPrice`, which **REVERTS** on a stale feed / sequencer-down /
> lone-spike. The SDK catches that revert set and returns a typed
> `{ priceable:false, reason:'oracle-degraded' }` for the affected position/market —
> the whole call never throws. `previewPremium`, `getPayoffCurve`,
> `getProtectionStatus.ilToDate`, and `resolveGeometry` all return a `Priceable<…>`
> envelope. `listEligiblePositions` keeps a degraded market as `{ inRange: undefined }`
> rather than dropping it silently.

| #    | Use case                                                              | Method                                                                                                                                                                      | On-chain / off-chain reach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LP-1 | Eligible v3 positions (owned, supported pair, in-range)               | `listEligiblePositions(owner)`                                                                                                                                              | `NPM.positions` per owned tokenId (enumerate via `NPM.balanceOf`+`tokenOfOwnerByIndex`); derive `marketId`; check `markets(marketId).active`; gate `sqrtPa ≤ sqrtP0 ≤ sqrtPb` using `oracleDerivedSqrtPriceX96`. **Reachable.**                                                                                                                                                                                                                                                                                                                                            |
| LP-2 | Dollar premium for THIS position, 30d, NOW, best-of {pool, MM}, FRESH | `previewPremium(tokenId, marketId, {poke?})` → `{ maxIL, fairPremium, fairRate, sigmaRef, premiumA, premiumB?, best, path }`                                                | geometry (§2) → `fairPremium` (view); Path A load via `inventory()`+`loadParams()`+`CvammPricing` (multicall, see §4); Path B via engine `GET /quote` (one-shot — decided Q2) → compute `premiumB` from the same `fairPremium`. `{poke:true}` sends `volOracle.poke` first for a signer-grade σ_ref. **Reachable.**                                                                                                                                                                                                                                                        |
| LP-3 | **getPayoffCurve** (payout vs P_T + MaxIL cap + range edges)          | `getPayoffCurve(tokenId, marketId, {points=64})` → `{ points:[{priceWad, sqrtPT, payout, il}], maxIL, edgeLow:Pa, edgeHigh:Pb, p0 }`                                        | build a P_T grid (below Pa … inside … above Pb); for each, `eth_call` `InflexionCore.settlePreview` if a swap exists, else `ILMath.computeIL(sqrtPT, sqrtPa, sqrtPb, L, a0Entry, a1Entry)` directly; **the entry amounts `(a0Entry, a1Entry)` come from on-chain `ILMath.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L)` — public, NO SwapMath port** (correction #5); cap each at MaxIL. **Reachable — RESOLVED (was the missing item).** See §3.6 note on `settlePreview`.                                                                                            |
| LP-4 | Buy protection                                                        | `buyProtection({tokenId, marketId, maxPremium, quote?, signature?})`                                                                                                        | approve NFT (`NPM.approve`/`setApprovalForAll`) + USDC; route: `createSwapRouted(quote,sig,tokenId,maxPremium)` (best-of) — falls back to pool if quote absent/stale. `createSwapPathA(marketId,...)` and `createSwap(quote,...)` exposed as escape hatches. **Reachable (write).**                                                                                                                                                                                                                                                                                        |
| LP-5 | Where's my protection (IL-to-date, fees vs premium, expiry countdown) | `getProtectionStatus(swapId)` → `{ lp, mm, isPathA, premiumPaid, maxIL, expiry, createdAt, secondsToExpiry, status, ilToDate, noBadDebtFull }` ; `getClaimableFees(swapId)` | `swaps(swapId)` for record fields; the swap's market is recovered via the shared **`resolveMarket(swapId)`** helper (**`SwapRecord` carries NO `marketId`** — derive it from `NPM.positions(tokenId)` + `uint32(expiry − createdAt)`, correction #3); `ilToDate` via `settlePreview(swapId, sqrtP_live)` (eth_call, oracle-degraded-safe → typed `Priceable`); fees via `ILVault.claimFees` static-call or read NPM `tokensOwed`/feeGrowth. **Reachable live;** historical "fees earned since creation" needs the subgraph (`FeesClaimed` + NPM `Collect`) — non-blocking. |
| LP-6 | Settle at expiry                                                      | `settle(swapId, {hintRoundId?})`                                                                                                                                            | `settle(swapId, hintRoundId)`; SDK recovers the swap's market via `resolveMarket(swapId)` (correction #3) for the `oracleToken`, maps it to its Chainlink feed, then computes `hintRoundId` (the round whose `updatedAt` brackets `expiry`) via the feed's `getRoundData` walk and sends. **Reachable (write).**                                                                                                                                                                                                                                                           |
| LP-7 | Auto-protect new positions above $X                                   | `autoProtect({owner, minV0, marketSelector})` (keeper loop)                                                                                                                 | poll `listEligiblePositions`, filter `V0 > minV0`, exclude already-protected; execute `buyProtection`. "Already protected?" needs `SwapCreated` history → subgraph/API for clean dedupe; SDK fallback enumerates `swaps`. **Reachable; cleaner with API.**                                                                                                                                                                                                                                                                                                                 |
| LP-8 | Alert when protection price < $Y (poll, no wallet)                    | **API** `GET /pricing/preview?marketId&a&b&duration` (cached)                                                                                                               | no wallet → API surface, not SDK. The API computes `previewPremium` math against cached RPC. **Designed (API).**                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 3.2 `DepositorClient` — passive + active (claim B surface)

| #             | Use case                                                                                                                | Method                                                                                                                                                                                                                         | Reach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| DEP-1 / DEP-6 | **Fine pool state** — NAV, util, senior/junior split, **BOTH skews separately**, per-market locked, instantaneous yield | `getVaultState({marketIds?})` → `{ totalAssets, seniorAssets, juniorAssets, totalLocked, freeAssets, utilWad, concWad, utilSkewWad, dispSkewWad, baseLoadWad, lockedByMarket:{[id]:amount}, sigmaRef, regime, instYieldWad? }` | composite read: `inventory()`, `seniorAssets()`, `juniorAssets()`, `lockedByMarket(id)` per supplied market, `volOracle.sigmaRef`; the two skews from the **parity-tested `CvammPricing` TS port** (`math.ts` `loadComponents`) over `(σ_ref, util, conc)` + `loadParams()` — the deployed lib exposes only `totalLoadWad` publicly today; the on-chain `loadComponents` is coded-not-deployed and activates at the single redeploy (correction #1). **Reachable live — RESOLVED (fine inventory).** `instYieldWad` (premium accrued / assets, annualised) needs `PremiumAccrued` history → subgraph; SDK returns it only when an API/subgraph endpoint is wired, else `undefined`. **Per-market FREE capacity is intentionally pool-wide** (free collateral is fungible across all 9 markets — `freeAssets()` is the true free figure; `lockedByMarket` is exposed for concentration/HHI, not a per-market budget). |
| DEP-2         | Deposit senior/junior                                                                                                   | `deposit(tranche, amount)`                                                                                                                                                                                                     | approve USDC → `ConvexityVault.deposit(Tranche, amount)`. **Reachable (write).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| DEP-3         | My yield / shares / withdrawal-queue place                                                                              | `getPosition(owner)` → `{ seniorShares, juniorShares, seniorAssets, juniorAssets, seniorWithdraw:{shares,unlockAt,secondsRemaining}, juniorWithdraw:{…} }`                                                                     | `seniorBalanceOf`/`juniorBalanceOf`, `convertToAssets(tranche, shares)`, `seniorWithdraw`/`juniorWithdraw` mappings. **Reachable live;** cumulative realized yield needs subgraph.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| DEP-4         | requestWithdrawal then withdraw after cooldown                                                                          | `requestWithdrawal(tranche, shares)` ; `withdraw(tranche)`                                                                                                                                                                     | direct calls; SDK surfaces `withdrawalCooldown` + computed `unlockAt`; `withdraw` enforces junior-≥-locked gate on-chain. **Reachable (write).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| DEP-5         | Deposit more when util > 70%                                                                                            | `watchUtilization(thresholdWad, cb)`                                                                                                                                                                                           | poll `utilizationWad()`; trigger `deposit`. **Reachable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DEP-7         | Rebalance senior↔junior by vol regime                                                                                   | `getRegime()` (σ_ref banded vs `loadParams.regimeCalmBelowWad` / `regimeStressedAtWad` → calm/normal/stressed — **NOT** `sigmaComponents.binding`, correction #2) + `rebalance(from,to,shares)`                                | `requestWithdrawal(from)` → after cooldown `withdraw(from)` → `deposit(to)`. **Reachable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DEP-8         | NAV day-by-day stress history                                                                                           | **API** `GET /pool/nav-history?from&to&bucket=1d`                                                                                                                                                                              | subgraph indexes `Deposited`/`Withdrawn`/`PremiumAccrued`/`SettlementReleased`/`JuniorLoss`, computes daily NAV per tranche. **Designed (subgraph+API).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DEP-9         | Full time series NAV/util/premiums-vs-claims                                                                            | **API** `GET /pool/timeseries?metric=nav                                                                                                                                                                                       | util                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | claimRatio&bucket` | same subgraph aggregation. **Designed (subgraph+API).** |

### 3.3 `MmClient` — market maker (Path B; most demanding)

| #     | Use case                                                                               | Method                                                                                                                                                                                                                                                                                                                            | Reach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| MM-1  | **Real-time fair price AND pool floor price on EVERY market — first-class streamable** | `getMarketPricing(marketId, geometry)` → `{ fairPremium, fairRate, sigmaRef, poolPremium, load:{baseLoadWad,utilSkewWad,dispSkewWad,totalLoadWad}, totalLoadBps, util, conc, regime }` ; the **geometry-FREE** "load to beat" `getPoolLoadToBeat(marketId)` + `streamPoolLoadToBeat(marketIds, onTick, {intervalMs})` (poll loop) | ONE viem `multicall`: `fairValueOracle.fairPremium`, `convexityVault.inventory`, `volOracle.sigmaRef`; `loadParams`/`markets` cached (immutable). The **clamped total load is taken from the parity-tested `CvammPricing` TS port** (`math.ts`) and the **per-component skews (base/util/disp) are decomposed by the SAME port** — the deployed lib exposes only `totalLoadWad` publicly; `loadComponents` is coded-not-deployed and activates at the redeploy (correction #1). `getPoolLoadToBeat` is the geometry-independent `totalLoadWad`-in-bps streamable signal; engine WS carries _competing MM quotes_, not the protocol fair price. **Reachable — ELEVATED to first-class (see §4); the "5+ scattered RPC calls / blocking" framing is corrected: it is one multicall.** |
| MM-2  | What σ_ref the pool uses                                                               | `getSigmaRef(token)` / `getSigmaComponents(token)`                                                                                                                                                                                                                                                                                | `volOracle.sigmaRef` / `sigmaComponents` (short, long, floor, binding). **Reachable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| MM-3  | Exact geometry of an incoming position                                                 | `getPositionGeometry(tokenId, durationSeconds)` → `{ geometry:{ sqrtPaX96, sqrtPbX96, sqrtP0X96, aWad, bWad, liquidity, amount0Entry, amount1Entry, maxIL, V0 }, marketId, config }` (degraded-safe → `{ priceable:false, reason }`)                                                                                              | `NPM.positions` (ticks+liquidity) → `marketId = keccak(token0,token1,fee,duration)` → `markets()` → TickMath edges → `oracleDerivedSqrtPriceX96` (P0; oracle-degraded-safe) → entry amounts via **`ILMath.getAmountsForLiquidity`** + `ILMath.computeMaxIL` (public, correction #5). `durationSeconds` is REQUIRED (a position alone has no expiry). **Reachable (public).**                                                                                                                                                                                                                                                                                                                                                                                                        |
| MM-4  | My book — exposure, Greeks (delta/gamma/vega/theta)                                    | `getBook(mm, {fromSwapId?, swapIds?, withGreeks?})` → `{ available, mm, positions:[…], exposureV0, exposureMaxIL, count, greeks? }`                                                                                                                                                                                               | live: scan `swaps(id)` over `[fromSwapId, nextSwapId)` (bounded; or inject a known id set), keep ACTIVE swaps with `rec.mm == mm`; path inferred via `mm == convexityVault` (Path A) else Path B; each swap's market recovered via `resolveMarket` for the greeks bump (**`SwapRecord` has no `marketId`**, correction #3). Book greeks = Σ finite-differenced `ILMath.computeIL` (degrades to `greeksDegraded:'oracle-degraded'` if the oracle is down). For scale, subgraph `SwapCreated` filtered by `mm`. **Reachable live; scalable via subgraph.**                                                                                                                                                                                                                            |
| MM-5  | Hedging suggestion engine                                                              | `suggestHedge(positionOrBook)` (see §3.5)                                                                                                                                                                                                                                                                                         | read-only analytics. **Reachable (read-only).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| MM-6  | Sign a quote at load L below pool                                                      | `MmClient.signQuote(privateKey, quote, opts?)` (delegates to `@inflexion/engine/quote.signQuote`, also re-exported raw as `signQuoteRaw`)                                                                                                                                                                                         | EIP-712 `signQuote` (NEVER reimplemented); the SDK asserts `loadBps ≤ loadParams.maxLoadBps` (I10, hard) AND `loadBps < live pool-load-bps` from `getPoolLoadToBeat` (the quote actually undercuts Path A). If the pool load is unreadable (oracle/vol degraded) the below-pool check is SKIPPED and reported (`belowPoolChecked:false`) rather than blocking — set `requirePoolCheck:true` to make it a hard error. **Reachable.**                                                                                                                                                                                                                                                                                                                                                 |
| MM-7  | Stream quotes + re-quote as spot/vol move                                              | `quoteStream({ws, onTick})` (mm-bot pattern)                                                                                                                                                                                                                                                                                      | engine WS intake; reissue on σ_ref/spot change with fresh nonce; TTL bounded to now+[5,15]s on-chain. **Reachable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MM-8  | Was my quote filled                                                                    | `isQuoteFilled(mm, nonce)` → `NonceStatus{ spent, precision:'coarse', detail }` ; `watchFills(mm, cb)`                                                                                                                                                                                                                            | **COARSE on the live deploy (correction #6):** `isNonceUsed(mm, nonce)` is `true` on BOTH a fill AND a cancel, and `SwapCreated`/`SwapRouted` carry NO `quoteId`/`nonce`, so the only honest answer is "nonce spent: filled-OR-cancelled" (`precision:'coarse'`) — never a precise filled/cancelled distinction. `watchFills` polls `SwapCreated` by the indexed `mm` topic (`attribution:'coarse'`); path inferred via `mm == convexityVault`. Precise attribution lands post-redeploy via the `QuoteFilled(swapId, mm, quoteId, nonce, loadBps)` event + the subgraph. **Reachable live (coarse); precise via the redeploy + subgraph.**                                                                                                                                          |
| MM-9  | Cancel stale quotes (nonce mgmt)                                                       | `cancelNonces(nonces[])` + `encodeNonce(word,bit)`/`decodeNonce(n)`                                                                                                                                                                                                                                                               | `cancelNonces`; nonce encoding `(word<<8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | bit`. **Reachable (write).** |
| MM-10 | Historical fills / PnL                                                                 | **API** `GET /mm/{address}/fills` , `/pnl`                                                                                                                                                                                                                                                                                        | subgraph `SwapCreated`+`SwapSettled` by `mm`; PnL = Σpremium − Σpayout. **Designed (subgraph+API).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MM-11 | Volume / demand / pool-vs-MM share per market                                          | **API** `GET /markets/{id}/volume` , `/share`                                                                                                                                                                                                                                                                                     | subgraph aggregates `SwapRouted.pathB` + V0 per market. **Designed (subgraph+API).**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 3.4 `DataClient` — public data / data moat (read-only; mostly API-backed)

| #     | Use case                                                                                                | Method / route                                                                          | Reach                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUB-1 | Clearing-load surface + evolution (alpha signal)                                                        | **API** `GET /data/load-surface?marketId&from&to`                                       | subgraph time-buckets util/conc + computes `totalLoadWad` per bucket; per-fill realized load reconstructed (see §5 + GAPS). **Designed.**                                                                                                                                                                  |
| PUB-2 | Pool TVL/NAV/util history; all markets, config, σ_ref, FairPremium curve                                | **API** `GET /pool/nav-history`, `GET /markets`, `GET /markets/{id}/fair-premium-curve` | subgraph + cached RPC (`fairRate` is pure → grid). **Designed.**                                                                                                                                                                                                                                           |
| PUB-3 | LP-convexity LOAD / term-structure / demand-skew surface by range (width × distance-to-edge × duration) | **API** `GET /data/convexity-surface?duration`                                          | subgraph decodes each `SwapCreated` tokenId → `NPM.positions`, buckets by (width, distance, duration); joins `QuoteFilled.loadBps` (behavioral MM load) + `SwapPriced` (mechanical baseline, σ_ref, cap flag). **NOT** implied-vol inversion (circular). **Designed (data moat; see §5 — Signals 1/3/4).** |
| PUB-4 | Net-gamma supply + risk-appetite signals                                                                | **API** `GET /data/supply-depth?marketId` , `GET /data/net-gamma`                       | subgraph open-swap set → off-chain Greeks sum (§5.5); Σ free / Σ locked, demand rate per market. **Designed (Signal 5).**                                                                                                                                                                                  |
| PUB-5 | Pool-vs-MM load spread + latent demand                                                                  | **API** `GET /data/quote-competition` , `GET /data/demand-requests`                     | OFF-CHAIN engine telemetry (§5.6) + subgraph `SwapPriced`/`QuoteFilled` spread. **Designed (Signals 2/4 dynamic halves).**                                                                                                                                                                                 |

### 3.5 `GreeksEngine` + `HedgeSuggester` — the hedging surface (read-only)

The IL claim the MM writes is **long-gamma, long-vega convexity** (the buyer/LP is
hedging it; the MM is short it). The SDK produces exact, actionable analytics. All
read-only — `executeOnPanoptic`/on-chain hedge execution is **analytics only**.

**`GreeksEngine.greeks(position)` → `{ delta, gamma, vega, theta }`**

- Computed from the exact capped payoff `min(IL(P_T), MaxIL)`. `delta = ∂Payout/∂P0`,
  `gamma = ∂²Payout/∂P0²`, `vega = ∂Payout/∂σ`, `theta = ∂Payout/∂T`.
- The price-Greeks (delta/gamma) come from finite-differencing `ILMath.computeIL` over
  the P_T grid (the same grid as `getPayoffCurve`) — exact, since `computeIL` is the
  deployed reference math.
- The vol-Greeks (vega/theta) come from finite-differencing the on-chain
  `FairValueOracle.fairRate(a, b, σ, T)` (pure) in σ and T. **This keeps vega anchored
  to the protocol's own fair value — no parallel model.**
- Book-level Greeks = Σ position Greeks across `getBook(mm)`.

**`HedgeSuggester.suggestHedge(positionOrBook)` → `{ strip, onChainInverse, deltaOverlay, caveat }`**

Concrete, instrument-precise legs (the three the spec requires):

1. **`strip`** — the static replication of the IL claim as a **vanilla long-gamma
   options strip** (the Lipton–Lucic–Sepp decomposition is the _theory anchor only_, not
   re-derived). Output: a strike-ladder list `[{strike, type:'call'|'put', notional, expiry=T}]`
   discretising the convex payoff curve from `getPayoffCurve` (Breeden–Litzenberger /
   Carr-Madan style weighting of second differences). Fixed maturity = swap expiry.
2. **`onChainInverse`** — the **inverse concentrated / long-gamma on-chain position**
   that approximately offsets the claim: range/legs/size on a venue such as
   **Panoptic** or **GammaSwap**. Output: `{ venue, direction:'long-gamma', rangeLow, rangeHigh, sizeL, note }`.
3. **`deltaOverlay`** — the **residual delta** hedged with a perp/spot: `{ instrument:'perp'|'spot', side, size }` sized to flatten book delta after legs 1+2.

**`caveat` (always attached, verbatim):**

> A perpetual-option / on-chain inverse hedge is **APPROXIMATE** relative to the
> fixed-maturity IL claim (mismatched expiry, funding, discretisation). It is the MM's
> own residual-risk choice and is **NOT relied upon for pool solvency** — invariant I1
> (no bad debt, FULL) is structural and oracle-independent, fully collateralised at
> `MaxIL` regardless of whether the MM hedges.

### 3.6 SDK adjudication notes (corrections to the mapper JSON)

- **`settlePreview` is NOT declared `view`.** It is `external returns (uint256, uint128)`
  because `IILMath.computeIL` is non-view in the interface. **However** the _deployed_
  `ILMath` (Solidity, `0xC203…`) implements `computeIL` as `pure`, so an
  `eth_call`/`staticCall` of `settlePreview` succeeds and mutates nothing. The SDK calls
  it via `publicClient.call`/`simulateContract`, never as a `readContract` view. Document
  this so the SDK author doesn't wire it as a view and get a type error.
- **The "unified MM pricing read" is NOT a blocking gap.** All inputs are public
  (`fairPremium` view, `inventory()` view, `sigmaRef` view, `loadParams()` getter) and
  the load math is a deployed `public pure` library. One viem `multicall` returns
  everything in a single RPC round-trip; the load stack is finished client-side from the
  `CvammPricing` TS port (kept byte-identical to the Solidity lib and asserted in tests).
  A future on-chain `marketPricingSnapshot` aggregator view is a _convenience_, not a
  requirement (listed non-blocking in GAPS).
- **`CvammPricing` may be re-evaluated client-side without violating the "no
  reimplementation" rule** — that rule binds the **fairRate Φ-sum** (read from
  `FairValueOracle`, never reimplemented). The load stack is explicitly a deterministic
  `pure` transform of public inputs; the SDK ports it (with a parity test against the
  deployed lib) so MM tight loops avoid a per-tick staticcall.
- **Only `totalLoadWad` is public on the deployed lib today (correction #1).** The
  per-component breakdown (`baseLoad` / `utilSkew` / `dispSkew`) is exposed on-chain by
  `CvammPricing.loadComponents`, which is **coded but NOT deployed**. Until the single
  redeploy the SDK gets the two skews from the `math.ts` TS port; the parity test asserts
  the port's clamped `totalLoadWad` equals the deployed lib's, so the components are
  trustworthy by construction. At the redeploy the surfaces switch to the on-chain
  `loadComponents` with NO shape change (the `LoadBreakdown` fields are identical).

---

## 4. Why MM pricing is first-class and reachable in ONE read

The mapper flagged "fair + pool floor as a first-class streamable signal" as blocking
because `_fairPremium` / `_pathAPremiumFromFair` are `internal`. Adjudication: **they
are internal, but every input they consume is publicly readable**, so the composite is
reconstructable in a single multicall. The SDK's `getMarketPricing` is the first-class
surface; here is the exact read set:

| Datum                                                     | Public source                                                                                                                                                                                               | Type                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| FairPremium, fairRate, σ_ref                              | `FairValueOracle.fairPremium(token,a,b,dur,maxIL)`                                                                                                                                                          | view                                     |
| util, conc, total, locked, free                           | `ConvexityVault.inventory()`                                                                                                                                                                                | view                                     |
| σ_ref (alone)                                             | `VolOracle.sigmaRef(token)`                                                                                                                                                                                 | view                                     |
| load curve params                                         | `InflexionCore.loadParams()` (public struct getter)                                                                                                                                                         | view                                     |
| totalLoad (clamped)                                       | `CvammPricing.totalLoadWad(σ_ref, util, conc, loadParams)`                                                                                                                                                  | **public pure** (deployed lib)           |
| baseLoad / utilSkew / dispSkew (the two skews separately) | **parity-tested `CvammPricing` TS port** (`math.ts` `loadComponents`) — the on-chain `loadComponents` is coded-NOT-deployed (correction #1); the port is asserted byte-equal to the on-chain `totalLoadWad` | TS port (interim) → on-chain at redeploy |
| poolPremium                                               | `CvammPricing.premiumFromLoad(fairPrem, totalLoad)`                                                                                                                                                         | public pure (TS-ported)                  |
| MM available collateral                                   | `UnderwriterVault.availableBalance(mm)` / `deposited` / `locked`                                                                                                                                            | view                                     |
| quote capacity used                                       | `InflexionCore.consumedNotional(quoteId)`                                                                                                                                                                   | view                                     |

Tight-loop pattern: SDK reads `loadParams` and `markets` **once** (cache; immutable
post-freeze), then per tick does ONE multicall over `fairPremium` + `inventory` +
`sigmaRef` and finishes the load stack in TS. The σ_ref is as fresh as the last poke;
for signer-grade freshness the MM sends `volOracle.poke` (cheap, permissionless) on the
same cadence or relies on the poke folded into the eventual `createSwapRouted`.

---

## 5. Data-moat surfaces — the FIVE behavioral signals

> **Superseded design note (do NOT resurrect):** an earlier draft framed the moat as
> "implied vol by inverting `fairRate`." That is **CIRCULAR and is dropped.** Because
> every premium is `charged/MaxIL = fairRate(σ_ref)·(1 + load)`, inverting `fairRate`
> from the charged premium recovers **our own published `σ_ref` plus the dealer load
> stack** — not a market-implied vol. It tells us nothing an outside observer of our
> own oracle did not already know. The moat below is reframed around **actor behavior**
> (MM and LP CHOICES) rather than the protocol's own price computation.

### 5.0 The honest framing (state this verbatim in any data-product pitch)

> Inflexion is the **first venue that prices the in-range IL convexity of a SPECIFIC
> Uniswap v3 range**. The five signals below are the first structured view into the
> **microstructure of the DeFi LP volatility-risk premium**. At launch (1 MM, a handful
> of fills) we ship the **architecture and the static STRUCTURES** — the term-structure
> shape, the demand skew by geometry, the net-gamma surface. The full **DYNAMICS** (the
> pool-vs-MM spread as a forward-vol signal) require **multiple competing MMs** and
> mature **as volume grows**. We sell the architecture and the first view, not a mature
> dataset. Every signal surface carries this maturity disclaimer.

What separates a **behavioral** (non-circular) signal from a **mechanical** (circular)
one in this protocol:

| Source of the number                               | Circular? | Why                                                                                                                                                                                   |
| -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MM-signed `quote.loadBps` (Path B)                 | **NO**    | An external actor's free choice; the protocol does not compute it. Capped only by `loadParams.maxLoadBps` (I10).                                                                      |
| Which `tokenId` an LP brings + duration chosen     | **NO**    | LP demand choice; the protocol does not pick the geometry.                                                                                                                            |
| Path-A pool load `totalLoadWad(σ_ref, util, conc)` | **YES**   | Pure deterministic function of protocol state-machine outputs. Inverting it recovers our own formula. Keep as the **mechanical baseline / "price-to-beat"**, not a behavioral signal. |
| `fairRate(a, b, σ_ref, T)`                         | **YES**   | Our own published closed form.                                                                                                                                                        |

The rule: **a signal is non-circular iff its informative degrees of freedom come from
the MM's `loadBps` or the LP's geometry/duration choice — measured AGAINST the
transparent mechanical baseline, not derived from it.**

### Code-verified primitives (the two ADDED events)

`InflexionCore` will emit (coded now, live at the next redeploy):

- **`QuoteFilled(swapId indexed, mm indexed, quoteId indexed, nonce, loadBps)`** — on
  every Path-B fill (`_executePathB`). The MM's actor-chosen `loadBps`, attributed to the
  exact quote/nonce. **This is the single non-circular load datum.**
- **`SwapPriced(swapId indexed, path, fairPremium, baseLoadWad, utilSkewWad, dispSkewWad,
totalLoadWad, sigmaRefWad)`** — on ALL THREE create paths for the executed swap. Records
  the realized clearing price baseline + the **pool's mechanical load decomposition** +
  the σ_ref the swap was priced against, with **no archive `eth_call`**. On a Path-B fill,
  the pool-load fields describe the **pool quote the MM beat** (the price-to-beat), which is
  exactly what the spread signal (Signal 2) needs.

Two amendments to the planned `SwapPriced` (justified below, folded into the single
redeploy):

- add **`fairPremium`** (already in the field list above — the WAD baseline the load
  multiplies; without it neither the pool's realized-load fraction nor the MM's load can be
  normalised against the fair value).
- add **`cappedAtMaxIL` (bool)** — set when `premium == maxIL`. Cap-bound fills carry
  **zero load information** (the load was truncated by the cap) and MUST be excluded from
  Signals 1/2/3. Deriving `premium == maxIL` off-chain is possible but brittle (rounding);
  an explicit flag is cheap and removes ambiguity.

### 5.1 Signal 1 — Realized clearing LOAD over a transparent σ_ref (bucketed by width × distance-to-edge × duration)

The convexity risk premium charged **above** the published realized-vol reference.

- **Non-circular: PARTIAL — Path B only.** The Path-B load is `QuoteFilled.loadBps`, an MM
  choice → **non-circular**. The Path-A load is `SwapPriced.totalLoadWad`, a deterministic
  function of `(σ_ref, util, conc)` → **circular** (recovers our own load stack). Keep Path A
  as the **mechanical baseline** the MM is measured against; do NOT sell it as a behavioral
  signal.
- **Reachable: YES (Path B).** `QuoteFilled.loadBps` (the load) + `SwapPriced.sigmaRefWad`
  /`fairPremium` (the baseline + reference vol) + `NPM.positions(tokenId)` at the
  `SwapCreated` block (width = `log(Pb/Pa)`, distance-to-edge = `min(P0−Pa, Pb−P0)/P0`) +
  `expiry − createdAt` (duration). Subgraph joins all on `swapId → tokenId`.
- **Exclude cap-bound fills:** filter `SwapPriced.cappedAtMaxIL == true`.
- **Launch caveat:** at 1 MM there is a single load point per bucket — **structural, not
  dynamic.** Bucketed dispersion (the spread across MMs' load views) needs **≥3 MMs** and
  ~30–50 fills/bucket to be a regime, weeks-to-months at launch flow.

### 5.2 Signal 2 — Pool-vs-MM load SPREAD + MM win-rate / win-depth

The pool quotes a mechanical load; an MM undercuts when it has an edge. The spread, plus
how often and how deeply MMs beat the pool, is **forward-vol expectation extracted from MM
behavior** (aggressive undercut ⇒ market sees vol cheaper than the backward-looking
`σ_ref` ⇒ expects vol to fall; MMs retreat above the pool ⇒ expects vol to rise).

- **Non-circular: YES (as a SPREAD).** Each side is well-defined: pool load (mechanical,
  `SwapPriced` on the Path-A candidate) and MM load (behavioral, `QuoteFilled.loadBps`). The
  **difference** isolates the actor's view relative to the transparent baseline — the
  subtraction is exactly what removes the circular component. (Caveat: at 1 MM the spread
  conflates "MM expects vol to fall" with "MM has cheaper hedges" — two un-separable
  orthogonal drivers until competing MMs exist.)
- **Reachable: YES — improved by emitting `SwapPriced` on the WINNING path AND `SwapRouted`
  on every routed entry.** On a Path-B win, `SwapPriced` carries the **losing pool quote's**
  `totalLoadWad` and `fairPremium`; `QuoteFilled.loadBps` carries the winning MM load ⇒ the
  spread is in two joined events with no archive call. `SwapRouted(swapId, pathB, premiumA,
premiumB)` already records both candidate premiums but **only fires from `createSwapRouted`**
  — direct `createSwap` (Path B) and `createSwapPathA` (Path A) do not emit it, biasing
  win-rate toward routed entries. See the event-list decision: we standardise on
  `SwapPriced` (emitted from all three paths) as the canonical per-fill pricing record;
  `SwapRouted` stays as the routed-only convenience. Win-rate = `count(path==1) / count(all)`
  per bucket; win-depth = `premiumA − premiumB`.
- **Launch caveat:** **structural at launch, dynamic only with ≥3 MMs.** With one MM there
  is no competitive distribution — you see one undercut, not a market view. Honest pitch:
  "spread visible per fill; the forward-vol read matures with MM competition."

### 5.3 Signal 3 — TERM STRUCTURE of convexity (the SLOPE across 7/30/90d per range)

The same position protectable at 7/30/90d; how the load evolves with maturity per range is
the LP-convexity-premium term structure. **The slope is the signal.**

- **Non-circular: PARTIAL — and watch the subtlety.** For **Path B**, the slope of
  `QuoteFilled.loadBps` across durations is behavioral (the MM's term view) → non-circular.
  For **Path A**, the load stack is **duration-INDEPENDENT by construction** — verified in
  `CvammPricing`: `baseLoadWad` is a σ_ref-regime band only, `utilSkewWad`/`dispSkewWad`
  depend only on inventory; **none take `durationSeconds`**. So a Path-A "term structure of
  load" is a **flat line** (all maturity dependence lives in `fairRate(...,T)`, which is our
  own σ_ref·√T). Framing matters: Path A gives the **published `fairRate` term structure**
  (mechanical), Path B gives the **behavioral load term structure**. Do not conflate.
- **Reachable: YES.** `QuoteFilled.loadBps` per fill + duration (`expiry − createdAt`) +
  geometry (`NPM.positions`) bucketed by range. `SwapPriced.fairPremium`/`sigmaRefWad` anchor
  each point. No archive call once `SwapPriced` lands.
- **Exclude cap-bound fills** (`cappedAtMaxIL`).
- **Launch caveat:** the **structure exists day one** (you can place 7/30/90d fills of one
  range on one axis), but a clean slope needs ~30 fills per (range × duration) — at 1 MM,
  weeks per bucket. Structural at launch; slope-as-signal matures with volume.

### 5.4 Signal 4 — MONEYNESS / DEMAND SKEW by geometry

Which positions LPs seek to protect (tight vs wide; centered vs near-edge) = LP-sentiment /
leading stress indicator (a surge in tight near-edge protection demand ⇒ LPs expect an
imminent move).

- **Non-circular: PARTIAL.** **Realized** demand by geometry is an LP choice (which
  `tokenId`/duration to bring) → non-circular for the fills we see. But on-chain we observe
  **only realized purchases**, biased by quote availability (a geometry queried 100× but
  filled 10× because it was too expensive reads as low demand). **True demand including
  UNFILLED interest is OFF-CHAIN** — it lives in relayer `/quote` requests and SDK
  `previewPremium` calls that never hit the chain. This is subtlety (ii): on-chain gives the
  realized half of the demand curve; the latent half needs telemetry.
- **Reachable: PARTIAL.** Realized: `SwapCreated(swapId, lp, mm, tokenId, V0, …)` +
  `NPM.positions(tokenId)` (width, distance-to-edge) + duration, aggregated per geometry
  bucket — fully on-chain, **no new event** (decode is subgraph work). Latent: **needs an
  off-chain telemetry surface** (see §5.6) — NOT a contract event.
- **Launch caveat:** structural — the realized demand surface populates from the first fills;
  the **leading-indicator** quality (surge detection) needs both volume AND the off-chain
  request stream to separate demand from price-sensitivity.

### 5.5 Signal 5 — NET CONVEXITY / GAMMA SUPPLY (protocol-wide)

Total gamma being **sold** (pool + all MMs) and at what aggregate load across the surface =
real-time gauge of DeFi appetite to sell vol; tradeable vs Deribit.

- **Non-circular: YES (as a supply/quantity gauge).** The aggregate is built from actor
  positions: Σ over all ACTIVE swaps of per-swap gamma (from each swap's stored geometry,
  immutable `liquidity`/`amount{0,1}Entry`/ticks, I6) weighted by the realized load at which
  it was sold (Path-B behavioral; Path-A mechanical baseline). The **quantity** (how much
  convexity the protocol is short) is a real-world fact, not a price computation. The
  per-swap **Greeks** are computed off-chain by finite-differencing the deployed
  `ILMath.computeIL` / `FairValueOracle.fairRate` (§3.5) — anchored to protocol math, no
  parallel model.
- **Reachable: YES (off-chain compute over the subgraph-tracked open set).** The subgraph
  maintains the **active-swap set** (`SwapCreated` opens, `SwapSettled` closes) with each
  swap's geometry; the API/GreeksEngine sums Greeks over it. This is **off-chain compute,
  not a new event** — subtlety (iv).
- **Launch caveat:** the gauge is **meaningful from a handful of swaps** (it is a sum, not a
  distribution) — the most launch-robust of the five. It sharpens as the open book grows.

### 5.6 Off-chain telemetry surface (Signals 2 & 4 — NOT a contract event)

Two signals need data that **never reaches the chain** because an unfilled or previewed
quote leaves no trace (this is by design — I7: an unchosen quote touches no nonce/capacity):

- **Latent LP demand (Signal 4)** — the full demand curve including geometries LPs priced
  but did not buy.
- **MM quote competition / no-quote behavior (Signal 2)** — quotes an MM offered that lost or
  that the LP rejected on slippage; how MMs widen/withdraw under stress.

**Where it lives:** the **engine/relayer** (`packages/engine`) logs every `/quote` request
and `previewPremium` call; the **API** (`packages/api`) exposes the aggregated stream.

> **LIVE NOW (correction #7 — day-one capture):** this is no longer just "designed".
> `packages/engine/src/telemetry.ts` (`TelemetrySink`) writes two append-only JSONL sinks
> from the FIRST interaction — `DEMAND_LOG` (every `GET /quote` + `POST /telemetry/preview`)
> and `COMPETITION_LOG` (every WS quote, winners AND losers). The SDK `LpClient.previewPremium`
> fires the best-effort `POST ${engineBaseUrl}/telemetry/preview` ping (fire-and-forget;
> never blocks or fails the preview). The actual on-disk schemas are coarse-bucketed and
> PII-free — `DemandRecord { ts, marketId, widthBucket, distanceBucket, durationBucket,
previewedPremium?, filled:false, source }` and `CompetitionRecord { ts, marketId, mm,
loadBps, validUntil, accepted, reason? }` (NOT the speculative single-record schema this
> paragraph previously sketched). Full schemas + ops: `docs/ENGINE_TELEMETRY.md`. This data
> is **unreconstructable retroactively** (I7) — it MUST be captured before the redeploy.

This is a **structured log/telemetry pipeline, not a subgraph entity and not an on-chain
event** — putting unfilled interest on-chain would both cost gas and break I7. The API
serves it as `GET /data/demand-requests` and `GET /data/quote-competition`, each carrying
the maturity disclaimer. Mandatory for the _dynamic_ halves of Signals 2 and 4; the
_structural_ halves are fully on-chain.

### 5.7 Consolidated EVENT LIST for the single redeploy

The two planned events plus the amendments (one new event is added; the rest are field
additions to `SwapPriced`). Status `planned` = already in the task spec; `new` = added by
this verification.

| Event         | Fields                                                                                                                               | Emit site                                                               | Signals it serves                                                   | Status                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `QuoteFilled` | `swapId indexed, mm indexed, quoteId indexed, nonce, loadBps`                                                                        | `_executePathB`                                                         | 1, 2, 3 (the non-circular MM load)                                  | **planned**                                             |
| `SwapPriced`  | `swapId indexed, path (0=poolA,1=mmB), fairPremium, baseLoadWad, utilSkewWad, dispSkewWad, totalLoadWad, sigmaRefWad, cappedAtMaxIL` | end of `_executePathA` **and** `_executePathB` (all three create paths) | 1, 2, 3, 5 (baseline + pool/price-to-beat decomposition + cap flag) | **planned** + `fairPremium` and `cappedAtMaxIL` **new** |

`fairPremium` and `cappedAtMaxIL` are folded into `SwapPriced` rather than a separate event:
both are produced at the same site (`_executePathA`/`_executePathB` already hold `premium`,
`maxIL`, and — via `_fairPremium` — `fairPrem`), so one event is the minimal, atomic record.
No other new event is required. Signals 4 (latent) and 2 (competition) need OFF-CHAIN
telemetry (§5.6), explicitly NOT events. Signal 5 needs OFF-CHAIN compute over the subgraph
open set (§5.5), not an event.

**Existing events relied on:** `SwapCreated` (lp/mm/tokenId/V0/maxIL/premium — the open),
`SwapSettled` (closes the active set; realizedIL/payout), `SwapRouted` (routed-only, both
candidate premiums — kept as convenience; `SwapPriced` is the canonical per-fill record),
`VolOracle.Poked`/`Initialized` (σ_ref series — note `poke` is a no-op emitting NO `Poked`
when `dt < minSampleInterval`, so the subgraph reconstructs σ_ref between pokes from
`SwapPriced.sigmaRefWad`), ConvexityVault `CollateralLocked`/`SettlementReleased`/
`PremiumAccrued`/`Deposited`/`Withdrawn`/`JuniorLoss`.

### 5.8 Pool TVL/NAV/util history (PUB-2) + supply-depth (PUB-4)

- **On-chain primitives (fully sufficient, all emitted):** `Deposited`, `Withdrawn`,
  `PremiumAccrued(amount,toSenior,toJunior)`, `CollateralLocked`, `SettlementReleased`,
  `JuniorLoss(payout,juniorLoss,seniorLoss)`. NAV per tranche = Σ deposits + Σ premium
  share − Σ tranche loss; util/conc from the lock stream.
- **Subgraph work:** index all six → `PoolDaySnapshot` (seniorAssets, juniorAssets,
  totalLocked, util, conc, premiumAccrued, payouts, juniorLoss). The **claim (B)**
  caveat is attached to every NAV/yield field.

### 5.4 Market directory + σ_ref + FairPremium curve (PUB-2)

- `MarketRegistered(marketId, token0, token1, fee, durationSeconds, oracleToken)` is the
  canonical directory (subgraph builds `Market` entities from it; no on-chain
  `getMarkets()` enumerator exists — GAPS non-blocking). `cvammEnabled`/`CvammEnabledSet`,
  `LoadParamsSet` track Path-A config. FairPremium curve = grid of `fairRate` (pure)
  cached by the API.

---

## 6. Subgraph scope (designed, built next task)

**Indexer:** The Graph (hosted or decentralised). **Inputs:** the live Sepolia
addresses in `deployments/arbitrum-sepolia.json`. **Start block:** the deployment block.

### 6.1 Event handlers (every event the layers depend on)

| Contract           | Events to index                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `InflexionCore`    | `MarketRegistered`, `MarketDeactivated`, `SwapCreated`, `SwapPriced`, `QuoteFilled`, `SwapRouted`, `SwapSettled`, `NoncesCancelled`, `CvammEnabledSet`, `LoadParamsSet`, `CvammConfigured`, `CvammFrozen`, `TreasurySet` |
| `ConvexityVault`   | `Deposited`, `WithdrawRequested`, `Withdrawn`, `PremiumAccrued`, `CollateralLocked`, `SettlementReleased`, `JuniorLoss`                                                                                                  |
| `UnderwriterVault` | `Deposited`, `Withdrawn`, `CollateralLocked`, `SettlementReleased`, `CapitalLow`                                                                                                                                         |
| `ILVault`          | `NFTReceived`, `NFTReturned`, `FeesClaimed`                                                                                                                                                                              |
| `VolOracle`        | `Poked`, `Initialized`                                                                                                                                                                                                   |
| `OracleManager`    | `TWAPAdvisory`, `LoneSpikeDeferred`, `LivenessBackstopTriggered` (guardian/data)                                                                                                                                         |

### 6.2 Entities

Mapped to the five behavioral signals (§5). Each signal is reconstructable as a **current
snapshot** (latest bucket aggregate) and a **historical series** (per-fill rows + time
buckets).

- `Market` — config from `MarketRegistered` (+ `cvammEnabled`, `active`).
- `Swap` — full lifecycle: created (`SwapCreated`: lp, mm, tokenId, V0, maxIL, premium) →
  priced (`SwapPriced`: path, fairPremium, baseLoadWad, utilSkewWad, dispSkewWad,
  totalLoadWad, sigmaRefWad, cappedAtMaxIL) → filled (`QuoteFilled`: mm, quoteId, nonce,
  **loadBps** for Path B) → settled (`SwapSettled`: realisedIL, payout, settlementPrice).
  Derived: `pnlForMm`, decoded geometry (`widthBucket`, `distanceBucket`, `durationBucket`),
  `mmLoadBps` (Path B), `poolLoadWad` (mechanical baseline), `spreadWad = poolLoadWad −
mmLoadBps` (Signal 2), `isActive` (open-set membership for Signal 5).
  **NO `impliedVol` field** — dropped as circular.
- `BucketAggregate` — keyed by `(widthBucket, distanceBucket, durationBucket)`. Reconstructs
  **Signals 1 & 3**: `medianMMLoadBps`, `medianPoolLoadWad`, `countPoolFills`,
  `countMMFills`, `countMMWins`, `mmWinRate`, `medianSpreadWad`, `V0Volume`,
  `sigmaRefFloor` — all over **non-capped** fills only. Indexes `SwapPriced` + `QuoteFilled`
  joined on `swapId`. The 7/30/90d rows of one (width, distance) pair give the term-structure
  slope (Signal 3); the load level gives Signal 1.
- `GeometryDemandBucket` — keyed by `(widthBucket, distanceBucket, durationBucket)`.
  Reconstructs the **realized half of Signal 4**: `realizedFillCount`, `realizedV0`,
  `firstSeen`, `lastSeen`. Indexes `SwapCreated` (+ `NPM.positions` decode). The latent half
  (unfilled interest) is OFF-CHAIN (§5.6), surfaced by the API, NOT a subgraph entity.
- `NetGammaSnapshot` — per time bucket, protocol-wide: `activeSwapCount`, `totalV0`,
  `totalMaxIL`, `aggGammaWad`, `aggVegaWad`, `volumeWeightedLoadWad`. Reconstructs
  **Signal 5** by summing off-chain Greeks over the `Swap.isActive` open set (subgraph tracks
  membership; Greeks computed by the API/GreeksEngine, written back as a snapshot).
- `Depositor` — per address per tranche: shares, assets, deposits, withdrawals, realized
  yield, current withdrawal request.
- `MarketMaker` — fills, exposure, cumulative premium, cumulative payout, PnL,
  `cumulativeWinCount` / `cumulativeQuoteFillCount` (Signal 2 per-MM win-rate).
- `PoolDaySnapshot` / `PoolHourSnapshot` — seniorAssets, juniorAssets, totalLocked, util,
  conc, premiumAccrued, payouts, juniorLoss.
- `MarketStateSnapshot` — per (market, bucket): lockedByMarket, util, conc, σ_ref, baseLoad,
  utilSkew, dispSkew, totalLoad, fillCount, V0Volume, pathBShare.
- `SigmaPoint` — per (token, `Poked`): priceWad, dt, σShort, σLong, σRef, regime.
  **Gap-fill:** `poke` is a no-op (no `Poked`) when `dt < minSampleInterval`; backfill the
  σ_ref series between pokes from `SwapPriced.sigmaRefWad` (emitted on every fill).
- `Nonce` — (mm, nonce) → used/cancelled (for precise fill detection MM-8).

### 6.3 Required `eth_call` enrichment (archive node)

- `NPM.positions(tokenId)` at the `SwapCreated` block — decode range geometry (width,
  distance-to-edge). No geometry is stored in any event; every geometry-bucketed signal
  (1, 3, 4) needs it. **Still required.**
- ~~`FairValueOracle.fairRate(a, b, σ_ref, T)` at block for realized-load / implied-vol~~ —
  **NO LONGER REQUIRED for load.** `SwapPriced` now emits `fairPremium`, the full pool-load
  decomposition, and `sigmaRefWad` atomically at the fill block, so realized load needs no
  archive call. `fairRate`/`computeIL` archive calls remain only for the off-chain
  net-gamma Greeks (Signal 5, §5.5), where they finite-difference the protocol math.

---

## 7. API scope (designed, built next task)

**Runtime:** Node/TS service (Railway/Fly). **Reads:** the subgraph (GraphQL) for
history/aggregates + a small set of cached live RPC reads for "current" endpoints.
**Public, read-only, no wallet, no RPC key, cached** (per-route TTL).

### 7.1 Endpoints

| Route                                              | Backed by                                              | TTL  |
| -------------------------------------------------- | ------------------------------------------------------ | ---- |
| `GET /markets`                                     | subgraph `Market[]`                                    | 60s  |
| `GET /markets/{id}`                                | subgraph `Market` + cached `inventory`/`sigmaRef`      | 5s   |
| `GET /pricing/preview?marketId&a&b&duration&maxIL` | cached RPC `fairRate` + load stack                     | 3s   |
| `GET /markets/{id}/fair-premium-curve?durations`   | cached RPC `fairRate` grid                             | 30s  |
| `GET /quote?marketId`                              | proxies engine `GET /quote` (best Path-B)              | 1s   |
| `GET /pool/nav-history?from&to&bucket`             | subgraph `PoolDaySnapshot[]` (claim B)                 | 60s  |
| `GET /pool/timeseries?metric&bucket`               | subgraph snapshots                                     | 60s  |
| `GET /pool/state`                                  | cached `getVaultState` composite                       | 5s   |
| `GET /mm/{address}/fills` , `/pnl`                 | subgraph `MarketMaker`+`Swap[]`                        | 30s  |
| `GET /markets/{id}/volume` , `/share`              | subgraph `MarketStateSnapshot[]`                       | 30s  |
| `GET /swaps/{swapId}`                              | subgraph `Swap` (+ cached `settlePreview` for live IL) | 5s   |
| `GET /data/load-surface?marketId&from&to`          | subgraph `MarketStateSnapshot[]`                       | 60s  |
| `GET /data/convexity-surface?duration`             | subgraph `ConvexitySurfacePoint[]`                     | 300s |
| `GET /data/supply-depth?marketId`                  | subgraph aggregate                                     | 60s  |
| `GET /sigma/{token}/history`                       | subgraph `SigmaPoint[]`                                | 60s  |

All `/pool/*`, `/data/*` (NAV/yield) responses carry the claim-(B) "capital not
guaranteed" disclosure field; `/swaps/*` payout fields carry the qualified claim-(A)
"no bad debt in FULL" disclosure field.

---

## 8. GAPS

Adjudicated against the live contracts. **Blocking** = a floor use case cannot be served
at all until the gap is closed. **Non-blocking** = served today (live or via the
next-task subgraph/API) and the proposed item is only an optimisation/cleanliness.

### 8.1 Blocking gaps

| Use case(s)                                                    | Gap                                                                                                                                                                                                   | Resolution                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEP-8, DEP-9, PUB-1..4, MM-10, MM-11, LP-8 (history/aggregate) | **The subgraph and API do not exist** (empty stubs). All HISTORY/AGGREGATE use cases are unreachable until built. The contracts emit every event needed — this is a build gap, not a contract gap.    | Build `@inflexion/subgraph` (§6) then `@inflexion/api` (§7) in the next task. No contract change required. This is the single real blocker and it is the explicitly-scheduled follow-on work. |
| MM-10, MM-8 (precise fill match)                               | MM dashboard / precise "was THIS quote filled" cannot scale on raw `eth_call`: there is no on-chain index from `quoteId`/`mm` to fills; `isNonceUsed` only says a nonce was spent, not by which swap. | Subgraph `Swap` filtered by `mm` + `Nonce(mm,nonce)→swapId`. Reconstructable from `SwapCreated` (carries `mm`) — subgraph closes it. No contract change.                                      |

### 8.2 Non-blocking gaps (served today; proposed items are optimisations)

| Use case(s)                                       | Gap                                                                                                                              | Resolution                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MM-1, MM-Specific                                 | Composite fair+pool price is `internal` on-chain (`_fairPremium`, `_pathAPremiumFromFair`).                                      | **Served now** by SDK `getMarketPricing` (one multicall of public inputs + TS load stack, §4). Optional future-deploy convenience: a public `marketPricingSnapshot(marketId, a, b, dur)` view returning `(fairPremium, poolPremium, util, conc, σ_ref, totalLoad)` to collapse the multicall to one call.                                                                                                           |
| LP-2, MM-1 (signer-grade freshness)               | `fairPremium` reads the last-poked σ_ref (slightly stale on a quiet feed).                                                       | **Served now**: SDK sends `volOracle.poke(token)` (cheap, permissionless) before a signer-grade preview, or relies on the poke folded into `createSwapRouted`. No change needed.                                                                                                                                                                                                                                    |
| DEP-1, DEP-6 (instantaneous yield)                | Instantaneous/implied yield is not stored on-chain (no per-second accrual accumulator).                                          | **Served via subgraph**: `instYieldWad` = annualised `PremiumAccrued` over recent window / tranche assets. SDK returns it only when the API/subgraph is wired; live SDK returns `undefined`. Optional: a `yieldPerSecondWad` accumulator in a future ConvexityVault.                                                                                                                                                |
| DEP-1, DEP-6 (per-market free capacity)           | No `freeByMarket` getter.                                                                                                        | **Not a gap by design**: free collateral is fungible across all markets; `freeAssets()` is the true free figure and `lockedByMarket` is exposed for HHI/concentration. Document, do not "fix".                                                                                                                                                                                                                      |
| PUB-1, PUB-3 (per-fill behavioral load)           | `SwapCreated` does not carry the MM's chosen load, the pool-load baseline, or the cap flag.                                      | **Closed by the single redeploy (§5.7):** `QuoteFilled(...,loadBps)` gives the non-circular MM load; `SwapPriced(...,fairPremium, …loads…, sigmaRefWad, cappedAtMaxIL)` gives the mechanical baseline + cap flag on all three paths. No archive call for load. Geometry still needs `NPM.positions` decode (archive, unchanged).                                                                                    |
| Signals 2 & 4 (latent demand / quote competition) | Unfilled `/quote` requests and previewed-but-not-bought interest never reach the chain (I7: an unchosen quote touches no state). | **OFF-CHAIN telemetry, by design** (§5.6) — and **already CAPTURING (correction #7):** the engine's `TelemetrySink` writes `DEMAND_LOG`/`COMPETITION_LOG` from the first interaction and the SDK `previewPremium` fires the ping NOW; the API just _reads_ these logs post-redeploy. NOT a contract event (on-chain would cost gas and break I7). Mandatory for the dynamic halves; structural halves are on-chain. |
| Signal 5 (net gamma)                              | No on-chain Greeks aggregator.                                                                                                   | **OFF-CHAIN compute** over the subgraph-tracked open swap set (§5.5), finite-differencing deployed `ILMath.computeIL` / `FairValueOracle.fairRate`. NOT an event.                                                                                                                                                                                                                                                   |
| PUB-2 (market enumeration)                        | No on-chain `getMarkets()` enumerator.                                                                                           | **Served via subgraph** `MarketRegistered` indexing. Optional future view `getMarkets() → bytes32[]`.                                                                                                                                                                                                                                                                                                               |
| LP-5 (fees earned vs premium paid)                | Inflexion contracts do not track NPM fees; "fees since creation" is Uniswap-side state.                                          | **Served**: live via NPM `tokensOwed`/feeGrowth read + `ILVault.FeesClaimed`; historical via subgraph indexing `FeesClaimed` + Uniswap `Collect`. No Inflexion contract change.                                                                                                                                                                                                                                     |
| LP-7 (already-protected dedupe)                   | No `isTokenIdProtected(tokenId)` getter.                                                                                         | **Served**: subgraph `Swap` by `tokenId`/`status=ACTIVE`; SDK fallback enumerates `swaps`. No contract change.                                                                                                                                                                                                                                                                                                      |
| MM-5 / hedging execution                          | On-chain inverse hedge (Panoptic/GammaSwap) is approximate and unexecuted.                                                       | **By design read-only** (analytics + caveat, §3.5). Not relied on for I1. No change.                                                                                                                                                                                                                                                                                                                                |

### 8.3 Explicitly NOT gaps (verified reachable, correcting mapper "partial/blocking" flags)

- **LP-3 `getPayoffCurve`** — fully reachable (grid over `settlePreview`/`ILMath.computeIL`). Resolved.
- **DEP-6 fine inventory (two skews separately, senior/junior split, per-market locked)** —
  fully reachable as an SDK composite read today (`inventory` + `seniorAssets`/`juniorAssets`
  - `lockedByMarket` + deployed `CvammPricing` skews). Resolved.
- **MM-1 first-class pool-price-to-beat** — reachable as one multicall (§4). Resolved/elevated.
- **`settlePreview` reachability** — callable via `eth_call` despite not being `view` (§3.6).

---

## 9. Build order (decided answer Q4)

1. **Now:** design all three layers (this doc) + **fully build `@inflexion/sdk`**
   (LpClient, DepositorClient, MmClient, DataClient, GreeksEngine, HedgeSuggester,
   the `CvammPricing` TS port with a parity test against the deployed lib, and the
   `getMarketPricing` multicall). The SDK re-exports `@inflexion/engine/quote`.
2. **Next task:** build `@inflexion/subgraph` (§6) then `@inflexion/api` (§7).
3. **Separate:** frontend (`apps/web`) consumes the SDK + API.
