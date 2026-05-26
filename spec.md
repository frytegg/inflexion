# IL Swap Protocol — Hackathon Build Spec v3.3

_The first trustless market for LP impermanent-loss risk transfer._

_Arbitrum Open House London — Buildathon (25 May → 14 Jun 2026) + Founder House._
_Author: Alex. This document is the build spec: it is written to be read by Claude Code and turned into a complete, ordered task roadmap. Every design choice is stated with its rationale, its tradeoff, the pitch phrasing that goes with it, and where it sits in the build priority._

---

## 0. Executive Summary

Uniswap v3 LPs carry a structural short-gamma exposure — **impermanent loss (IL)** — estimated at **>$1B/year** of realized losses across DeFi, with no trustless, non-inflationary way to hedge it.

**IL Swap is a collateralized bilateral derivatives market for LP risk transfer.** An LP pays a fixed upfront **premium** to transfer the _in-range_ impermanent-loss risk of a specific Uniswap v3 position to a **market maker (MM)**, who posts collateral and is paid for taking the risk. At expiry the protocol pays the LP their realized IL — **capped at MaxIL**, the worst case while price stays in the position's range — trustlessly, from the MM's collateral. Precisely: this is an **in-range convexity hedge**, not unbounded "IL insurance" (§3.2 explains why the cap is load-bearing and how we communicate it so it never surprises an LP).

Two things make it novel:

1. **MaxIL is the collateral unit.** The maximum in-range IL of any v3 position is analytically computable at creation. MMs collateralize to MaxIL. In **FULL mode the protocol cannot produce bad debt** — the covered payoff is capped at MaxIL by construction and MaxIL is locked. (The guarantee is exact under its stated assumptions: capped payoff, a solvent collateral asset, and oracle/settlement liveness — §3.2, §7.2, §16.5.)
2. **The order flow it generates is a data asset that does not exist anywhere today** — a structural LP volatility surface, a DeFi risk-appetite index, and a convexity-supply book. Built passively from day one, free public API. This is the long-term moat.

**What this is NOT:** not Bancor (mutualized, token-inflation-funded → death spiral); not GammaSwap (perpetual vol trading needing active management); not Panoptic (options market for quants); not "insurance" (no actuarial mutualization, no regulatory ambiguity).

**What this IS:** a **quote-driven dealer market** where MMs continuously price LP convexity and LPs buy certainty in one click.

**Pitch sentence:** _"IL Swap is the first order book of LP convexity — where MaxIL is the capital unit, MMs compete to underwrite, and the resulting flow becomes a structural implied-volatility surface for Uniswap LPs."_

---

## 1. Architectural Decisions (Locked)

| Parameter             | Decision                                                                                      | Rationale                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chain**             | Arbitrum One (mainnet), Arbitrum Sepolia (demo), local Nitro (dev)                            | Deepest Uniswap v3 liquidity; Chainlink fully deployed; Stylus support                                                                                                       |
| **AMM scope**         | Uniswap v3 only                                                                               | Focus > coverage for a 3-week build                                                                                                                                          |
| **Market structure**  | **Quote-driven dealer market** — off-chain matching engine, on-chain non-custodial settlement | MMs requote continuously; on-chain post/cancel is gas-prohibitive. NOT a CLOB (no two-sided crossing), NOT request-and-wait RFQ (LP fills instantly against streamed quotes) |
| **Pricing**           | MMs price off-chain with their own models; quote = `premiumRateOfMaxIL` streamed continuously | Returns pricing agency to the MM; σ and T are embedded by continuous, per-duration requoting                                                                                 |
| **Collateral models** | `FULL` first; `PARTIAL` gated on quant model                                                  | FULL is provably safe; PARTIAL is dangerous if mis-parameterized — build only once Monte Carlo says the numbers are safe                                                     |
| **Settlement style**  | `EUROPEAN` only for the hack                                                                  | Simplest, most hedgeable, FULL-compatible. `ASIAN`/`AMERICAN` reserved in the enum, deferred to roadmap                                                                      |
| **Durations**         | 7d / 30d / 90d                                                                                | Three liquid maturities; T handled by market separation                                                                                                                      |
| **Premium unit**      | % of MaxIL                                                                                    | MM ROC is range-agnostic → no adverse selection on range width                                                                                                               |
| **Coverage**          | `payoff = min(realized IL, MaxIL)`                                                            | Makes FULL bad-debt-free by construction; caps the unbounded beyond-range tail                                                                                               |
| **Greeks**            | Read-only analytics (δ, θ, IV) + 3 data surfaces                                              | Demonstrates the moat; zero security surface                                                                                                                                 |
| **Scalability**       | Enums + interface-driven settlement modules                                                   | New payoff/collateral types plug in post-hack without touching the core                                                                                                      |

---

## 2. Scope & Build Priority

This is the single most important section for execution. Build strictly in this order; do not start a later phase until the earlier one is end-to-end green.

### Phase 1 — FULL / EUROPEAN (the spine, must ship)

Everything needed for an LP to cover a real Uniswap v3 position and settle trustlessly:

- `ILMath` (Stylus/Rust): `computeMaxIL`, `computeIL`.
- `OracleManager`: Chainlink + L2 sequencer + Uniswap TWAP deviation guard.
- `UnderwriterVault`: MM capital pool (deposited / locked / available), yield-on-collateral hook.
- `ILVault`: ERC-721 custody of LP NFTs, fee claim passthrough.
- `ILSwapCore`: CREATED → ACTIVE → SETTLED state machine, signed-quote verification, CEI settlement.
- **Quote relayer** (off-chain): MMs stream signed quotes; engine ranks; serves best quote + signed payload to the frontend.
- `@ilswap/sdk` (TypeScript): LP methods, MM quoting client, data reads.
- The Graph subgraph + public REST API.
- Frontend: `/protect`, `/dashboard`, `/markets`.
- `docs.ilswap.xyz`: explainer + integration + API.
- Demo on Arbitrum Sepolia with seeded MM bots.

### Phase 2 — PARTIAL + Insurance Fund (gated on the quant model)

Build only if (a) Phase 1 is fully green AND (b) the quant model has produced validated parameters:

- `InsuranceVault` (ERC-4626) with **withdrawal delay** and locked-vs-free capital.
- Convex collateral floor `minPartialBps`, progressive leverage tax, circuit breakers.
- **Dutch-auction liquidation** via Chainlink Automation.
- MM **first-loss** stake; per-market / per-MM **exposure caps**.
- Frontend `/vault`, `/underwrite` PARTIAL controls.

### Roadmap (NOT built — enums/interfaces must accommodate)

`ASIAN` (TWAP-averaged payoff), `AMERICAN` (early exercise), additional AMMs, Greek-decomposition tokens, correlation swaps, CDO tranching. See §18.

**Scalability mandate for Phase 1 code:** every place that branches on model or settlement style must read an enum, never a boolean. Settlement logic lives behind an `ISettlementModule` interface so `ASIAN`/`AMERICAN` are new modules, not edits to the core. The core never hard-codes "FULL" — it asks the collateral model for its required collateral.

---

## 3. Mathematical Foundation

### 3.1 IL formula — Uniswap v3

Price `P` = price of token0 in token1 (e.g. ETH in USDC). Position: liquidity `L`, range `[Pa, Pb]`, opened at `P0`.

```
Entry token amounts (P0 in range):
  amount0_entry = L · (1/√P0 − 1/√Pb)
  amount1_entry = L · (√P0 − √Pa)

Hold value at settlement price P_T (numéraire = token1):
  V_hold(T) = amount0_entry · P_T + amount1_entry

LP value at P_T — three cases:
  in range  (Pa ≤ P_T ≤ Pb):
    x = L · (1/√P_T − 1/√Pb);  y = L · (√P_T − √Pa)
    V_lp(T) = x · P_T + y
  below Pa  (P_T < Pa, all token0):
    V_lp(T) = L · (1/√Pa − 1/√Pb) · P_T
  above Pb  (P_T > Pb, all token1):
    V_lp(T) = L · (√Pb − √Pa)

realized_IL = max(0, V_hold(T) − V_lp(T))      [USDC]
```

**Entry-snapshot semantics (F-#10 — what `P0` and the entry amounts mean).** All entry quantities are snapshotted **at swap creation**, not at the LP's original mint. `P0` is the oracle price at `createSwap`; `amount0_entry`/`amount1_entry` are the position's _current_ token amounts at that instant (from current `L`, ticks, and `P0`). The swap therefore covers IL accruing **from creation onward** — any IL the LP already bore before covering stays theirs. `L` is read once at creation and **stored** in the `SwapRecord`; settlement uses the stored `L`, never a re-read (§5.1, F-#2).

### 3.2 MaxIL — the collateral unit, and the coverage cap

`IL(P) = V_hold(P) − V_lp(P)` is **convex on `[Pa, Pb]`**, so its maximum _while price stays in range_ is at a boundary:

> _Proof (write into MATH.md)._ `V_hold(P) = amount0_entry·P + amount1_entry` is affine in `P`. In range, `V_lp(P) = L(2√P − √Pa − P/√Pb)`, so `d²V_lp/dP² = −¼·L·P^(−3/2) < 0` ⇒ `V_lp` strictly concave ⇒ `IL = affine − concave` is convex, and `max(0, IL)` (a max of convex functions) is convex too. A convex function on a compact interval attains its max at an endpoint. ∎ Holds for **any** entry, centered or not — two external auditors flagged this; one re-derived and confirmed it. Fuzz highly asymmetric `P0` (near `Pa`/`Pb`) to be sure.

```
MaxIL = max( IL(Pa), IL(Pb) )      ← maximum in-range IL
```

**Critical correctness point.** MaxIL is **not** the global worst case. Above `Pb` the LP is fully in token1 (constant value) while hold grows linearly with price, so absolute IL is **unbounded** beyond the range. Therefore the protocol does **not** promise to cover unbounded IL. It covers:

```
covered_payoff = min(realized_IL, MaxIL)
```

Because `collateral_FULL = MaxIL` and `covered_payoff ≤ MaxIL` **by construction of the cap**, FULL mode cannot produce bad debt under any price path. This is a structural invariant, provable by Foundry invariant tests.

**Why capping is the right product, not a defect (pitch framing):** at the range boundary the LP has fully rotated into one asset; IL beyond that point is _directional_ loss (foregone spot upside), not the _impermanent_ loss the LP set out to hedge. Capping at MaxIL keeps the product fully collateralized and trustless. LPs who want beyond-range protection re-cover after re-ranging. (Roadmap: tiered caps at wider reference prices for a higher premium.) **User-facing rule (F-#5):** every LP surface shows the payoff diagram (covered up to MaxIL; uncovered beyond range) and labels the product an _in-range convexity hedge_ — the cap must never surprise an LP (§14.1, §14.3). Audit flagged that mislabeling this "IL insurance" is both a demand risk (sophisticated LPs discount the truncated tail) and a reputational/regulatory one.

Reference magnitudes (centered range; to be regenerated and unit-tested by the quant notebook, not trusted as-is):

```
±5%  range → MaxIL ≈ 0.3% of V0
±10% range → MaxIL ≈ 1.2% of V0
±20% range → MaxIL ≈ 4.8% of V0
±50% range → MaxIL ≈ 25%  of V0
```

### 3.3 The pricing method (read this before touching the order flow)

Pricing is layered. Keep the layers separate in code and in the pitch.

**Layer 1 — MaxIL (on-chain, Stylus). The collateral unit.** Pure geometry from `(Pa, Pb, L, P0)`. Independent of volatility and time. It answers "how much capital must be locked," not "how risky is this."

**Layer 2 — the premium (off-chain, MM models). The price.**

```
premium = premiumRateOfMaxIL · MaxIL
```

`premiumRateOfMaxIL` (bps of MaxIL) is **streamed continuously by each MM from their own pricing model**. The protocol imposes no formula. This is why the old "flat % of MaxIL ignores σ and T" problem disappears: the rate is no longer a frozen on-chain constant — it is a live value the MM republishes as volatility moves, and each duration (7/30/90d) is a separate market the MM prices independently. So **σ enters via continuous requoting; T enters via market separation.**

**Why % of MaxIL (the key pricing innovation).** If premium were `X% of V0`, a narrow range (tiny MaxIL) gives the MM enormous ROC and a wide range (huge MaxIL) gives insufficient ROC → MMs adversely select against wide ranges → liquidity fragments. With premium as `X% of MaxIL`, the MM posts collateral = MaxIL and earns `X%` ROC **regardless of range width** → MMs are indifferent to range → full depth.

**Layer 3 — the fair-value anchor (intuition + data surface, not enforced).** A rational MM's rate is:

```
premiumRateOfMaxIL ≈ E[ min(IL, MaxIL) ] / MaxIL   +   risk premium
```

`E[min(IL,MaxIL)]/MaxIL` is an **S-curve in σ²·T** (and in how centered the range is): ≈0 in calm/short regimes (price rarely leaves a wide range), saturating →1 in violent/long regimes (price almost surely exits). Pricing a flat constant would approximate that S-curve with a horizontal line — wrong at both ends. Continuous MM requoting tracks the curve instead. The subgraph publishes the observed rate as a **convexity-premium index**; a back-solved `σ_LP ≈ √(2·rate/T)` is offered only as a rough, heavily-caveated lens, _not_ a true implied vol (§12, F-#12).

**MaxIL is a collateral/normalization unit, NOT a risk metric.** Two positions with identical MaxIL can carry very different risk (distance from current price, delta profile). MMs must still model `E[IL/MaxIL]` within their ratio band. The market is where those models compete — that competition is the data product.

### 3.4 Ratio bands — how an MM quotes without targeting a specific range

`MaxIL/V0` is a monotone proxy for range width:

```
MaxIL/V0 ≈ 1%  → range ≈ ±5%
MaxIL/V0 ≈ 3%  → range ≈ ±14%
MaxIL/V0 ≈ 8%  → range ≈ ±28%
MaxIL/V0 ≈ 15% → range ≈ ±40%
```

An MM streams a quote for a **band** `[minMaxILRatioBps, maxMaxILRatioBps]`, e.g. "I cover positions whose MaxIL/V0 is 2%–7%." At fill time the engine checks the LP's position lands in the band and prices it. The band bounds the MM's uncertainty without forcing them to look at individual ranges — exactly the "quote independent of the specific position" behavior we want, with precise pricing preserved.

**Caveat — intra-band adverse selection (F-#9).** Equal `MaxIL/V0` does _not_ mean equal risk: a position sitting near a range edge (high gamma, more likely to realize the capped payout) is riskier than a centered one with the same ratio, so a band-only quote invites LPs to select the worst positions in the band. Mitigations: MMs may stream finer quotes keyed on extra dimensions (moneyness / distance-to-edge / realized-vol regime), or simply widen. Phase 1 ships band-only, but the engine carries the extra dimensions so MMs can refine without a protocol change.

---

## 4. Market Structure — Off-chain Matching, On-chain Settlement

### 4.1 What it is (and what it is not)

A **quote-driven dealer market**: only MMs (dealers) post prices; LPs (takers) only take. Price discovery is one-sided, driven by MM competition.

- **Not a CLOB.** There is no two-sided crossing; LPs never rest bids.
- **Not request-and-wait RFQ.** The LP does not broadcast a request and wait for offers. The book is _always populated_ with live streamed quotes, so the LP fills **instantly** against the best one.

MMs run sophisticated models and **stream/cancel quotes continuously** (many updates/second) as their inputs move. On-chain post/cancel at that frequency is gas-prohibitive, so **matching is off-chain; settlement is on-chain and non-custodial.**

### 4.2 The split

| Off-chain — Matching Engine (relayer)                      | On-chain — Settlement (`ILSwapCore`)                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Maintains the live quote book per market                   | Verifies the matched quote's **MM EIP-712 signature**                   |
| MMs stream signed quotes, cancel freely (gasless)          | Checks MM **collateral** in `UnderwriterVault` ≥ MaxIL                  |
| Ranks by resulting premium; **price-time / FIFO** priority | Locks collateral, pulls premium, takes NFT custody, writes `SwapRecord` |
| Returns best quote + signed payload to the LP frontend     | Enforces the no-bad-debt invariant                                      |

**The FULL no-bad-debt guarantee is independent of matching** — it is enforced at on-chain settlement (collateral = MaxIL, payoff capped), regardless of how the quote was discovered.

### 4.3 The signed quote (firm, no last-look)

```solidity
struct SignedQuote {
    address mm;                  // signer; must have collateral in UnderwriterVault
    bytes32 marketId;            // keccak(token0,token1,feeTier,duration)
    uint16  premiumRateOfMaxIL;  // bps of MaxIL  (MM's price)
    uint16  minMaxILRatioBps;    // ratio band lower bound
    uint16  maxMaxILRatioBps;    // ratio band upper bound
    uint128 quotePrice;          // oracle price at signing — anchor for the band check (Fork 2, §4.3.3)
    uint16  priceBandBps;        // ±band around quotePrice; quote auto-voids on-chain if exceeded
    uint8   model;               // CollateralModel.FULL (PARTIAL in Phase 2)
    uint16  partialRatioBps;     // 0 in FULL
    uint128 maxNotionalV0;       // capacity this quote may consume
    uint64  validUntil;          // absolute expiry ts; default now+8s, band [5s,15s] (see §4.3.1)
    bytes32 quoteId;             // unique id; on-chain capacity + replay tracking key (§4.3.2)
    uint256 nonce;               // Permit2-style bitmap (word<<8 | bit): selective cancel, never cancel-all (§4.3.2)
    bytes   signature;           // EIP-712
}
```

**Firm quotes, not last-look — but oracle-anchored (Fork 2 — Option B).** The MM cannot reject at settlement. "Last look" is more MM-friendly but undercuts trustlessness and enables the abuse pattern auditors flag. Instead, MM protection comes from three deterministic, on-chain mechanisms: (1) an **oracle-anchored price band** (§4.3.3) that auto-voids the quote if the live oracle has drifted beyond `priceBandBps` from `quotePrice` — kills the dominant pickoff attack (gap-on-stale-quote, including bearer-instrument leakage past off-chain cancel); (2) a **short `validUntil` window** (§4.3.1) — bounds the leakage interval; (3) **on-chain selective nonce invalidation** (§4.3.2). All three are deterministic — no MM discretion at fill, so this is _not_ last-look (no fading, no abuse vector).

#### 4.3.1 Sizing `validUntil` (default **8s**; band **[5s, 15s]**; MM-configurable)

`validUntil` is a **latency parameter, not a risk-capital one** (the Monte Carlo of §9 does not set it). With the §4.3.3 oracle-anchored band as the **primary** pickoff defense, `validUntil` is now a secondary, leakage-window control — it bounds how long a bearer-instrument signed quote can survive in observer hands.

Window budget on Arbitrum: sequencer soft-confirmation is sub-second (~0.25s blocks), tx inclusion ~1–3s; the variable cost is **human** (wallet popup + read + click ≈ 5–12s), plus RPC margin. So:

- **Default `now + 8s`** — covers a fast wallet-sign + submit + inclusion under normal conditions; tight enough that a leaked quote dies quickly.
- **Protocol-enforced band [5s, 15s]** — tightened from v3.1's [5s, 60s] per audit. Floor 5s avoids griefing reverts; ceiling 15s caps the leakage window even when an MM picks the maximum.
- **UX rule:** the frontend fetches/locks the freshest quote **at the "Confirm" click**, not at page load, so the clock measures commit→confirm.
- **Book-freshness ≠ signed-validity.** The engine drops quotes not refreshed within ~1–2s; MMs re-sign continuously, so per-quote exposure auto-expires and on-chain cancels are rarely needed.
- **Calibrate the default** against measured fill latency on Arbitrum Sepolia in Week 2; the value lives in engine + frontend config, not hardcoded in the contract (the contract only enforces the [5s, 15s] band against `block.timestamp`).
- **If LP revert rate proves too high in Sepolia testing**, raise the default to 10–12s — the band check (§4.3.3) is the primary protection, so the clock can be relaxed.

#### 4.3.2 Cancellation, replay, and capacity (on-chain authoritative)

- **Selective cancel, never cancel-all (F-#7).** `nonce` is a **Permit2-style bitmap** (a 256-bit word index + bit). An MM cancels _one_ quote by flipping _one_ bit; a single incrementing nonce would invalidate every outstanding quote at once and empty the book during exactly the fast markets where the MM wants to pull only one. Cancels are batchable (flip many bits in one tx).
- **Replay / double-spend protection (F-#6).** The off-chain engine is advisory; **on-chain is authoritative.** `ILSwapCore` tracks `consumedNotional[quoteId]`; `createSwap` requires `consumedNotional[quoteId] + V0 ≤ maxNotionalV0`, then increments it atomically (Phase 3, before any external call). A signed quote can fill repeatedly _only_ up to its capacity, and never after its bit is cancelled; concurrent submissions cannot over-consume because check-and-increment is one transaction.
- **Capacity unit (F-#6).** `maxNotionalV0` is denominated in **V0 (position value)**, not collateral. An MM with $50k capital who sets `maxNotionalV0 = $500k` can be filled on up to $500k of _notional_ but only ~$6k of _collateral_ for typical ±10% ranges (collateral = MaxIL ≪ V0). The SDK surfaces both numbers so MMs size capacity knowing it bounds notional, not capital.

#### 4.3.3 Oracle-anchored price band — Fork 2 resolution (Option B)

The audit (GPT High) identified that firm quotes + any clock-based validity feed a one-sided stale-quote pickoff: when vol gaps, the MM is short convexity, and a searcher holding the signed bytes can submit on-chain even after the engine has dropped the quote — **signed payloads are bearer instruments that survive in any hand that copied them**, beyond off-chain engine cancellation.

**Fix.** Each signed quote carries `quotePrice` (the oracle price the MM saw when signing) and `priceBandBps` (the ±band within which the quote is honorable). At `createSwap`, the contract reads the live oracle price `P_live` (the same `oracle.getPrice` already needed for the `P0` snapshot — zero extra oracle cost) and checks:

```solidity
require(absBps(P_live, quote.quotePrice) <= quote.priceBandBps, "price out of band");
```

If the market gapped beyond the band, the quote **auto-voids on-chain, deterministically**, with no MM discretion at fill — so this is **not last-look** (no fading, no abuse) and stays trustless. The MM is exposed only to drifts _within_ their chosen band (they priced for them), never to gaps that blow through it.

**Defaults and bounds.**

| Constant                      | Value          | Derivation                                                                                                                 |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PRICE_BAND_MIN_BPS`          | **25 (0.25%)** | Floor: too-tight bands cause constant in-flight reverts (Chainlink ticks on 0.05% deviation; LP latency adds normal drift) |
| `PRICE_BAND_MAX_BPS`          | **500 (5%)**   | Ceiling: bands wider than ~5% defeat the protection (a 5% gap already inflicts material MM loss)                           |
| Default MM-set `priceBandBps` | **100 (1%)**   | Comfortable middle: tolerates normal in-flight drift, voids on real gaps. MMs tune per quote based on vol regime           |

**Why this fits the engine architecture.** Off-chain MMs requote continuously based on their model; `quotePrice` is just "the oracle price at the moment I signed." If the LP fills within a few seconds and the market is calm, `P_live ≈ quotePrice` and the check passes invisibly. If the market gapped between sign and fill, the check reverts and the MM is protected — without trusting the engine to be fast, without trusting the validity-clock alone, without inventing last-look.

**Frontend UX implication.** On a band-revert, the SDK auto-refetches the freshest quote and re-attempts transparently (the LP sees "refreshing quote..." and never a raw error). In stable markets this never fires; in fast markets it fires a few times and resolves once vol calms.

**Residuals (acknowledged, not blockers):**

- **Vol-only moves** (implied vol jumps without much spot drift): not caught by a spot band. Small attack surface on crypto majors where vol spikes correlate with spot; mitigated by `validUntil` + per-block caps. V1.5 may add an IV-anchored band when an on-chain IV oracle exists.
- **Within-band drift:** the MM bears it. Correct — they chose the band.
- **Oracle lag:** if Chainlink hasn't ticked yet on a fast move, `P_live` still equals the stale value and the check passes. Chainlink majors tick on 0.05% deviation (sub-second on real moves) so this is small; for thinner feeds, MMs widen `priceBandBps`.

### 4.4 Matching algorithm (engine, off-chain)

```
On LP coverage intent (tokenId, duration, modelPref):
 1. Read position from NonfungiblePositionManager (off-chain RPC): token0/1, feeTier, ticks, L
 2. Compute MaxIL, V0, maxILRatioBps (same Stylus/SDK math as on-chain)
 3. marketId = (token0, token1, feeTier, duration)
 4. Filter live quotes: model ok; ratioBps in band; capacity ≥ V0; validUntil > now; nonce live
 5. Rank by premium = rate · MaxIL ASC; break ties by quote arrival time (FIFO)
 6. Return best quote + signed payload + computed premium to the LP
 7. LP confirms → frontend submits createSwap(signedQuote, tokenId, maxPremium)
```

If the top MM's capacity < V0, fall back to next quote (hackathon: single-MM full fill; production: walk the book / split fills).

### 4.5 Trust model (the question every judge asks)

Settlement is **non-custodial**, so the engine's power is strictly bounded:

- **Cannot steal funds** — settlement is on-chain against the MM's own collateral.
- **Cannot forge quotes** — every quote is MM-signed (EIP-712).
- **Cannot force a stale quote** — `validUntil` + on-chain nonce.
- **Can** censor or reorder (a liveness/fairness concern, not solvency). Three first-class mitigations (F-#13): (1) **direct-to-contract fallback** — because EIP-712 verification is on-chain, an LP holding any valid signed quote can call `createSwap` _directly_, bypassing the engine; the SDK exposes this path, so a censoring operator simply loses that flow. (2) The engine **publishes its full quote stream and match decisions** to an append-only log, making ordering auditable. (3) Deterministic price-time rules. The operator can degrade liveness/fairness but cannot capture users who route around it.

**Decentralization roadmap (Arbitrum-native pitch line):** a dedicated **Orbit chain** could host the quote book fully on-chain with negligible gas (the Hyperliquid model), removing the off-chain component entirely. Too large for the 3 weeks; it is the clean answer to "isn't the matcher centralized?".

### 4.6 Hackathon implementation of the engine

Do **not** build an exchange-grade matcher. Build a **thin relayer**: MM bots push signed quotes over WebSocket/REST → in-memory (Redis) store keyed by market → best-per-band maintained → `/quote?tokenId&duration` returns the ranked best + signed payload. Because demo MMs are bots we control, this is ~a weekend, and it demos beautifully (watch quotes requote as we move price/vol; the LP always sees the live best price).

---

## 5. Swap Lifecycle — FULL / EUROPEAN

### 5.1 `SwapRecord`

```solidity
struct SwapRecord {
    uint256 tokenId;
    address lp;
    address mm;
    uint128 V0;
    uint128 maxIL;            // collateral unit; coverage cap
    uint128 collateral;       // FULL: == maxIL
    uint128 premium;
    uint8   model;            // CollateralModel
    uint8   settlement;       // SettlementStyle.EUROPEAN
    uint64  createdAt;
    uint64  expiry;           // createdAt + duration
    uint160 sqrtP0X96;        // entry price snapshot
    uint128 amount0Entry;
    uint128 amount1Entry;
    uint128 liquidity;        // L snapshotted at creation; settlement uses THIS, never a re-read (F-#2)
    Status  status;           // CREATED → ACTIVE → SETTLED
}
```

### 5.2 `createSwap` — CEI, atomic

```
PHASE 1 — READ (no state change)
  position = nftManager.positions(tokenId);  require ownerOf(tokenId) == msg.sender
  require Pa ≤ P0_tick ≤ Pb                     // F-#2/#3: reject out-of-range positions (entry must be in range)
  L = position.liquidity                        // snapshot ONCE → stored in SwapRecord; never re-read at settle
  P0 = oracle.getPrice(token0, token1)          // creation snapshot, TWAP-disciplined
  maxIL = ILMath.computeMaxIL(sqrtP0, sqrtPa, sqrtPb, L); V0 from amounts
  verify EIP-712 signature(signedQuote) == signedQuote.mm
  premium = ceilDiv(signedQuote.premiumRateOfMaxIL * maxIL, 10000)   // round UP — no free dust coverage (F-#8)

PHASE 2 — CHECKS (requires only)
  require V0 >= MIN_POSITION_V0 && premium >= MIN_PREMIUM             // F-#8/#13: no dust / no free coverage
  require maxILRatioBps in [quote.min, quote.max]
  require quote.validUntil > block.timestamp && nonce-bit live (§4.3.2)
  require absBps(P0, quote.quotePrice) <= quote.priceBandBps          // Fork 2: oracle-anchored band (§4.3.3)
  require consumedNotional[quoteId] + V0 <= quote.maxNotionalV0       // F-#6: on-chain capacity authority
  require vault.availableBalance(mm) >= collateral   // FULL: collateral = maxIL
  require premium <= maxPremiumUSDC                  // LP slippage guard

PHASE 3 — EFFECTS (state, no external calls)
  consumedNotional[quoteId] += V0                    // F-#6: atomic, replay-safe capacity decrement
  vault.lockCollateral(mm, collateral)
  swaps[id] = SwapRecord{ ..., liquidity: L }        // store L (F-#2)

PHASE 4 — INTERACTIONS (external last)
  USDC.transferFrom(lp, this, premium)               // USDC first: if it reverts, NFT never moved
  nftManager.safeTransferFrom(lp, ilVault, tokenId)  // NFT last
  _distributePremium(premium, model)                 // FULL: MM 99% / treasury 1%
  emit SwapCreated(...)
```

Premium-before-NFT ordering means an under-approved LP reverts before losing NFT custody. `MIN_POSITION_V0` (e.g. $100) and `MIN_PREMIUM` (e.g. $1 USDC) block dust swaps that would grief MM capacity into many tiny locked slots (F-#13) and close the integer-division free-coverage edge (F-#8); both governance-tunable.

**Protocol fee (FULL) = 1% of premium** (MM keeps 99%). It is a fee on _premium_, not notional: premium ≈ rate·MaxIL ≈ 0.5–5% of V0 for typical 30-day ranges, so 1% of premium ≈ **0.005–0.05% of V0** — an order of magnitude below the LP's expected Uniswap fee income (it never flips the carry-positive calculus) and at/below peer venue takes (dYdX taker ≈ 0.05% of notional). Governance-tunable within **[0.5%, 2%] of premium**; chosen low to bootstrap flow (revenue is the moat-feeding data, not the fee — §12).

### 5.3 ACTIVE

- NFT held in `ILVault`; LP keeps fee accrual and may `claimFees(tokenId)` anytime (no rehypothecation).
- **Position is frozen.** While in custody the LP cannot re-range, add/remove liquidity, or exit early — a real opportunity cost for active LPs and a key reason short durations exist. Disclosed prominently in the UX (§14.1); early-exit / re-range is on the roadmap (§18, F-#11).
- **Liquidity-modification safety (F-#2).** Anyone can call `increaseLiquidity` on a v3 NFT (it is not owner-gated), so a custodied NFT's `L` can be changed externally. This is **harmless because settlement uses the `L` stored at creation**, never a re-read — extra liquidity is simply returned to the LP with the NFT at settlement and can never inflate the payout above MaxIL. `decreaseLiquidity`/`collect` are owner-gated; the owner is `ILVault`, which exposes only `claimFees`.
- **What is hedged (F-#14).** The product hedges **gross in-range IL**, not the LP's net P&L. The LP also earns Uniswap fees (their pay for providing liquidity); total outcome = fees − IL + payout − premium, which _can_ be positive. That is correct, not a leak — invariant I4 (LP never profits _from the swap_) concerns the payout, which is still `0` whenever IL is `0`. MMs should price knowing LPs earn fees (rational WTP ≈ `E[IL] − E[fees] + risk premium`); the SDK/docs guide this.
- Collateral locked in `UnderwriterVault` (non-withdrawable).
- `GreekDisplay` serves δ, θ, IV (pure view).
- FULL: no monitoring needed — liquidation is mathematically impossible.

### 5.4 SETTLED (callable by anyone at `block.timestamp ≥ expiry`)

```
oracle.requireHealthy()                       // sequencer up, prices fresh, deviation ok
P_T = oracle.getSettlementPrice(token, expiry, hintRoundId)   // Chainlink round at expiry T (§6.1)
realized_IL = ILMath.computeIL(sqrtP_T, sqrtPa, sqrtPb, swap.liquidity, amount0Entry, amount1Entry)  // STORED L (F-#2)
payout = min(realized_IL, maxIL)              // the cap

FULL:
  LP   ← payout            (from MM collateral)
  MM   ← maxIL − payout    (residual)
  NFT  → LP
emit SwapSettled(id, realized_IL, payout)
```

If the oracle is unhealthy, settlement reverts and is retryable — neither party can exploit downtime.

---

## 6. Oracle Design (`OracleManager`)

### 6.1 Settlement price — pinned to expiry, deadlock-free (Fork 1 — Option B)

```solidity
function getSettlementPrice(address token, uint64 expiry, uint80 hintRoundId)
    external view returns (uint256 price, bool twapAdvisory)
{
    // 1. L2 sequencer uptime + grace (mandatory on Arbitrum)
    (, int256 up, uint256 since,,) = sequencerFeed.latestRoundData();
    require(up == 0, "sequencer down");
    require(block.timestamp - since > GRACE_PERIOD, "grace");                  // 3600s

    // 2. Chainlink round ACTIVE AT expiry T (pins price to T → kills settle-timing game)
    (, int256 px,, uint256 updatedAt,)         = priceFeed[token].getRoundData(hintRoundId);
    (, int256 pxNext,, uint256 nextUpdatedAt,) = priceFeed[token].getRoundData(hintRoundId + 1);
    require(updatedAt <= expiry && expiry < nextUpdatedAt, "wrong round");
    require(block.timestamp - updatedAt < MAX_STALENESS[token], "stale");

    // 3. Chainlink LONE-SPIKE sanity check (NOT a hard TWAP gate).
    //    A glitch is a transient outlier vs BOTH immediate neighbours; a real fast move
    //    is sustained, so the NEXT round confirms it and the check passes.
    //    Liveness backstop: after LIVENESS_WINDOW past expiry, accept px UNCONDITIONALLY
    //    so funds can never lock indefinitely.
    (, int256 pxPrev,, ,) = priceFeed[token].getRoundData(hintRoundId - 1);
    bool loneSpike =
        absBps(px, pxPrev) >= LONE_SPIKE_BPS &&
        absBps(px, pxNext) >= LONE_SPIKE_BPS;
    bool backstop = block.timestamp >= expiry + LIVENESS_WINDOW;
    require(!loneSpike || backstop, "lone-spike: defer (retry next round)");

    // 4. Uniswap v3 TWAP at T — ADVISORY ONLY (emitted, NEVER reverts).
    //    Used for monitoring, the data surface, and off-chain guardian alerts.
    twapAdvisory = absBps(px, uniswapTWAPat(token, TWAP_WINDOW, expiry)) >= MAX_DEVIATION_BPS;

    return (uint256(px), twapAdvisory);
}
```

**Design (audit Fork 1 — Option B accepted, with C as Week-1 fallback).** The price is pinned to the Chainlink round active at expiry `T`, so no party can pick a favourable instant by timing the `settle` call (fairness). Validity is gated by sequencer health, staleness, and a **Chainlink lone-spike sanity check** — a glitched print is a transient outlier vs _both_ immediate neighbours; a real fast move is sustained, so the next round confirms it and the check passes. The **Uniswap TWAP is downgraded to an advisory signal**, emitted alongside the price — **never a hard revert.** This is safe because Chainlink for Arbitrum majors is not trade-manipulable, so a Uniswap-only "manipulation" is a non-attack on settlement; the v3.1 hard-TWAP gate was largely redundant and was the entire source of the permanent-deadlock class identified by Gemini (Critical) / GPT (High).

**Liveness backstop — no permanent locks (invariant I8).** If the lone-spike check defers (suspicious print at `T`), settlement simply retries — the next Chainlink round either confirms the level (real move, no longer lone) or exposes the glitch (still lone, still defer). The check is bounded by `LIVENESS_WINDOW` (default **24h**); past the window, `px` is accepted **unconditionally** so funds are never locked indefinitely. Worst-case delay = one heartbeat + window, faced symmetrically by both parties.

The **same health gate runs at creation** (entry `P0`), minus the lone-spike check (creation uses the _current_ `latestRoundData`, not historical pinning).

**Hackathon fallback (Option C — go/no-go end of Week 1):** if round-at-T + lone-spike resolution slips, ship `latestRoundData()` at settle with a small keeper-incentive reward for prompt settlement — no pinning, mild settle-timing drift, but also no deadlock (retry always works because the values aren't frozen). Round-pinning + Option B becomes a Phase 2 hardening.

### 6.2 Parameters — quantitative, sourced (not arbitrary)

**Arbitrum heartbeat reality (verified against Chainlink data feeds):** ETH/BTC/ARB-USD use a **24h (86,400s) heartbeat, 0.05% deviation**; USDC/USD **86,400s / 0.1%**. In practice ETH updates many times per hour (any 0.05% move triggers a round), but the _contract_ must tolerate up to the heartbeat, so `MAX_STALENESS ≥ heartbeat`. **With the lone-spike check (§6.1, Fork-1 fix), Chainlink self-consistency — not the staleness check, and not the Uniswap TWAP (now advisory) — is the real defense against a glitched Chainlink print.**

| Constant                      | Value                                  | Derivation / use                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GRACE_PERIOD`                | **3600s**                              | Chainlink's recommended post-recovery sequencer grace                                                                                                                                                                          |
| `MAX_STALENESS` (all 4 feeds) | **90,000s** = 86,400 heartbeat + 3,600 | published heartbeat + 1h L2 buffer; must not be below heartbeat or flat markets cause false reverts                                                                                                                            |
| `LONE_SPIKE_BPS`              | **500 (5%)**                           | round-at-T is "lone" only if it differs from BOTH neighbours by ≥5% — catches glitched prints; real moves persist across rounds so they pass; 5% sits well above normal inter-round moves (Chainlink ticks on 0.05% deviation) |
| `LIVENESS_WINDOW`             | **86,400s (24h)**                      | max settlement deferral by the lone-spike check; past this, Chainlink-at-T is accepted unconditionally — funds can never lock indefinitely (Fork 1 / invariant I8)                                                             |
| `TWAP_WINDOW`                 | **1800s (30 min)**                     | window for the Uniswap-TWAP advisory signal (data surface + guardian alerts)                                                                                                                                                   |
| `MAX_DEVIATION_BPS`           | **200 (2%)**                           | advisory-only threshold emitted in events; does **not** block settlement                                                                                                                                                       |

**Setup requirement:** call `increaseObservationCardinalityNext` on each market's Uniswap v3 pool so a TWAP over `[T−1800, T]` is always observable.

### 6.3 Edge cases

| Situation                                                                      | Behavior                                                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------ | ------------------------------------------- |
| No fresh Chainlink round covers T (> `MAX_STALENESS`)                          | defer, retry when a covering round exists                                  |
| Sequencer down                                                                 | all price ops paused                                                       |
| Lone-spike at T (Chainlink-at-T outlier vs BOTH neighbours ≥ `LONE_SPIKE_BPS`) | defer, retry when next round resolves; hard-accept after `LIVENESS_WINDOW` |
| Sequencer just recovered                                                       | 3600s grace before prices usable                                           |
| `                                                                              | Chainlink − UniswapTWAP                                                    | ` > 2% | advisory event emitted; settlement proceeds |

### 6.4 Arbitrum One feeds

ETH/USD `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` · BTC/USD `0x6ce185539ad4fdaecd7274c0b0c9fc4add7c4e76` · ARB/USD `0xb2A824043730FE05F3Da2efaFa1CBbe83fa548D7` · USDC/USD `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` · Sequencer `0xFdB631F5EE196F0ed6FAa767959853A9F217697D`.

---

## 7. Capital — `UnderwriterVault` + Yield on Collateral

### 7.1 Pooled MM capital

One pool per MM; collateral auto-pulled at match (never in the quote payload).

```solidity
mapping(address => uint256) public deposited;  // total USDC
mapping(address => uint256) public locked;     // in active swaps
function availableBalance(address mm) public view returns (uint256) { return deposited[mm] - locked[mm]; }
function deposit(uint256 a) external;                       // pull USDC
function withdraw(uint256 a) external;                      // require available ≥ a
function lockCollateral(address mm, uint256 a) external onlyCore;   // require available ≥ a
function releaseAndDistribute(address mm, address lp, uint256 payout, uint256 locked_) external onlyCore;
event CapitalLow(address mm, uint256 available);            // when available < 20% deposited
```

### 7.2 Yield on locked collateral (capital efficiency — the biggest demand lever)

Locked USDC otherwise sits idle, forcing MMs to demand a higher premium, which suppresses LP demand (§10). Route idle/locked collateral to a conservative venue so the MM **earns base yield while locked**:

- **Phase 1:** design the hook + interface (`IYieldAdapter`), wire a no-op adapter (keep collateral liquid for the demo).
- **Phase 2+:** route only to venues that are **instantly redeemable and not utilization-gated** — tokenized T-bills / `sDAI`-type wrappers. **Hard rule (F-#3): never route _locked_ collateral into utilization-based lending (Aave/Compound).** In a correlated crash, borrow utilization hits 100%, withdrawals revert, and `releaseAndDistribute` at settlement fails — silently breaking the no-bad-debt guarantee through an _external_ dependency. Only **idle (unlocked)** capital may touch any external venue, and collateral backing an active swap must stay instantly recallable. Cap the routed %; the LP premium and the invariant are never touched.

Lifecycle example: Bob deposits $50k once; posts quotes on 3 markets (no collateral in payload); Alice matches (MaxIL $2,400) → `lockCollateral(Bob, 2400)`, available $47,600; at settlement (IL $800) → Alice gets $800, Bob gets $1,600 back, available rises.

---

## 8. PARTIAL Mode + Insurance Fund (Phase 2 — gated on §9)

**Do not implement until the quant model (§9) returns validated parameters.** Building PARTIAL on guessed numbers _is_ the failure auditors warn about. Below is the design the parameters plug into.

**Parameter provenance — no PARTIAL constant is hardcoded.** The liquidation buffer `k`, circuit-breaker health thresholds, collateral floor curve, leverage-tax curve, insurance-fund withdrawal delay, per-market/per-MM exposure caps, and MM first-loss size are **all read from `params.json` produced by §9** — never defaulted in code. Each has a _meaning_ that bounds its value (e.g. the liquidation buffer `k` must cover the worst-case price drift during Chainlink-Automation detection latency + Dutch-auction execution), and §9 turns that meaning into a number under stress.

### 8.1 The core risk

A PARTIAL MM posts collateral `c < MaxIL` (as % of V0) and the Insurance Fund **reinsures the tail** `(IL − c)⁺`. Economically the fund is **short deep-OTM puts on the IL of a correlated LP basket**: premium income in calm regimes, principal at risk in correlated crashes (all positions hit MaxIL together, draining the fund faster than premium replenishes). The whole safety stack exists to bound that tail.

### 8.2 Layer 1 — convex collateral floor

```
minPartialBps = floor_curve(c)   such that   fee + premium-share ≥ marginal expected tail cost at c
```

Tail cost is **convex** in leverage: 20%→10% collateral less than doubles fund risk; 10%→5% more than doubles it (you eat into the fat tail). So the floor and the penalty must steepen as `c` drops — **a convex curve, not the linear/step schedule of v2.** The curvature is _derived from §9_, not guessed. The floor also rises dynamically with realized vol, CLOB-implied vol, and fund utilization.

### 8.3 Layer 2 — progressive leverage tax (convex)

A protocol fee on premium, **decreasing in `c`**, routed to the Insurance Fund — the entity bearing that MM's tail. Smooth convex `fee(c)` (replaces v2's steps `1/2/5/9/12%`). Self-funding property: a 5%-collateral MM pre-funds its own insolvency risk far more than a 20%-collateral MM. Market reinforcement: a low-`c` MM must quote a higher gross rate for the same net → naturally outcompeted by FULL and high-`c` MMs.

### 8.4 Layer 3 — circuit breakers

`HealthRatio = fund_balance / total_partial_exposure`

```
≥200%  L0 normal
100–200% L1 caution   → minPartialBps +50% above curve
 50–100% L2 alert     → new PARTIAL suspended; FULL unaffected; vault deposits incentivized
  <50%  L3 emergency  → protocol-wide pause on new PARTIAL; multisig to resume; existing swaps settle (no rug)
```

### 8.5 Liquidation — Dutch auction (Chainlink Automation)

There is no asset to _sell_; "liquidation" = **forced early settlement** when a PARTIAL MM's collateral is about to be breached (`IL_MTM > c · k`). Chainlink Automation watches the trigger; the **keeper reward is a Dutch auction** (starts low, rises until a keeper executes) → cheap in calm, guaranteed in stress, no fixed over-payment. On execution: LP made whole at current price (collateral + fund if needed), keeper takes the cleared reward, MM gets residual, NFT returned. (Note: this gives PARTIAL an American-like early-settlement edge — fine, and it makes the LP whole at the breach.)

### 8.6 Insurance Fund (`InsuranceVault`, ERC-4626) + anti-fragility

- **Withdrawal delay (essential).** Without it, depositors run at the first stress and drain the fund exactly when in-flight swaps need it → death spiral. Use a cooldown/redemption queue **and** lock capital backing active PARTIAL swaps (free vs locked, like the MM vault); queue harder as circuit-breaker level rises. Delay length derived from §9.
- **MM first-loss skin-in-the-game.** PARTIAL MMs hold a junior stake in the fund proportional to what they underwrite → they eat their own tail before retail depositors.
- **Per-market and per-MM exposure caps** → no single market/MM can drain the fund; enforces diversification.
- `coverBadDebt(amount, lp)`, `healthRatio()`, `circuitBreakerLevel()`, `receivePremiumShare(amount)`.

### 8.7 Where the yield comes from (state it honestly)

The fund is a **reinsurer**. Inflows: (A) 20% of PARTIAL premium; (B) progressive leverage tax; (C) liquidation residuals; (D) optional FULL-fee share. Outflow: `(IL − c)⁺`. **The fund is profitable iff the price it charges for the tail (A+B) ≥ the fair value of that tail from §9.** Today those prices are arbitrary, so solvency cannot be claimed. After §9, they are derived and it can. Depositor disclosure: _"You earn premiums in calm markets and absorb tail losses in correlated crashes — economically, selling diversified short-dated straddles on LP positions. Capital is not guaranteed."_

---

## 9. The Quantitative Model (gate for Phase 2)

A standalone, parallelizable deliverable (`quant/` Python notebook) that **derives every PARTIAL parameter** and doubles as a flagship pitch artifact ("we did not guess our risk parameters — we derived them from Monte Carlo stress tests under fat-tailed, correlated crashes").

**Question:** _Given partial collateral `c`, what is the probability and magnitude of the fund covering excess IL across realistic paths, and what `fee(c)` / floor / caps make the fund a solvent reinsurer with bounded ruin probability?_

**Method:**

1. **Underlying — fat tails + correlation, not GBM.** Crypto crashes are jumpy and correlated; correlation is the entire danger. Use jump-diffusion and/or historical bootstrap from real ETH/BTC/ARB data, plus a common crash factor across pairs.
2. **Paths → IL** via §3 formulas for a realistic distribution of position structures (range widths, moneyness) matching expected LP behavior.
3. **Portfolio waterfall** across many concurrent swaps: LP gets `min(IL, c)` from the MM, `(IL − c)⁺` from the fund; fund inflows = premium share + `fee(c)`, outflows = excess IL.
4. **Stress:** correlated crash (common factor), vol-regime shift, utilization spike.
5. **Outputs (the parameters):**
   - `c_min` (floor) and the **convex `floor_curve(c)`**;
   - the **convex `fee(c)`** tax curve;
   - circuit-breaker health-ratio thresholds;
   - **withdrawal-delay** length;
   - **per-market / per-MM exposure caps**;
   - **MM first-loss** stake size;
   - target fund balance vs exposure for ruin probability < target (e.g. <0.1%).

**Outputs feed the build:** a `params.json` consumed by deploy scripts and contract constructors, plus charts (fund P&L distribution, ruin probability vs `c`, drawdown under the 99.9th-percentile correlated crash) for the deck and `docs.ilswap.xyz`.

---

## 10. Economic Viability — The Levers (awareness, mostly not built)

This section exists so the spec is honest about the binding constraint and shows we know how to attack it. For the hackathon we _name_ it and build the hooks (SDK, yield adapter, data surface); full solutions are mentor/incubator work.

**The binding constraint:** premium must exceed `E[loss]` for the MM, but a rational LP only pays up to `E[loss] + their risk aversion`. The market exists only where the buyer is more risk-averse than the seller, or the seller bears the risk more cheaply. Where the surplus comes from:

- **Risk-aversion gradient (real).** Retail LPs _hate_ IL — a salient, regret-laden loss; MMs are diversified and ~risk-neutral. The LP buys certainty. Genuine surplus.
- **Diversification.** One LP's IL is high-variance; a basket is far lower-variance until correlation hits → a pooled underwriter prices closer to `E[IL]`. (This is also the legitimate efficiency case for PARTIAL.)
- **Hedging (decides liquidity).** If MMs cheaply hedge short gamma (perps, Deribit, Panoptic), they charge hedging cost + thin spread, not a fat uncertainty premium. **Better MM hedging tooling → tighter quotes → LP demand.** European is far more hedgeable than American — another reason it is the hackathon default.
- **Basis harvesting (the flywheel).** If LP-IV trades rich to Deribit IV, vol-arb desks _want_ to sell coverage to capture the basis → sophisticated supply that prices tight. The data surface (§12) surfaces the basis; the moat and the liquidity bootstrap are the same mechanism.

**Capital efficiency for MMs:**

- **Yield on collateral** (§7.2) — the single biggest lever; idle collateral earns while locked → lower required premium → more demand. RWA-flavored.
- **PARTIAL mode** — frees capital directly (at the cost of tail risk the fund reinsures).

**Target the price-inelastic customer.** Yield-chasing retail is the worst customer (elastic). The best are **DAOs / protocol treasuries running protocol-owned liquidity**, who need predictable, reportable P&L and pay for certainty. This reframes IL Swap as **treasury risk management for on-chain institutions** — and is the organic bridge to the program's RWA/institutional theme without chasing hype.

**Rebates — essential or dangerous? Both, about different markets.** In a spot/AMM market, rebates are benign. In an _underwriting_ market they subsidize **risk-taking**, not liquidity: a mercenary MM farming rebates sells underpriced insurance and the fund eats the tail. Reconciliation: **incentivize capital _uptime/solvency_, not _volume_** (reward keeping capital deposited and quotes live, not winning bids); if used, **FULL-only** (no tail to subsidize) and **vested**. For the hackathon: implement no rebates, but articulate exactly this — demonstrating we understand why audits disagree.

---

## 11. MM Hedging & the SDK (`@ilswap/sdk`)

The SDK is demand-side critical: it is how MMs price, stream, and **hedge**, and tighter MM books are what create LP liquidity (§10).

### 11.1 LP surface (simple)

```ts
previewSwap(tokenId, duration) → { V0, maxIL, maxILRatioBps, bestQuote, premium, premiumPct, expiry }
createSwap({ tokenId, duration, maxPremiumUSDC, slippageBps }) // approves NFT + USDC, settles signed quote
claimFees(swapId)
getActiveSwaps(lp) ; getPositionSummary(swapId)  // δ, fees vs premium, IL-to-date
```

### 11.2 MM surface (the cockpit)

```ts
depositCapital(amount)
withdrawCapital(amount)
// Streaming quote client — connects to the engine, pushes/cancels signed quotes
quoter.stream({ market, premiumRateOfMaxIL, band, model, capacity, validitySecs })
quoter.cancel(market)
quoter.requoteLoop(modelFn) // re-price on a tick from the MM's own model
// Risk — per-position and PORTFOLIO Greeks
risk.bookDelta()
risk.bookGamma()
risk.bookVega()
risk.exposureByMarket()
// Hedging helpers
hedge.suggestDeltaHedge() // size/venue to flatten net delta (GMX/Hyperliquid perps)
hedge.markToMarket() // live P&L, ROC, implied-vs-realized variance
```

For the hack: ship the SDK + an **example MM bot** (`examples/mm-bot.ts`) that streams quotes and prints net book delta — this is what we run live in the demo to populate the book.

### 11.3 Data-consumer surface

```ts
getLPStructuralIV(market)
getRiskAppetiteIndex(market)
getConvexityDepth(market)
```

---

## 12. The Data Surfaces — The Moat

The flow is a byproduct that is itself a product. Built passively from day one; exposed as free public APIs (The Graph + REST). Revenue is protocol fees; **data is the moat, not a paywall.**

```
SURFACE 1 — LP Convexity-Premium Index   (NOT an implied-vol surface — F-#12)
  Source  : best streamed rate per (market × MaxIL/V0 band)
  Primary : publish the rate itself (premiumRateOfMaxIL) as the convexity-premium index — this is well-defined.
  Opt lens: σ_LP ≈ √(2·rate/T_years) is a ROUGH heuristic only. The payoff is capped, path-bounded, asymmetric,
            not lognormal/variance-linear, so the inferred σ is not uniquely identifiable and is contaminated by
            liquidity / SC-risk / capital-lock premia. Present it (if at all) as a clearly-caveated derived lens,
            never as 'implied vol comparable to Deribit'. Trade the SPREAD, not the level.
  Buyers  : quant funds, vol-arb desks, options-protocol integrations

SURFACE 2 — DeFi Convexity Risk-Appetite Index
  Source : engine flow metadata, not just prices
  Signals: FULL/PARTIAL split (risk-off when FULL dominates); bid-spread tightening (fear of gamma);
           ratio-band migration (MMs fleeing to safer widths); vault inflow rate (retail tail pricing)
  Meaning: real-time DeFi vol-regime indicator (a VIX-like signal for LP markets)
  Buyers : macro funds, DeFi risk desks, structured-product issuers

SURFACE 3 — Convexity Supply Book
  Source : outstanding streamed capacity across markets/bands
  Meaning: where capital will sell gamma, at what price, what width, what duration
  Buyers : Nansen / DefiLlama / Kaiko / Dune, protocol treasuries, academics
```

Honest limits to put in the docs: the LP-IV is **contaminated** (liquidity + SC risk premium + capital lock cost) — compare the spread, not the level; the signal is **reflexive** as the protocol scales (normal for any derivative market); calibration lags at launch (no historical realized-IL dataset — _the protocol is the mechanism that creates it; that is the data moat_).

---

## 13. Contract Architecture & Stack

```
ILMath (Stylus/Rust)   computeMaxIL, computeIL — pure fixed-point math, ~10x cheaper than Solidity; Arbitrum-native
OracleManager.sol      Chainlink + sequencer + TWAP deviation; getPrice (entry) / getSettlementPrice
UnderwriterVault.sol   MM pool (deposited/locked/available); lockCollateral/releaseAndDistribute; IYieldAdapter hook
ILVault.sol            ERC-721 custody; reads NonfungiblePositionManager; claimFees passthrough
ILSwapCore.sol         state machine; verifies SignedQuote (EIP-712); CEI settlement; enforces no-bad-debt invariant
GreekDisplay.sol       read-only δ/θ/IV + 3 surfaces (zero funds, zero state)
— Phase 2 —
InsuranceVault.sol     ERC-4626; coverBadDebt; withdrawal delay; first-loss; healthRatio/circuitBreakerLevel
LiquidationManager.sol Dutch-auction forced settlement; Chainlink Automation target

Interfaces: IILMath, IPositionManager, ICollateralModel, ISettlementModule, IYieldAdapter   (scalability seams)
```

Key Arbitrum One addresses: NonfungiblePositionManager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`; v3 Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`; WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`; native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`.

```
Repo (pnpm monorepo)
  packages/contracts   Foundry — Solidity + Stylus; test/ (unit, fork, Invariants.t.sol); script/Deploy.s.sol
  packages/engine      off-chain matching relayer (Node/TS): WS quote intake, ranking, signed-payload API
  packages/sdk         @ilswap/sdk — LP / MM-quoter / data; examples/{lp-basic, mm-bot, data-consumer}.ts
  packages/subgraph    schema + mappings (Swap, Order, Market, MMStats, ConvexityBand, VaultSnapshot)
  packages/api         public REST (Railway/Fly) over the subgraph
  apps/web             React+Vite, wagmi/viem, RainbowKit, Apollo, shadcn/ui, Recharts
  apps/docs            docs.ilswap.xyz (see §14.3)
  quant/               Python notebook (§9) → params.json
  docs/                README, INTEGRATION, API, SECURITY, MATH
```

Dev: local **Nitro** node (forks Arbitrum mainnet state → real Uniswap v3 + Chainlink, free gas, instant finality) for fork tests; `cargo-stylus` for ILMath. **Foundry invariants to prove** (fuzz prices across the _full_ domain — in-range, below Pa, above Pb, and the no-IL region where `V_lp ≥ V_hold`):

- **I1 — no bad debt (FULL):** `payout ≤ collateral == MaxIL`.
- **I2 — cap correctness:** `payout == min(realized_IL, MaxIL)`.
- **I3 — non-negativity / no underflow:** `payout ≥ 0` and the IL subtraction never underflows. Note: `assert(payout >= 0)` is _vacuously true_ on `uint256` and is not a real test by itself — the meaningful proof is that `realized_IL` is computed as `V_hold > V_lp ? V_hold − V_lp : 0` (never an unchecked `V_hold − V_lp`), and the fuzzer drives `V_lp > V_hold` cases asserting **no revert** and `payout == 0`.
- **I4 — LP never profits from the swap:** `V_lp ≥ V_hold ⟹ realized_IL == 0 ⟹ payout == 0`. The LP is made whole, never more; the swap is a hedge, not a lottery.
- **I5 — vault solvency:** `locked ≤ deposited` per MM; `Σ locked` is fully backed by collateral.
- **I6 — liquidity immutability (F-#2):** settlement computes IL with the `L` stored at creation; external `increaseLiquidity` on the custodied NFT cannot raise `payout` above `MaxIL`. Fuzz: mutate on-chain `L` between create and settle, assert `payout` unchanged.
- **I7 — capacity authority (F-#6):** `Σ V0` filled against a quote ≤ its `maxNotionalV0`; a cancelled nonce-bit cannot fill; the same `quoteId` cannot over-consume under concurrent fills.
- **I8 — settlement liveness (Fork 1 fix):** for any swap, `settle()` succeeds by `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD` under any price path — the lone-spike check never permanently locks funds. Fuzz: drive arbitrary price paths through `T` (including gaps, spikes, glitches) and assert `settle` eventually succeeds within the bound.
- **I9 — oracle-anchored band enforcement (Fork 2 fix):** `createSwap` reverts iff `absBps(P_live, quote.quotePrice) > quote.priceBandBps`. Fuzz: synthesize stale quotes + arbitrary oracle gaps ⇒ band-exceeding fills always revert; within-band fills always succeed; no stale-quote fill ever exceeds the MM's chosen band.

```solidity
// I3 + I4, stated explicitly (handler fuzzes sqrtP_T over the whole range)
uint256 payout = core.settlePreview(swapId, sqrtP_T);
assertGe(payout, 0);                          // I3 (formal; underflow-safety is the real content)
assertLe(payout, swap.maxIL);                 // I1/I2 upper bound
if (vLp >= vHold) assertEq(payout, 0);        // I4 — LP cannot profit
```

---

## 14. UX / UI — Full Website Cartography

**Design law: progressive disclosure.** The LP sees **one number and one button**; the MM gets a cockpit; the curious get docs. Complexity is opt-in, never forced. This directly serves the program's "product clarity / user focus" judging.

### 14.1 `app.ilswap.xyz` (the product)

```
/                Landing. One-line value prop + 3 doors:
                 "Protect my LP position" · "Underwrite & earn" · "Earn in the Vault" (Phase 2)
                 Live stats: total covered, IL paid out, active markets, vault health.
                 Trust band: "FULL mode: bad debt is mathematically impossible — here's the proof →"

/protect (LP)    1. Connect → auto-detect v3 NFTs (read NonfungiblePositionManager)
                 2. Pick a position (shows pair, range, V0, in/out of range)
                 3. Pick duration (7/30/90d)
                 4. ONE quote, plain language:
                    "Pay $128 now to cover up to $2,400 of impermanent loss for 30 days."
                    secondary: rate (% of MaxIL), MM, settlement = European
                    [Advanced ▸] model (FULL), ratio band, raw MaxIL, oracle source
                 5. Confirm → approve NFT + USDC → swap created (toast + link to dashboard)

/dashboard (LP)  Active swaps as cards:
                 "Delta: +0.42 ETH — a 1% ETH move ≈ ±$X"
                 "Fees earned $Y vs premium $Z → net cost of protection $(Z−Y)"
                 "IL to date: $W — fully covered" + countdown to expiry + Claim fees
                 Settled swaps: payout received, NFT returned.

/underwrite (MM) Cockpit (power users): deposit/withdraw capital (available/locked gauge);
                 quoting panel (per market: rate, band, capacity, validity) with live book preview;
                 portfolio Greeks (net δ/γ/vega), exposure by market, ROC, P&L,
                 implied-vs-realized variance; hedge suggestions; CapitalLow alerts.
                 (Phase 2: PARTIAL controls, first-loss stake, liquidation feed.)

/vault (Phase 2) Deposit USDC → ifUSDC; APY (30d), health ratio (prominent), circuit-breaker badge,
                 withdrawal queue/cooldown, explicit risk disclosure modal.

/markets         The 3 surfaces, visualized (Recharts):
                 IV surface heatmap (pair×duration×band); risk-appetite regime gauge + time series;
                 convexity-supply depth per market. "Free public data — consume via API →"
```

### 14.2 Demo-critical UI touches

- A **regime/price ticker** showing the (demo) oracle price so the audience _sees_ IL move.
- Live **MM bot quotes** updating in `/markets` and `/protect` as we move price/vol → proves the quote-driven engine.
- A **settlement animation**: at expiry, "LP made whole · MM paid residual · NFT returned" with tx links.

### 14.3 `docs.ilswap.xyz` (crucial — five audiences)

The protocol is sophisticated; docs are how non-finance people _get it_ and how pros automate. Built with a docs framework (Mintlify/Docusaurus), MDX, embedded diagrams.

```
1. "What is impermanent loss?"  (zero-knowledge reader)
   Visual, plain-language: "If you'd just held, you'd have more — that gap is IL."
   Interactive slider (move price → watch IL), analogy ("like insurance for your LP"),
   glossary, FAQ. No jargon, no math.

2. LP guide        manual flow + SDK one-liner; what's covered / the MaxIL cap explained simply.
3. MM guide        run a quoting bot; the SDK quoter + hedging; risk & capital; "uptime, not volume".
4. Data / API      REST + GraphQL + SDK reference; the 3 surfaces; the contamination caveats;
                   curl + TS examples — for LPs/MMs automating strategies.
5. Protocol / security  math derivation (§3), the no-bad-debt proof, the cap, trust model (§4.5),
                   the quant model (§9) with charts, invariants, attack vectors.
```

---

## 15. Testnet Demo Plan (Arbitrum Sepolia)

**The hard problem:** real expiries are 7–90 days; a demo is 3 minutes. Solve it with a **demo deployment** that compresses time and controls price, _without_ faking the trust story.

### 15.1 Pre-seed (before the pitch)

- Deploy ILMath (Stylus) + all Phase-1 contracts to Arbitrum Sepolia; verify; record addresses.
- **Configurable durations** (allow seconds-scale, e.g. 120s) on the demo deployment only.
- **Demo oracle adapter**: an `OracleManager` mode where an operator key can set the price (still routed through the same health checks), so we can drive IL deterministically. Mainnet uses pure Chainlink.
- Mint 2–3 real Uniswap v3 ETH/USDC NFTs on Sepolia (tight + wide ranges) into demo LP wallets.
- Run 2–3 **MM bots** streaming signed quotes to the engine (different rates/bands) → a populated, competing book.
- Pre-create one swap **already near expiry** so we can settle within seconds on stage.
- Subgraph + REST + frontend pointed at Sepolia; faucets topped up (Sepolia ETH + Circle USDC).

### 15.2 Live sequence (~3 min, maximum features, minimum clicks)

1. `/markets` — MM bots quoting live; move demo vol → quotes reprice in real time (proves quote-driven engine + data surface).
2. `/protect` — LP picks a real NFT → instant best quote → "Pay $X, cover up to $Y" → confirm. (Off-chain match → on-chain settle.)
3. `/dashboard` — δ shown, IL = $0, fees-vs-premium line.
4. Operator moves demo price → IL accrues → dashboard + Surface-1 update live.
5. Settle the **near-expiry** pre-seeded swap → LP made whole, MM residual, NFT returned, tx links. **Trustless.**
6. (If Phase 2 ready) trigger a PARTIAL **Dutch-auction liquidation** → fund covers excess → health ratio dips on `/vault`.
7. Close on `/markets`: "every trade fed these three surfaces — the first on-chain LP vol data."

### 15.3 Risk management for the demo

- Everything scriptable + idempotent (one command reseeds).
- **Recorded fallback video** of the full flow in case Sepolia RPC/sequencer flakes on stage.
- Pin RPCs; pre-fund all gas; dry-run the exact click path twice.

---

## 16. Demo Pitch (technical + non-technical judges)

### 16.1 The 30-second hook (anyone)

_"If you've ever provided liquidity on Uniswap and ended up with less than if you'd just held your tokens — that's impermanent loss. It costs LPs over a billion dollars a year and there's no trustless way to hedge it. We built the first market where you can: you pay one premium, and if your position suffers impermanent loss within its range, you're paid back — with no middleman who can run off with the money."_

### 16.2 The intuitive mechanism (the picture)

- **Insurance, but trustless and competitive.** The "insurers" are market makers competing in an open quote book to underwrite your risk; you always get the cheapest price, instantly.
- **The collateral is the genius.** For any position we can compute the _worst case_ loss in advance — **MaxIL**. The MM locks exactly that much. So in our main mode, **the protocol literally cannot owe more than it holds — bad debt is mathematically impossible.** (Show the one-line invariant.)
- **Honest scope.** It covers IL up to the worst case _within your range_ (MaxIL); if price blows clean through your range you've fully rotated into one asset, and that beyond-range divergence is directional, not impermanent — and uncapped products can't stay fully collateralized. We show every LP their payoff diagram and call it an _in-range convexity hedge_, not "insurance."
- **The payoff is one number.** The LP never sees Greeks unless they want to.

### 16.3 The technical depth (for technical judges)

- MaxIL as the **collateral unit** (range-agnostic ROC → no adverse selection), with the **`min(IL, MaxIL)` cap** that makes the no-bad-debt claim a _construction_, not a hope.
- **Quote-driven dealer market**: off-chain matching (MMs requote continuously), on-chain **non-custodial** settlement via signed quotes — the matcher can't steal, forge, or force a stale quote.
- **Stylus/Rust** for the IL math (Arbitrum-native, ~10x gas).
- **The quant model**: PARTIAL parameters _derived_ from fat-tailed, correlated Monte Carlo — not guessed.

### 16.4 The moat (why it compounds)

_"Every trade emits data that doesn't exist anywhere today: the first on-chain LP volatility surface, a DeFi risk-appetite index, and a convexity-supply book. Free public API from day one. We're not just a product — we're building the Bloomberg of LP risk, and we own the dataset because we create it."_

### 16.5 The honesty slide (wins technical credibility)

_"The hard parts are LP willingness-to-pay against MM uncertainty, MM capital efficiency, and PARTIAL tail risk. Here are our five levers (RFQ pricing, hedging SDK, yield-on-collateral, treasury customers, the basis flywheel), and here's the quant rigor behind the dangerous mode. FULL mode is live and provably safe today; PARTIAL ships only when the model says it's safe. This is exactly where Arbitrum's mentors take us next."_

### 16.6 Tough Q&A (rehearse)

- _"Is LP-IV comparable to Deribit IV?"_ No — structural vol; trade the **spread**.
- _"Won't reflexivity corrupt the signal?"_ Every derivative market is reflexive; it enriches the signal (BTC futures changed miner hedging).
- _"No MMs at launch?"_ We seed 2–3 bots; volume → data → calibrated MMs → tighter spreads.
- _"Isn't the matcher centralized?"_ Settlement is non-custodial; the matcher only sequences; Orbit-chain decentralizes it.
- _"Why not Panoptic?"_ Different audience — our LP pays one number; we compute everything else.

---

## 17. Build Roadmap (the task source of truth)

Sequenced so something demoable exists at every checkpoint. **Gate: do not start a row until the row above is green.**

### Pre-buildathon (now → 25 May)

- Monorepo scaffold; local Nitro running (Arbitrum fork); `cargo-stylus` compiling.
- `ILMath` (Stylus): `computeMaxIL` + `computeIL`, 15+ unit tests vs hand-calcs (in-range / below Pa / above Pb / cap).
- `OracleManager`: Chainlink + sequencer + TWAP guard.
- `quant/` notebook scaffolded (runs in parallel all three weeks).

### Week 1 (25 May → 1 Jun) — FULL spine, on-chain

- `UnderwriterVault` (pool + IYieldAdapter no-op); `ILVault` (custody + claimFees).
- `ILSwapCore`: `createSwap` (EIP-712 verify, CEI) + `settle` (FULL/European, `min(IL,MaxIL)`).
- `Invariants.t.sol`: payout ≤ collateral; fork test: real Sepolia NFT → create → settle.
- Deploy Phase-1 to Arbitrum Sepolia.

### Week 2 (1 Jun → 8 Jun) — off-chain engine, SDK, indexing, first UI

- `packages/engine`: signed-quote intake (WS), price-time/FIFO ranking, `/quote` API.
- `@ilswap/sdk`: LP methods + MM quoter client + `examples/mm-bot.ts`.
- Subgraph (SwapCreated/Settled, quotes) + REST `/markets`,`/vault/health`,`/swap/:id`.
- Frontend `/protect` + `/dashboard` working end-to-end via SDK; `GreekDisplay` δ/θ.
- Begin `docs.ilswap.xyz` (audiences 1–2). **Checkpoint: full FULL/European demo works on Sepolia.**

### Week 3 (8 Jun → 14 Jun) — moat, polish, demo, (stretch) PARTIAL

- `/markets`: three surfaces with Recharts; Surface back-computations in subgraph.
- docs audiences 3–5; INTEGRATION/API/SECURITY/MATH; demo-mode oracle + seconds-durations + reseed script.
- Security pass (reentrancy, oracle, griefing, sequencer); gas pass; recorded fallback video; rehearse pitch.
- **Stretch (only if green + quant done):** `InsuranceVault` (+withdrawal delay, first-loss, caps), convex floor/tax from `params.json`, `LiquidationManager` Dutch auction, `/vault`, `/underwrite` PARTIAL.

---

## 18. Roadmap V1.5+ (enums/interfaces must accommodate; not built)

- **`ASIAN` settlement** (TWAP-averaged payoff) — the elegant path-dependency fix: lower variance → cheaper premium → more LP demand, smoother for MMs to hedge. Strongest near-term add.
- **`AMERICAN`** early exercise — most general, hardest to price/hedge, least liquid; keep as an option, not a headline. Do not fragment liquidity by launching multiple settlement styles per market simultaneously.
- **Secondary liquidity & exits (F-#11):** novation (an MM hands an open obligation to another MM who posts equal collateral); the MM side as a transferable "protection-writer" ERC-721 for an OTC secondary; LP early-termination by forfeiting unused premium to reclaim the NFT. The European/locked design currently gives neither side an exit — these directly ease MM participation, which §10 identifies as the binding constraint.
- Yield-on-collateral live adapters (Aave / tokenized T-bills, RWA); ifUSDC composability.
- Greek-decomposition tokens (δ/γ/θ/ν), correlation/dispersion swaps, LP-CDO tranching, v4-hook barrier/variance swaps, the ULREX unified data layer.

---

## 19. Open Questions (non-blocking)

- **Resolved this round (audit):** out-of-range positions are now **rejected at creation** (`Pa ≤ P0 ≤ Pb`, F-#2/#3); entry semantics pinned to the creation snapshot (§3.1); _what_ is hedged = gross in-range IL, not net P&L (§5.3).
- Uniswap fees during custody: LP-only (current) vs LP/MM split — affects MM incentive; V1.5.
- **One swap per NFT at a time** (the NFT is custodied by the first swap); overlapping swaps on one NFT are out of hack scope.
- **Non-USD-quoted pairs** (e.g. WBTC/ETH): settlement price = `tokenA/USD ÷ tokenB/USD`, requiring _both_ feeds healthy (compounded staleness/deviation). Phase 1 ships USD-quoted pairs only.
- **Collateral asset = native USDC**; a USDC depeg is a shared, disclosed systemic risk (premium and payout are both USDC). Reject non-standard ERC-20s (fee-on-transfer / rebasing) via a token whitelist.
- Batch swaps; governance for parameter updates; `minPartialBps` k-recalibration — post-hack.
- Exact `IYieldAdapter` venue and the % of _idle_ collateral safe to route (locked collateral is never routed to utilization venues — §7.2, F-#3).

---

_Spec v3.3 — hackathon build doc. FULL/European first; off-chain matching + on-chain non-custodial settlement; premium = % of MaxIL streamed continuously by MM models; coverage = min(IL, MaxIL); PARTIAL + Insurance Fund gated on the quant model; three data surfaces as the moat; progressive-disclosure UX; Stylus ILMath; scalable enums/interfaces for ASIAN/AMERICAN/PARTIAL._

_v3.1 audit pass (external multi-LLM). Applied 12 fixes: store `L` and use it at settlement (no `increaseLiquidity` break, I6); reject out-of-range entries; ring-fence collateral rehypothecation (idle-only, never utilization-gated); on-chain authoritative quote capacity + replay + Permit2 bitmap-nonce selective cancel (I7); dust/precision floors (`MIN_POSITION_V0`/`MIN_PREMIUM`, round-up premium); reposition as an in-range convexity hedge (payoff diagrams, qualified bad-debt claim); Surface 1 reframed as a convexity-premium index; intra-band adverse-selection caveat; direct-to-contract bypass + published quote log; secondary-exit roadmap; gross-IL (not net-P&L) clarification; convexity proof written out._

_v3.2 Fork-1 resolution. Oracle settlement liveness redesigned (§6.1, Option B accepted with C as Week-1 fallback): price still pinned to the Chainlink round at expiry `T` for fairness, but the hard Uniswap-TWAP gate is replaced by a **Chainlink lone-spike sanity check** + a **24h liveness backstop** that unconditionally accepts `px` after the window — funds can never lock indefinitely (new invariant **I8**). TWAP demoted to an advisory event._

\*v3.3 Fork-2 resolution. Quote-validity hardening shipped (§4.3.3, Option B): each signed quote now carries `quotePrice` + `priceBandBps`; on-chain `createSwap` auto-voids the quote if the live oracle has drifted beyond the band — deterministic, **not last-look**. Kills the dominant stale-quote pickoff vector for bearer-instrument quotes (signed payloads survive in observer hands beyond engine cancellation), and reuses the oracle read already needed for `P0`. `validUntil` tightened: default **8s**, band **[5s, 15s]** (was [5s, 60s]). New invariant **I9** (band enforcement). **Both audit forks now resolved — spec is build-ready.\***
