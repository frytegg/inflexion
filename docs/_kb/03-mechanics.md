# 03 — Protocol Mechanics, Contracts & Lifecycle

> **Source-of-truth knowledge dump.** Every technical claim cites `file:line` against the
> live code (`packages/contracts/src/...`) and `spec.md`. Where the code and a doc-friendly
> phrasing differ, the **code wins** and the difference is flagged. Written to feed the public
> docs and the founder's judge Q&A. Live on **Arbitrum Sepolia (chainId 421614)**, fresh full
> redeploy **2026-06-05** (`deployments/arbitrum-sepolia.json`).

---

## 0. The 60-second mental model

Inflexion is a **collateralized bilateral derivatives market** for Uniswap v3 impermanent-loss
risk. An LP brings a **specific in-range v3 position** (its NFT), picks a duration (7/30/90d),
and pays a **fixed upfront premium**. At expiry the protocol pays the LP their realized IL,
**capped at MaxIL**, trustlessly, out of an underwriter's **pre-locked USDC collateral**.

- It is an **in-range convexity hedge**, NOT "IL insurance". Entry requires `Pa ≤ P0 ≤ Pb`
  (out-of-range is rejected at creation — `InflexionCore.sol:600-602`). Payout =
  `min(realized_IL, MaxIL)` (`InflexionCore.sol:1099`). The **cap is load-bearing** for the
  no-bad-debt guarantee.
- The underwriter is one of two rails into a **single settlement core**:
  - **Path A** — the **cvAMM** (`ConvexityVault`), a pooled, always-on, signature-free
    on-chain underwriter. `createSwapPathA` (`InflexionCore.sol:928`).
  - **Path B** — a **market maker** posting firm EIP-712 signed quotes (no last-look).
    `createSwap` (`InflexionCore.sol:827`).
  - `createSwapRouted` (`InflexionCore.sol:973`) gives the LP the **cheaper of {pool, MM}**.
- **No-bad-debt is exact ONLY under the full clause:** FULL collateralization + capped payoff
  + solvent USDC + oracle/settlement liveness + no rehypothecation breach. Never state it
  unqualified (spec §0, §7.5; `ConvexityVault.sol:27-31`).

Live lifecycle proof (2026-06-05, `deployments/arbitrum-sepolia.json:77-106`): a real
create→settle ran on a 300s market for **both** paths — Path A (swap #1) settled from the
`ConvexityVault`; `createSwapRouted` (swap #2) chose the MM because it strictly beat the pool,
and the MM's own collateral paid the settlement.

---

## 1. The three pillars (the conceptual spine — spec §3.0)

### Pillar 1 — On-chain published fair value (`FairValueOracle`)

`FairPremium = fairRate · MaxIL`, computed and **published on-chain**.

- **`MaxIL` is pure geometry**: the max in-range IL of the specific position, computable at
  creation from `(Pa, Pb, L, P0)`. Frozen at creation, **identical across all three durations**
  for a given position (`ILMath.computeMaxIL`, `ILMath.sol:37-52`).
- **`fairRate = E_Q[min(IL, MaxIL)] / MaxIL`** — the fraction of MaxIL the claim is worth under
  the risk-neutral measure. An **S-curve in `σ²·T`**: ≈0 calm/short, →1 violent/long.
  **`fairRate` carries ALL the vol/time dependence; MaxIL carries none.** This is why the
  cvAMM publishes **three different prices for the same position** (one per duration), all
  backed by the **same** MaxIL (spec §3.2, §3.3 Worked Example A).
- **`fairRate` is an EXACT closed form — not a fitted surface, no calibrated coefficients.**
  The capped v3 payoff `min(IL, MaxIL)` is piecewise (below-Pa linear; inside `[Pa,Pb]` a
  `c1·P − 2√P + c0` convex arm; above-Pb linear), each arm integrated against the lognormal
  density of `P_T` is a standard interval moment in the normal CDF Φ, so `FairPremium` is a
  finite **Φ-sum (~6–10 terms, Black–Scholes class)** — no Monte Carlo, no lookup table,
  evaluated live per quote (`FairValueOracle.fairRate`, `FairValueOracle.sol:85-150`). The
  **only stochastic input is `σ_ref`**.
- **The Φ-sum is NEVER reimplemented off-chain** (CLAUDE.md hard rule). The **production
  pricer is the Stylus `FairValueOracle`** (`0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c` on
  Arbitrum Sepolia, machine-precise to ~6.7×10⁻¹⁵; `deployments/arbitrum-sepolia.json:42-47`).
  The Solidity `src/FairValueOracle.sol` is a revm-testable CI cross-check (Φ via
  Abramowitz–Stegun, ~1e-7), **not** a second production oracle (header `FairValueOracle.sol:26-31`).
  Verified exact vs the repo's own `il.py` to ~5×10⁻¹¹ (spec §3.0).
- The Φ-sum is **L-independent**: it runs in normalized units `P0=1, L=1`, so it depends only
  on `a = Pa/P0`, `b = Pb/P0`, `σ_ref`, `T` (`FairValueOracle.sol:23-25, 104-105`).
- **Theory anchors (cite, do not re-derive):** Lipton–Lucic–Sepp 2025 (an IL-protection claim
  is statically replicable by a strip of vanilla options ⇒ priceable + hedgeable) and
  Milionis–Moallemi–Roughgarden 2022 (LVR has a closed form ∝ instantaneous variance). These
  are the theory anchors for *why* the claim is priceable — **NOT** the pricer; the exact
  Φ-sum is the pricer (spec §3.0).

### Pillar 2 — The cvAMM (the centrepiece, Path A — `ConvexityVault`)

A **pooled passive underwriter**: ERC-4626-style USDC vault, **dual-tranche SENIOR/JUNIOR
from launch** (deployed `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d`). Always quoting, quotes
algorithmically on-chain off `FairPremium`, **contractually price-capped by I10**. Solves
cold-start (always a price), overcharge (capped in code), intra-pair diversification, and
depositor-viability (senior savings account vs junior vol-seller). **The floor of liquidity.**

### Pillar 3 — The MM competition rail (Path B)

MMs compete with firm EIP-712 signed quotes **below** the pool. Two load-bearing reasons they
matter (state both in the pitch — spec §3.0, §10): (1) **hedged MMs export short-gamma risk
OUT of the system** to the global options market (Deribit/Panoptic) — a closed pool can only
relocate risk, not shrink it; (2) **forward-looking-vol MMs correct the pool's structural
backward-looking bias** (the pool prices off realized `σ_ref`, MMs off implied/forward vol).
**The ceiling of price** — an MM only wins when it genuinely beats the capped pool price.

---

## 2. The math foundation

### 2.1 IL formula (spec §3.1; `ILMath.sol:87-153`)

Price `P` = price of token0 in token1 (e.g. ETH in USDC; token1 is the numéraire — typically
USDC, 6 decimals). Position: liquidity `L`, range `[Pa, Pb]`, opened/snapshotted at `P0`.

```
Hold value at settlement P_T:  V_hold = amount0_entry · P_T + amount1_entry    (ILMath.sol:122-128)
LP value V_lp(P_T), three regimes (ILMath._vLp, ILMath.sol:101-119):
  below Pa (fully token0):  V_lp = amount0(Pa) · P_T
  above Pb (fully token1):  V_lp = amount1(Pb)              ← constant
  in range:                 V_lp = amount0(P_T) · P_T + amount1(P_T)
realized_IL = V_hold > V_lp ? V_hold − V_lp : 0             ← I3 guarded subtraction (ILMath.sol:97)
```

**Entry-snapshot semantics (spec §3.1 F-#10):** all entry quantities are snapshotted **at swap
creation**, not at the LP's original mint. `P0` is the oracle price at `createSwap`; the swap
covers IL accruing **from creation onward** — any IL the LP already bore stays theirs. `L` is
read once at creation and **stored** in the `SwapRecord`; settlement uses the stored `L`, never
a re-read (I6 — `InflexionCore.sol:603, 744, 1094-1096`).

### 2.2 MaxIL — the collateral unit AND the coverage cap (spec §3.2; `ILMath.sol:37-52`)

`IL(P)` is **convex on `[Pa, Pb]`** (V_hold affine, V_lp strictly concave), so its max *while
price stays in range* is at a boundary:

```
MaxIL = max( IL(Pa), IL(Pb) )      (ILMath.sol:49-51)
```

**Critical correctness point:** MaxIL is **not** the global worst case. Above Pb the LP is fully
in token1 (constant value) while hold grows linearly, so absolute IL is **unbounded** beyond
range. The protocol therefore covers `covered_payoff = min(realized_IL, MaxIL)`. Because
`collateral_FULL == MaxIL` and `covered_payoff ≤ MaxIL` **by construction of the cap**, FULL
mode cannot produce bad debt under any price path. **The cap is the product, not a defect:**
beyond-range loss is *directional* loss (foregone spot upside), not the *impermanent* loss the
LP set out to hedge.

**MaxIL is BOTH (a) the load-bearing cap AND (b) the unit of risk.** Because it is pure
geometry, frozen at creation, identical across durations, and L-independent in the fair-rate
sense, positions become **FUNGIBLE** to an underwriter within a market. This is *why* an MM
quote is **per-market, NEVER per-NFT** (see §5.2). Note (spec §3.3): MaxIL is a
collateral/normalization unit, **not** a risk metric — two positions with identical MaxIL can
carry very different risk; both rails price `E_Q[min(IL,MaxIL)]/MaxIL` for the *specific
geometry* (distance-to-edge included).

Reference magnitudes (geometric-symmetric range, spec §3.2, from `il.py`):
`±5% → MaxIL ≈ 1.27% of V0`, `±10% → 2.56%`, `±20% → 5.23%`, `±50% → 13.76%`.

**Why premium is % of MaxIL, not % of V0 (the key pricing innovation — spec §3.3):** if premium
were `X% of V0`, a narrow range (tiny MaxIL) gives the underwriter enormous ROC and a wide range
(huge MaxIL) gives insufficient ROC → underwriters adversely select against wide ranges →
liquidity fragments. With premium as `X% of MaxIL`, the underwriter posts collateral = MaxIL and
earns `X%` ROC **regardless of range width** → indifference to width → full depth.

### 2.3 No geometry asymmetry (spec §3.4 — the old "ratio band" story is VOID)

v3 position params (`token0/1`, `fee`, `tickLower/Upper`, `liquidity`) are **public on-chain**
via `positions(tokenId)`. The old "LP knows the range, MM does not, so MM quotes a band to
avoid adverse selection" framing is **deleted**. Both rails read the exact geometry and price
the specific position. `minMaxILRatioBps` / `maxMaxILRatioBps` survive **only as an optional
Path-B convenience filter** ("I only write 2%–7% MaxIL/V0 positions") — never the pricing input.

---

## 3. The pricing stack (spec §3.3; `CvammPricing.sol`)

Three layers, kept separate in code and pitch:

**Layer 1 — MaxIL (on-chain, `ILMath`).** The collateral unit. Pure geometry, vol/time
independent, identical across durations.

**Layer 2 — `fairRate` + `FairPremium` (on-chain, published — Pillar 1).**
```
fairRate    = E_Q[min(IL, MaxIL)] / MaxIL     // exact Φ-sum, S-curve in σ²·T
FairPremium = fairRate · MaxIL                // FairValueOracle.fairPremium (FairValueOracle.sol:69-79)
```

**Layer 3 — the load/skew stack + the I10 cap (on-chain, `CvammPricing.sol`).**
```
premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)
        , HARD-CAPPED at FairPremium · (1 + maxLoad)        // I10, BY CONSTRUCTION
```
- **`baseLoad`** — the structural volatility-risk premium over fair value. Keyed by σ_ref
  regime (calm / normal / stressed bands) — `CvammPricing.baseLoadWad` (`CvammPricing.sol:47-55`).
  Motivated by the lone-writer CVaR gap (~91–100% of MaxIL for a single writer) that
  diversification collapses (~78.7% per-contract as N:1→100) — the gap is the pool's reason to
  exist (spec §3.3, §9).
- **`util_skew(u)`**, `u = locked/total` — flat below a knee, convex above, capped. Rises as
  the pool nears full commitment so marginal capacity is priced up *before* over-commitment;
  this wires directly into the run defense (`CvammPricing.utilSkewWad`, `CvammPricing.sol:58-67`).
- **`dispersion_skew(h)`**, `h` = normalized coverage HHI (Herfindahl) — the honest single-pair
  concentration analogue: many positions bunched at one edge all hit MaxIL together. Capped
  (`CvammPricing.dispSkewWad`, `CvammPricing.sol:70-77`). HHI is computed O(1) from an
  incremental `Σ lockedByMarket²` accumulator (`ConvexityVault.concentrationWad`,
  `ConvexityVault.sol:160-166`).
- **The I10 clamp:** `totalLoad = min(baseLoad + util_skew + dispersion_skew, maxLoad)`
  (`CvammPricing.totalLoadWad`, `CvammPricing.sol:80-89`), then
  `premium = ceil(FairPremium · (1 + totalLoad))` (round UP, F-#8 — `CvammPricing.premiumFromLoad`,
  `CvammPricing.sol:113-118`).

WAD-scaled (`1e18 = 1.0 = 100% load`; `1 bps = 1e14 WAD`, `CvammPricing.sol:21-23`). **Both
paths additionally cap the charged premium at MaxIL** — "never charge more than the max possible
payout" (`InflexionCore.sol:637-641, 657-661`).

**No primitive is hardcoded.** `baseLoad` regimes, both skew curves (knee/slope/power/cap), and
`maxLoadBps` come from `quant/params.json` (cvAMM block) via `LoadParams`
(`CvammPricing.sol:25-44`; set by owner `InflexionCore.setLoadParams`, `InflexionCore.sol:423-428`).
`fairRate` itself has **no** calibrated coefficients (exact closed form). Hardcoding any
load/skew/σ primitive is the exact failure the audit flagged (CLAUDE.md).

**Both paths use the same fair value.** Path A computes the load stack on-chain; Path B carries
a `loadBps` and the contract derives `premium = ceil(FairPremium · (1 + loadBps/1e4))`, capped
at MaxIL, requiring `loadBps ≤ maxLoadBps` (I10 on Path B — `_pathBPremiumFromFair`,
`InflexionCore.sol:613-620`). `maxLoad` is the rate; on-chain it is `maxLoadBps` (basis points).

---

## 4. The full lifecycle, step by step

`SwapRecord` (`InflexionCore.sol:169-185`) tracks each swap through
`Status: UNINITIALIZED → ACTIVE → SETTLED` (`InflexionCore.sol:112-116`). Key fields:
`tokenId, lp, mm (= counterparty: the ConvexityVault on Path A, the MM on Path B), V0, maxIL,
collateral (FULL: == maxIL), premium, model, settlement, createdAt, expiry, amount0Entry,
amount1Entry, liquidity (I6 — stored once)`.

> **Doc-vs-spec note:** the spec §5.1 lists a `path` (uint8) field and renames the field to
> `counterparty`. **The shipped struct keeps the field named `mm`** and has **no `path`
> field** — `settle` infers the rail from `s.mm == address(convexityVault)`
> (`InflexionCore.sol:1105`). The `SwapRouted`/`SwapPriced` events carry the path for the data
> moat. (Confirmed in code; flagged so docs match the contract.)

### 4.0 Prerequisite: `registerMarket` (`InflexionCore.sol:346-376`)

Owner registers each market. `marketId = keccak256(abi.encodePacked(token0, token1, fee,
durationSeconds))` (`InflexionCore.sol:355`). For ETH/USDC that is **3 fee tiers × 3 durations
= 9 marketIds**, all underwritten by **one** `ConvexityVault` with fungible capital.
Hardening: (1) the oracle token must be one of the pair (`InflexionCore.sol:352-354`);
(2) **decimals are read on-chain**, never trusted from calldata — one wrong digit would
mis-scale every price ~10× (`InflexionCore.sol:368-372`); (3) **price-config immutability** —
the oracle orientation is frozen once set, so re-registering can never re-price an active swap
(`InflexionCore.sol:361-364`). Path A markets must additionally be opted in via
`setCvammEnabled` (`InflexionCore.sol:431-437`).

### 4.1 CREATE — shared PHASE-1 read prologue (`_prepareSwap`, `InflexionCore.sol:580-608`)

Identical for all three entry points (`createSwap` / `createSwapPathA` / `createSwapRouted`).
A `view` function (the only non-view step, the VolOracle poke, lives in `_fairPremium`):

1. **Ownership.** `ownerOf(tokenId) == msg.sender` else `NotPositionOwner`
   (`InflexionCore.sol:585-586`).
2. **Position read + marketId cross-check.** Read `positions(tokenId)`; derive `marketId` from
   the live `token0/token1/fee` and the market's `durationSeconds`, require it equals the
   requested marketId else `MarketMismatch` (`InflexionCore.sol:588-591`).
3. **Pa/Pb from ticks** via `TickMath.getSqrtRatioAtTick` (`InflexionCore.sol:593-594`) — the
   LP cannot lie about the range.
4. **P0 pinned to Chainlink ON-CHAIN.** `oracle.getPrice(oracleToken)` → `_oracleSqrtPriceX96`;
   **never caller-supplied** (`InflexionCore.sol:596-598`). The same read (`g.livePrice`) is
   reused for the Path-B band check (zero extra oracle cost).
5. **In-range gate (entry must be in range).** `require Pa ≤ P0 ≤ Pb` else `PositionOutOfRange`
   (`InflexionCore.sol:600-602`). This is the `Pa ≤ P0 ≤ Pb` rule that makes this a convexity
   hedge, not insurance.
6. **MaxIL** = `ilMath.computeMaxIL(...)` (`InflexionCore.sol:604`).
7. **Entry-amount snapshot** `(a0, a1)` via `SwapMath.entryAmounts` (`InflexionCore.sol:605`).
8. **V0** in token1 (numéraire) units = `amount0InToken1(a0) + a1` (`InflexionCore.sol:606-607`).

`L` is captured here (`g.liquidity`, `InflexionCore.sol:603`) and stored at execution (I6).

### 4.2 CREATE — fair value (`_fairPremium`, `InflexionCore.sol:1020-1035`)

1. Convert geometry to ratios `a = Pa/P0`, `b = Pb/P0` (WAD) from sqrt prices
   (`InflexionCore.sol:1028-1031`).
2. **Poke the VolOracle** to refresh `σ_ref` — permissionless, **no-op if too soon** (folded
   into createSwap so the vol estimate stays fresh without a dedicated keeper —
   `InflexionCore.sol:1033`; `VolOracle.poke`, `VolOracle.sol:84-123`).
3. Read `FairValueOracle.fairPremium(oracleToken, a, b, durationSeconds, maxIL)` → returns
   `(premium, fairRateWad, sigmaRefWad)` (`InflexionCore.sol:1034`; `FairValueOracle.sol:69-79`).
   This is the **single source** of fair value for both rails — the router pokes once and prices
   both rails off the same FairPremium (`InflexionCore.sol:990-994`).

### 4.3 CREATE — the three entry points, CEI (Checks-Effects-Interactions)

All enforce `MIN_POSITION_V0 = $100` and `MIN_PREMIUM = $1` to block dust swaps that grief
capacity and close the integer-division free-coverage edge (`InflexionCore.sol:78-82`), and a
final `maxPremium` LP slippage guard.

**Path A — `createSwapPathA` (`InflexionCore.sol:928-953`), signature-free.**
- Requires the cvAMM wired (`convexityVault != 0`) and the market `active` + `cvammEnabled`.
- Price = `_pricePathA` (`InflexionCore.sol:1039-1045`) → on-chain FairPremium + the I10-clamped
  load stack, capped at MaxIL.
- EFFECTS+INTERACTIONS in `_executePathA` (`InflexionCore.sol:720-763`):
  `convexityVault.lockCollateral(marketId, maxIL)` (checks free + senior protection) →
  `nextSwapId++` → write `SwapRecord{ mm: address(convexityVault), collateral: maxIL, ... }` →
  pull premium USDC → take NFT into `ILVault` → **premium split**: `poolCut = 99%`
  accrued into the vault via `accruePremium`, `treasuryCut = 1%` to treasury
  (`InflexionCore.sol:752-758`). **No keeper, no signed quote, no validity clock, no relayer.**

**Path B — `createSwap(quote, signature, tokenId, maxPremium)` (`InflexionCore.sol:827-910`),
the full signed-quote rail. PHASE-2 checks (revert path), in order:**
- `markets[quote.marketId].active` (`InflexionCore.sol:835-836`).
- Signature: `SignatureChecker.isValidSignatureNow` (EIP-712 ECDSA **or EIP-1271** contract
  signer — `InflexionCore.sol:845`; via `QuoteVerification.isSignatureValid`).
- `fairValueOracle` wired, `loadBps ≤ maxLoadBps` else `LoadExceedsMax`
  (`InflexionCore.sol:854-857`) — **I10 on Path B**.
- premium = `_pricePathB` (FairPremium·(1+loadBps), capped at MaxIL — `InflexionCore.sol:859`).
- model == FULL else `UnsupportedModel`; dust V0 / premium guards (`InflexionCore.sol:864-868`).
- **ratio band:** `ratioBps = maxIL·1e4/V0 ∈ [minMaxILRatioBps, maxMaxILRatioBps]` else
  `RatioOutOfBand` (`InflexionCore.sol:870-873`) — the per-market MaxIL-ratio filter (§5.2).
- `validUntil > now` (`QuoteExpired`) and `secondsAhead ∈ [5s, 15s]` (`ValidityOutOfBand`)
  (`InflexionCore.sol:875-881`).
- `!isNonceUsed(mm, nonce)` else `NonceAlreadyUsed` (`InflexionCore.sol:883-885`).
- `priceBandBps ∈ [25, 500]` (`PriceBandOutOfProtocolRange`) and the **oracle-anchored band**
  `absBps(P_live, quotePrice) ≤ priceBandBps` else `PriceOutOfBand` — Fork 2 / **I9**, reusing
  `g.livePrice` (`InflexionCore.sol:887-895`).
- `consumedNotional[quoteId] + V0 ≤ maxNotionalV0` else `CapacityExceeded` — F-#6 / **I7**
  (`InflexionCore.sol:897-899`).
- `underwriterVault.availableBalance(mm) ≥ maxIL` else `MMUndercollateralised`
  (`InflexionCore.sol:901-902`).
- premium ≤ maxPremium else `PremiumExceedsSlippage` (`InflexionCore.sol:904`).
- EFFECTS+INTERACTIONS in `_executePathB` (`InflexionCore.sol:768-810`): the **only** place
  Path-B state mutates — `consumedNotional[quoteId] += V0` → `_useNonce(mm, nonce)` →
  `underwriterVault.lockCollateral(mm, maxIL)` → write `SwapRecord{ mm: quote.mm, ... }` →
  pull premium → take NFT → **premium split 99% to the MM, 1% to treasury** (no tranche split
  on Path B — `InflexionCore.sol:802-806`) → emit `SwapCreated` + `QuoteFilled`.

**Routed — `createSwapRouted(quote, signature, tokenId, maxPremium)` (`InflexionCore.sol:973-1014`).**
- Pool must be wired + market `cvammEnabled` (the always-on floor — else there's nothing to
  fall back to ⇒ revert, `InflexionCore.sol:981-986`).
- Price **both rails off the SAME FairPremium** (single poke): `premiumA = _pricePathAFromFair`,
  `(usableB, premiumB) = _quoteUsableAndPremiumB` (`InflexionCore.sol:991-994`).
- **`_quoteUsableAndPremiumB` (`InflexionCore.sol:682-715`) is the NON-reverting mirror** of
  Path-B's gates: it returns `(false, 0)` if the quote is absent / wrong-model / over-load /
  expired / out-of-validity-band / bad-priceBand / out-of-ratio / nonce-used / zero-price /
  out-of-oracle-band / over-capacity / MM-undercollateralized / bad-sig / dust. It is **`view`**
  — reads only (`isNonceUsed`, `consumedNotional`, `availableBalance`, signature STATICCALL),
  **never mutates a nonce/capacity/lock**, so an unchosen quote leaves zero trace (I7 preserved).
- **Route:** `useB = usableB && premiumB < premiumA` — the MM wins **only if it STRICTLY beats**
  the pool; a **tie resolves to Path A** (the dependency-free always-on rail; an MM cannot
  divert flow by matching — `InflexionCore.sol:996-999`).
- **An absent / expired / stale / over-band / over-load / zero-price / undercollateralized MM
  quote FALLS BACK to the pool — it NEVER reverts.** Only protocol-level failures
  (market/owner/range/dust/slippage/pool-unwired) revert (`InflexionCore.sol:966-969`).
- **ONLY the executed path mutates state** (`InflexionCore.sol:1005-1012`) — preserves I7.
- Emits `SwapRouted(swapId, pathB, premiumA, premiumB)` (`InflexionCore.sol:1013`) — the
  cheapest-wins routing is auditable on-chain.

### 4.4 ACTIVE (spec §5.3)

- NFT held in `ILVault`; the LP keeps fee accrual and may `claimFees(tokenId)` anytime — **no
  rehypothecation**.
- **Position is frozen** while in custody: the LP cannot re-range, add/remove liquidity, or exit
  early — a real opportunity cost and a key reason short durations exist.
- **Liquidity-modification safety (F-#2 / I6):** anyone can `increaseLiquidity` on a v3 NFT
  (not owner-gated), but settlement uses the **stored `L`**, so extra liquidity is simply
  returned with the NFT and can never inflate payout above MaxIL.
- **What is hedged (F-#14):** the product hedges **gross in-range IL**, not net P&L. The LP also
  earns Uniswap fees, so total = fees − IL + payout − premium can be positive — correct, not a
  leak. I4 (LP never profits *from the swap*) is about the payout, which is still 0 whenever IL
  is 0.
- FULL: no monitoring needed — liquidation is mathematically impossible.

### 4.5 SETTLE — `settle(swapId, hintRoundId)` (`InflexionCore.sol:1066-1115`), callable by anyone at `block.timestamp ≥ expiry`

The **untouched settlement core** — identical math regardless of which rail opened the swap.

1. `status == ACTIVE` and `now ≥ expiry` else revert (`InflexionCore.sol:1071-1072`).
2. **`status = SETTLED` FIRST** — strict CEI; a malicious oracle/ilMath re-entering settle on
   the same swapId would hit the ACTIVE check and revert (`InflexionCore.sol:1079`).
3. **Pin price at expiry:** `oracle.getSettlementPrice(oracleToken, expiry, hintRoundId)` →
   reverts on sequencer-down/grace/staleness/lone-spike/wrong-round (§6 — `InflexionCore.sol:1084`).
   The settlement sqrt price is derived on-chain from the Chainlink round-at-T, **never
   caller-supplied** (`InflexionCore.sol:1086-1089`). The `hintRoundId` is supplied by the
   keeper and **verified** by the oracle (round-at-T pinning kills the settle-timing game).
4. **IL with STORED `L`** (I6): `ilMath.computeIL(sqrtP_T, sqrtPa, sqrtPb, s.liquidity,
   amount0Entry, amount1Entry)` (`InflexionCore.sol:1094-1096`).
5. **Cap (I1 + I2):** `payout = realisedIL > maxIL ? maxIL : realisedIL` (`InflexionCore.sol:1099`).
6. **Vault dispatch by rail** (`InflexionCore.sol:1105-1109`): if `s.mm == address(convexityVault)`
   → `ConvexityVault.releaseAndDistribute(marketId, lp, payout, collateral)`; else
   `UnderwriterVault.releaseAndDistribute(mm, lp, payout, collateral)`. **LP receives `payout`;
   the counterparty keeps `collateral − payout`** (the residual MaxIL).
7. **NFT returns to the LP** (`ilVault.returnNFT`, `InflexionCore.sol:1112`).
8. Emit `SwapSettled(id, realisedIL, payout, settlementPrice)` (`InflexionCore.sol:1114`).

If the oracle is unhealthy, settle reverts and is retryable — neither party can exploit
downtime; the liveness backstop (I8) guarantees eventual success (§6).

`settlePreview(swapId, sqrtPTX96)` (`InflexionCore.sol:516-528`) computes the hypothetical
payout at any price without state change — used by the invariant suite and frontends.

---

## 5. The two paths in detail

### 5.1 One settlement core, two upstream rails (spec §4.0)

Every difference between Path A and Path B is in `createSwap` pricing/locking — **upstream of
settle**. The core (`settle`, the `min(IL,MaxIL)` cap, the MaxIL formula, I1–I9) is **identical
regardless of which rail opened the swap**. **The FULL no-bad-debt guarantee is independent of
matching** — it is enforced at on-chain settlement (collateral = MaxIL, payout capped),
regardless of how the quote was discovered.

| | **Path A — cvAMM** | **Path B — MM** |
|---|---|---|
| Counterparty | `ConvexityVault` (pool) | a single MM |
| Signature | none (signature-free at sale) | EIP-712 / EIP-1271 firm quote |
| Collateral home | `ConvexityVault` (pooled, dual-tranche) | `UnderwriterVault` (per-MM) |
| Pricing | on-chain load stack, I10 clamp | `loadBps` over FairPremium, `≤ maxLoadBps` |
| Premium split | 99% into pool (tranche split), 1% treasury | 99% MM, 1% treasury |
| Validity clock / nonces / band | none | `validUntil` + bitmap nonce + oracle band |
| Relayer needed | no (pure on-chain) | yes (off-chain quote book) |
| Role | floor of liquidity (always quotes) | ceiling of price (wins only by beating pool) |

### 5.2 The SignedQuote + the per-market MaxIL-ratio band (positions are FUNGIBLE)

`SignedQuote` struct (`InflexionCore.sol:122-136`):
```solidity
struct SignedQuote {
    address mm;                 // signer; collateral in UnderwriterVault (or EIP-1271 signer)
    bytes32 marketId;           // keccak(token0, token1, fee, durationSeconds) — PER-MARKET
    uint16  loadBps;            // load over on-chain FairPremium; premium = FairPremium·(1+loadBps/1e4)
    uint16  minMaxILRatioBps;   // per-market MaxIL/V0 band lower bound
    uint16  maxMaxILRatioBps;   // per-market MaxIL/V0 band upper bound
    uint128 quotePrice;         // oracle price at signing — band-check anchor (Fork 2)
    uint16  priceBandBps;       // ± band around quotePrice; auto-voids on-chain if exceeded
    uint8   model;              // CollateralModel.FULL
    uint16  partialRatioBps;    // 0 in FULL
    uint128 maxNotionalV0;      // capacity this quote may consume (in V0 units)
    uint64  validUntil;         // absolute expiry ts; band [5s, 15s]
    bytes32 quoteId;            // on-chain capacity + replay tracking key
    uint256 nonce;              // Permit2-style bitmap (word<<8 | bit): selective cancel
    // bytes signature — passed alongside, EIP-712 (ECDSA or EIP-1271)
}
```

**THERE IS NO `tokenId` IN THE QUOTE.** The quote is **PER-MARKET, never per-NFT.** This is the
direct mechanical consequence of MaxIL being the fungible unit of risk (§2.2): an MM quotes a
single `(load, MaxIL-ratio band, capacity)` for an entire `marketId`, and **any** LP position in
that market fills against it. At fill, the contract computes the LP's own
`ratioBps = maxIL · 1e4 / V0` and checks it lies in `[minMaxILRatioBps, maxMaxILRatioBps]` else
reverts `RatioOutOfBand` (`InflexionCore.sol:870-873`; mirrored non-reverting in the router,
`InflexionCore.sol:696-697`). So the MM expresses "I write positions whose MaxIL is 2%–7% of V0"
once, and the contract enforces it per-fill — positions within the band are interchangeable.
(Spec §3.4: post-pivot this band is a **convenience filter**, not an asymmetry fix — geometry is
public.)

`SIGNED_QUOTE_TYPEHASH` (`InflexionCore.sol:141-143`) bumped for the `loadBps` schema; signature
verification moved from `ECDSA.recover` to OZ `SignatureChecker.isValidSignatureNow` to support
**EIP-1271 contract signers** — so the `ConvexityVault` can own its collateral directly with no
keeper EOA (spec §4.7).

### 5.3 Firm quotes, no last-look — three deterministic on-chain protections (spec §4.3, §4.3.3)

The MM cannot reject at settlement. MM protection is purely deterministic at fill (no MM
discretion ⇒ **not** last-look):
1. **Oracle-anchored price band (I9 / Fork 2).** `quotePrice` (oracle price the MM saw at
   signing) + `priceBandBps`; at fill, `require absBps(P_live, quotePrice) ≤ priceBandBps`
   (`InflexionCore.sol:892-895`). Defaults: `PRICE_BAND_MIN_BPS = 25` (0.25%),
   `PRICE_BAND_MAX_BPS = 500` (5%), MM-set default 100 (1%) (`InflexionCore.sol:85-86`, spec
   §4.3.3). Kills the dominant pickoff (gap-on-stale-quote) — signed payloads are **bearer
   instruments** that survive past off-chain cancel, so an on-chain band is required.
2. **Short `validUntil` window** — band `[5s, 15s]` (`VALIDITY_MIN_S/MAX_S`,
   `InflexionCore.sol:89-90`), default 8s. Bounds the leakage interval.
3. **On-chain selective nonce invalidation** — Permit2-style bitmap; cancel one quote by
   flipping one bit (never cancel-all, F-#7 — `cancelNonces`, `InflexionCore.sol:456-466`;
   `isNonceUsed`, `:445-452`; `_useNonce`, `:469-478`).

**Replay/capacity (F-#6 / I7).** On-chain is authoritative: `consumedNotional[quoteId] + V0 ≤
maxNotionalV0`, incremented atomically in EFFECTS before any external call
(`InflexionCore.sol:776`). `maxNotionalV0` is denominated in **V0 (position value), not
collateral**.

**Trust model (spec §4.5).** Settlement is non-custodial. The off-chain engine (Path B only)
**cannot** steal funds (on-chain settle against the counterparty's own collateral), **cannot**
forge quotes (all MM-signed), **cannot** force a stale quote (validUntil + nonce + band),
**cannot censor Path A at all** (it needs no engine). It **can** censor/reorder Path-B flow
(liveness, not solvency) — mitigated by a direct-to-contract fallback (an LP holding any valid
signed quote can call `createSwap` directly, bypassing the engine).

---

## 6. The vaults

### 6.1 `ConvexityVault` — dual-tranche cvAMM pool (Path A; `ConvexityVault.sol`)

One vault per pair, fungible USDC backing all 9 marketIds. **Dual-tranche SENIOR / JUNIOR from
launch** (`Tranche` enum via `IConvexityVault`).

**Accounting** (`ConvexityVault.sol:57-71`): separate `seniorAssets/juniorAssets`,
`seniorShares/juniorShares`, `seniorBalanceOf/juniorBalanceOf`; `totalLocked` +
`lockedByMarket[marketId]` + `sumLockedSq` (the O(1) HHI accumulator). `totalAssets =
seniorAssets + juniorAssets`; `freeAssets = totalAssets − totalLocked`
(`ConvexityVault.sol:147-153`).

**The KEY structural invariant — `totalLocked ≤ juniorAssets`** — enforced at **every**
`lockCollateral` (`ConvexityVault.sol:291-293`, `SeniorProtectionBreached`). Since every payout
≤ its MaxIL = its locked amount, `Σ payouts ≤ totalLocked ≤ juniorAssets`, so the
**junior-first-loss waterfall absorbs ALL underwriting loss before senior is ever touched**.
This is the code form of the roadmap's "enforce `u ≤ 1−sf`", made **adaptive to the actual
junior buffer** (safer than a fixed ratio). With `sf = 0.60` (the P1.13 target ratio, UX/
incentive — NOT the hard cap), junior = `1 − sf = 0.40`, so `totalLocked ≤ juniorAssets`
is exactly `u ≤ 0.40 = 1 − sf` (spec §8.2).

**Lock** (`lockCollateral`, `ConvexityVault.sol:284-300`): require `free ≥ amount`
(`InsufficientFree`) AND `totalLocked + amount ≤ juniorAssets` (`SeniorProtectionBreached`);
update HHI accumulator `sumLockedSq += amt² + 2·x·amt`.

**Settle** (`releaseAndDistribute`, `ConvexityVault.sol:303-330`): require `payout ≤ lockedAmount`
(`PayoutExceedsCollateral`) and `lockedAmount ≤ lockedByMarket[marketId]`; unlock collateral;
apply the loss **junior-first** — `juniorLoss = min(payout, juniorAssets)`, `seniorLoss =
payout − juniorLoss` (the `min` is defense-in-depth; by the invariant junior absorbs it fully —
`ConvexityVault.sol:321-328`); transfer `payout` to the LP; emit `JuniorLoss`.

**Premium accrual** (`accruePremium`, `ConvexityVault.sol:271-281`): `toSenior = amount ·
seniorPremiumShareBps / 1e4`, `toJunior = remainder`. So senior is a low-yield "convexity
savings account" and junior is the high-APY vol tranche. `seniorPremiumShareBps` is immutable,
from `params.json` (`ConvexityVault.sol:48-51, 115-125`).

**Run defense** (`ConvexityVault.sol:201-265`): deposits are instant; withdrawals are
**cooldown-gated** (`requestWithdrawal` → `withdraw` after `withdrawalCooldown`) and **junior
cannot be drawn below `totalLocked`** (`JuniorBelowLocked`, `ConvexityVault.sol:257`) — the same
locked/free accounting that prices `util_skew` up before over-commitment also prevents a run.

**CAPITAL IS NOT GUARANTEED for either tranche** (`ConvexityVault.sol:27-31`, spec §7.5). Senior
is structurally protected from **underwriting** loss only — **NOT** from systemic failure (USDC
depeg, oracle/settlement fault, contract bug). Two never-merged claims: (1) LPs are always paid
(no bad debt, FULL, I1, qualified); (2) depositors can lose principal (junior first; senior in
the systemic tail). Real P1.13 single-asset bare-pool numbers (`u=0.40`, spec §7.5): 3y CAGR
122%/50%/247% (median/p10/p90), P(losing month) 26.5%, worst month −26.8%, P(3y DD>50%) 2.7%;
**senior P(loss)=0** (holds only while `u ≤ 1−sf`), **junior worst −67%**.

### 6.2 `UnderwriterVault` — per-MM collateral (Path B; `UnderwriterVault.sol`)

One pool per MM. `deposited[mm]`, `locked[mm]`, `availableBalance = deposited − locked`
(`UnderwriterVault.sol:33-37, 108-113`). **Invariant I5: `locked ≤ deposited` by construction**
— `lockCollateral` requires `available ≥ amount` (`:148-157`); `releaseAndDistribute` requires
`payout ≤ lockedAmount ≤ locked[mm]` (`:164-185`). On settle, the MM keeps `collateral − payout`
and the LP gets `payout` from the MM's own pool. `CapitalLow` event fires when available drops
below 20% of deposited (`:42, 190-198`).

Both vaults wire `core` once then **freeze** it one-way (`setCore`/`freezeCore`); only `core`
can lock/release.

---

## 7. The oracles

### 7.1 `OracleManager` — entry P0 + settlement round (spec §6.1–§6.4)

- **Entry (`getPrice`)** — current Chainlink `latestRoundData`, health-gated (sequencer up +
  grace, staleness), no lone-spike (it's the current price). Pins P0 on-chain.
- **Settlement (`getSettlementPrice(token, expiry, hintRoundId)`)** — pins the price to the
  **Chainlink round ACTIVE AT expiry T** (`updatedAt ≤ expiry < nextUpdatedAt`) so no party can
  pick a favorable instant by timing `settle` (fairness). Gated by: sequencer uptime +
  `GRACE_PERIOD` (3600s), `MAX_STALENESS` (90,000s = 86,400 heartbeat + 1h buffer), and a
  **lone-spike sanity check** — a glitched print differs from **both** immediate neighbors by
  `≥ LONE_SPIKE_BPS` (500 = 5%); a real fast move is sustained so the next round confirms it and
  the check passes. The Uniswap v3 TWAP is **advisory only** (emitted, never reverts).
- **Liveness backstop (Fork 1 / I8):** if the lone-spike check defers, settle retries; past
  `LIVENESS_WINDOW` (86,400s / 24h) the Chainlink-at-T price is accepted **unconditionally** —
  funds can never lock indefinitely. Worst-case `settle` succeeds by `expiry + LIVENESS_WINDOW +
  MAX_STALENESS + GRACE_PERIOD` (spec §13 I8).
- **Arbitrum Sepolia feeds** (`deployments/arbitrum-sepolia.json:5-21`): ETH/USD
  `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165`, BTC/USD `0x56a43EB…`, ARB/USD `0xD1092a65…`,
  USDC/USD `0x0153002d…`. **No sequencer uptime feed exists on Sepolia** — `OracleManager`
  treats `sequencerFeed == address(0)` as skip-check (safe on testnet; **must** be set before
  mainnet). Testnet feeds tick ~120s; `MAX_STALENESS` still set to 90,000s so the same value
  works on either chain.

### 7.2 `VolOracle` — `σ_ref` (the only stochastic pricing input; `VolOracle.sol`)

```
σ_ref = max( σ_short, σ_long, floor )     (VolOracle._sigmaRef, VolOracle.sol:190-197)
```
- `σ_short`, `σ_long` are **time-aware EWMAs of Chainlink log-returns** over two halflives
  (`VolOracle.sol:43-44, 169-180`). Each `poke` folds the latest price into per-second variance,
  annualizes (`× 365-day year`), and takes the conservative max with a hard `floor`.
- **`poke` is permissionless and a no-op when `dt < minSampleInterval`** — safe to fold into
  `createSwap` so micro-samples can't blow up `r²/dt` (`VolOracle.sol:102-107`). `dt` is clamped
  to `[minSampleInterval, maxSampleInterval]` so one huge gap can neither divide-by-tiny-dt nor
  over-weight a sample (`VolOracle.sol:108`).
- **First poke seeds both windows at the floor** so the first reads are conservative
  (`VolOracle.sol:90-100`). On the live deploy `σ_ref` was initialized to the 0.5e18 floor;
  `fairRate ≈ 0.847` at floor vol (`deployments/arbitrum-sepolia.json:41`).
- **Mandatory conservatism (spec §6.5):** **NEVER price off raw realized σ** — realized vol
  understates risk right before a regime change. The `max(σ_short, σ_long, floor)` construction
  cannot collapse to a deceptively calm number before a jump. All windows/floor/cadence come
  from `params.json` (cvAMM block) — none hardcoded (`VolOracle.sol:39-45, 59-78`).
- **Load-bearing scope (precise):** `σ_ref` (and `FairValueOracle`) is solvency-load-bearing
  for **the I10 cap and depositor solvency** — a wrong/too-low σ makes the pool under-charge
  load → NAV compresses → loss hits the waterfall **junior-first**. It is **NOT** load-bearing
  for the **FULL no-bad-debt invariant (I1)**, which is structural and oracle-independent: in
  FULL, `collateral = MaxIL ≥ payout` regardless of σ, so a wrong σ **cannot violate I1**
  (`VolOracle.sol:17-21`, spec §6.5). A vol-oracle fault can cost depositors money but can never
  create LP bad debt in FULL.

---

## 8. The ten invariants (spec §13; enforced in code)

| ID | Statement | Where enforced |
|----|-----------|----------------|
| **I1** | No bad debt (FULL): `payout ≤ collateral == MaxIL` | `InflexionCore.sol:1099` cap; vaults require `payout ≤ lockedAmount` |
| **I2** | Cap correctness: `payout == min(realized_IL, MaxIL)` | `InflexionCore.sol:1099` |
| **I3** | Non-negativity / no underflow: `realized_IL = V_hold > V_lp ? V_hold − V_lp : 0` | `ILMath.sol:97` |
| **I4** | LP never profits from the swap: `V_lp ≥ V_hold ⟹ payout == 0` | `ILMath.sol:97` (IL=0 ⇒ payout=0) |
| **I5** | Vault solvency: `locked ≤ deposited` per MM / `totalLocked ≤ junior` for the pool | `UnderwriterVault.sol:148-185`; `ConvexityVault.sol:291-293` |
| **I6** | Liquidity immutability: settle uses the `L` stored at creation, never a re-read | `InflexionCore.sol:603, 744, 795, 1094-1096` |
| **I7** | Capacity authority: `consumedNotional[quoteId] ≤ maxNotionalV0`; a cancelled bit can't fill | `InflexionCore.sol:776, 897-899`; router never mutates (`:682-715`) |
| **I8** | Settlement liveness (Fork 1): `settle()` always succeeds within `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD` | `OracleManager.getSettlementPrice` backstop |
| **I9** | Band enforcement (Fork 2): `createSwap` reverts iff `absBps(P_live, quotePrice) > priceBandBps` (Path B only) | `InflexionCore.sol:892-895` |
| **I10** | Price cap: `premium ≤ FairPremium · (1 + maxLoadBps)` on both paths, **by construction, upstream of settle** | Path A clamp `CvammPricing.sol:80-89`; Path B `require` `InflexionCore.sol:855-857` |

**I10 is orthogonal to I1.** I10 is a deterministic, mechanical clamp in PHASE-1 (pricing/READ),
strictly upstream of `settle`; it does NOT touch `settle`, the MaxIL formula, or I1–I9. The
no-bad-debt proof (I1) is structural — `collateral = MaxIL ≥ payout` — independent of the
premium cap (I1 additionally depends on oracle/settlement liveness, whereas I10 is always-true
by code). **Neither the tranche premium split nor the `totalLocked ≤ juniorAssets` constraint
affects I10 or settle semantics** (spec §13 I10).

---

## 9. The data moat (spec §3.0 Pillar 3, §12 — emitted day-one)

Every create path emits `SwapPriced(swapId, path, fairPremium, baseLoadWad, utilSkewWad,
dispSkewWad, totalLoadWad, sigmaRefWad, cappedAtMaxIL)` (`InflexionCore.sol:262-272`) — the
per-fill clearing-price record. Path B additionally emits `QuoteFilled` (`InflexionCore.sol:274-276`)
and the router emits `SwapRouted` (`InflexionCore.sol:253-257`). `cappedAtMaxIL` flags fills that
hit the MaxIL cap (zero load info — excluded from the load surface). This is the **first public
view into the microstructure of the DeFi LP volatility-risk premium** — FIVE behavioral signals
(clearing-load over a transparent σ_ref bucketed by geometry; pool-vs-MM spread; convexity term
structure; demand skew; net gamma), non-circular (never a back-solved implied-vol surface). The
subgraph deploy is **pending** — when absent, history degrades to a typed pending state; the
`_deployBlock` (274081134) is the subgraph startBlock where the dataset begins
(`deployments/arbitrum-sepolia.json:41`).

---

## 10. Collateral leverage dial (spec §8 — context, roadmap)

FULL vs PARTIAL is a **leverage dial on the ONE `ConvexityVault`**, not a second pool. FULL
(leverage 1, collateral = 100% of MaxIL) is the **only launch mode** and the no-bad-debt
headline. PARTIAL (collateral < MaxIL + buffer) is capital-efficient but carries real bad-debt
risk and is **roadmap, gated on the quant** — every PARTIAL constant must come from
`params.json`, never hardcoded (CLAUDE.md, spec §8.1). In the shipped code, `CollateralModel`
has `{FULL, PARTIAL}` but PARTIAL reverts `UnsupportedModel` (`InflexionCore.sol:101-104, 864`).

---

## 11. Live deployment quick reference (`deployments/arbitrum-sepolia.json`)

- **Chain:** Arbitrum Sepolia, chainId 421614. Fresh full redeploy **2026-06-05**, deploy block
  274081134. dUSDC numéraire = **6 decimals**.
- **Core stack** (`:48-57`): `InflexionCore 0xC19865cF8403F59B8Eca835833aFEe3Aa8DA4848`,
  `OracleManager 0x2c18147B…`, `VolOracle 0xfdEafBB3…`, `ILMath 0x7e90362b…`,
  `ILVault 0x9f7615Ac…`, `UnderwriterVault 0x4Fb459F3…`,
  `ConvexityVault 0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d`, `treasury 0x96455C9b…`.
- **Stylus FairValueOracle (production pricer):** `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c`
  (`:42-47`).
- **Libraries** (delegatecall-linked, `:58-64`): `TickMath 0xbf02bbc8…`,
  `CvammPricing 0x4a053d29…`, `SwapMath 0xf7be9745…`, `QuoteVerification 0x74819eed…`.
- **Demo pair** (`:65-76`): numéraire-correct `dWETH (0xA8C07E1B…) / dUSDC (0xB89630Dc…)`,
  fee-500 pool `0xfE1Eb4D5…`, ~$100k unprotected LP `tokenId 3218`.
- **Live lifecycle (2026-06-05, `:77-106`):** Path A swap #1 — V0 $270,531.28, MaxIL $1,669.24,
  premium $9.70 (0.58% of MaxIL), realized IL $148.64, payout $148.64, settled from the
  ConvexityVault. Routed swap #2 — `premiumA_cvamm $13.80` vs `premiumB_mm $8.93` (MM loadBps
  1000) → **chose Path B (MM)**, MaxIL $3,215.65 locked from the MM's collateral, realized IL
  $245.66, payout $245.66, settled from MM collateral.

> Subgraph deploy **pending** — history surfaces degrade to a typed pending state until it's up.
