# Inflexion Protocol — Hackathon Build Spec v4.0

_The first market for Uniswap v3 impermanent-loss risk — and the first to price it **on-chain**._

_Arbitrum Open House London — Buildathon (25 May → 14 Jun 2026) + Founder House._
_Author: Alex. This document is the build spec: it is written to be read by Claude Code and turned into a complete, ordered task roadmap. Every design choice is stated with its rationale, its tradeoff, the pitch phrasing that goes with it, and where it sits in the build priority._

> **vNEXT (v4.0) — the hybrid pivot.** This revision reorganizes the protocol around **three pillars**: (1) an **on-chain published fair value** (`FairValueOracle` computes `FairPremium = fairRate · MaxIL`), (2) the **cvAMM** — a pooled passive on-chain underwriter (`ConvexityVault`, ERC-4626 USDC) that quotes algorithmically and is contractually price-capped by new **invariant I10**, and (3) the retained **MM competition rail** (Path B, EIP-712 signed quotes). The settlement core (`settle`, the MaxIL formula, invariants **I1–I9**) is **untouched** — every change in this revision is **upstream of settle**. See the changelog footer for the full diff.

---

## 0. Executive Summary

Uniswap v3 LPs carry a structural short-gamma exposure — **impermanent loss (IL)** — estimated at **>$1B/year** of realized losses across DeFi, with no trustless, non-inflationary way to hedge it.

**Inflexion is the first market for Uniswap v3 impermanent-loss risk, and the first to price that risk on-chain.** It sells a **European, fixed-maturity, in-range claim** that pays `min(IL, MaxIL)`. An LP brings a specific Uniswap v3 position (its NFT), picks a duration, and pays a fixed upfront **premium**; at expiry the protocol pays the LP their realized IL — **capped at MaxIL**, the worst case while price stays in the position's range — trustlessly, from pre-locked collateral. Precisely: this is an **in-range convexity hedge**, not unbounded "IL insurance" (§3.2 explains why the cap is load-bearing and how we communicate it so it never surprises an LP).

**Three things make it novel (vNEXT — see §3.0 The Three Pillars):**

1. **On-chain published fair value (Pillar 1).** The protocol computes and publishes `FairPremium = fairRate · MaxIL` **on-chain** via a `FairValueOracle`. `MaxIL` is pure geometry (frozen at creation, **identical across durations**); `fairRate = E_Q[min(IL, MaxIL)] / MaxIL` is an **S-curve in `σ²·T`** that carries _all_ the vol/time dependence. Theory anchors (cited, not re-derived): **Lipton–Lucic–Sepp 2025** (an IL-protection claim is statically replicable by a strip of vanilla options ⇒ priceable/hedgeable) and **Singh et al., AFT 2025** (LVR equals the theta of the ATM straddle ⇒ a closed-form anchor). The protocol prices the **specific position geometry** (width + distance-to-edge + T), never a band midpoint.
2. **The cvAMM (Pillar 2, the centrepiece).** A pooled passive underwriter (`ConvexityVault`, ERC-4626 over USDC) quotes **algorithmically on-chain** off `FairPremium` with inventory skews, posts collateral from the pool, and is **contractually capped at `FairPremium · (1 + maxLoad)` by invariant I10**. It solves cold-start (it always quotes), overcharge (capped in code), and intra-pair diversification.
3. **The MM competition rail (Pillar 3).** Sophisticated MMs compete via EIP-712 signed quotes **below** the pool. The order flow they generate remains a data asset that does not exist anywhere today — a structural LP volatility surface, a DeFi risk-appetite index, and a convexity-supply book. Built passively from day one, free public API. This is the long-term moat (now secondary to the on-chain-pricing + cvAMM headline).

`MaxIL` is still **the collateral unit**: counterparties (the pool on Path A, an MM on Path B) collateralize to MaxIL, and in **FULL mode the protocol cannot produce bad debt** — the covered payoff is capped at MaxIL by construction and MaxIL is locked. (The guarantee is exact under its stated assumptions: capped payoff, a solvent collateral asset, and oracle/settlement liveness — §3.2, §7.3, §16.5.)

**What this is NOT — and specifically not Bancor (vNEXT — stated explicitly).** The cvAMM pays claims in **pre-locked USDC and mints nothing** (no token-inflation reinsurance, no death spiral). In FULL the pool **cannot become insolvent** (collateral = MaxIL ≥ payout) and **cannot be run** (withdrawal delay + locked/free accounting). Two separate claims, never merged: (1) **LPs are always paid** — no bad debt, FULL, code-enforced (invariant I1); (2) **depositors can lose principal in a crash** — the pool is a volatility seller and **capital is NOT guaranteed** (§7.3, §8). It is also not GammaSwap (perpetual vol trading needing active management), not Panoptic (options market for quants), and not "insurance" (no actuarial mutualization, no regulatory ambiguity).

**Pitch sentence (vNEXT):** _"Inflexion is the first market for Uniswap LP convexity priced on-chain — MaxIL is the capital unit, a pooled cvAMM always quotes a code-capped fair price, and competing market makers undercut it. The resulting flow is a structural implied-volatility surface for Uniswap LPs."_

---

## 1. Architectural Decisions (Locked)

_(vNEXT: market-structure and pricing rows rewritten for the hybrid; `FairValueOracle`, the volatility oracle, default-FULL/leverage-1, and the I10 cap added as locked decisions.)_

| Parameter             | Decision                                                                                                                                                                                                         | Rationale                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chain**             | Arbitrum One (mainnet), Arbitrum Sepolia (demo), local Nitro (dev)                                                                                                                                               | Deepest Uniswap v3 liquidity; Chainlink fully deployed; Stylus support                                                                                                            |
| **AMM scope**         | Uniswap v3 only                                                                                                                                                                                                  | Focus > coverage for a 3-week build                                                                                                                                               |
| **Market structure**  | **Hybrid.** Path A — cvAMM (on-chain, signature-free, default); Path B — MM signed quotes (parallel, optional). `createSwap` routes the LP to the **cheaper of {pool price, best MM quote}**.                    | Pool removes cold-start and always quotes a code-capped price; MMs are the ceiling-of-price and export risk out of the system (§4.0, §10). Floor-of-liquidity + ceiling-of-price. |
| **Pricing**           | `premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)`, computed **on-chain**, hard-capped at `FairPremium · (1 + maxLoad)` by **I10**. `FairPremium = fairRate · MaxIL` from `FairValueOracle`. | Returns a transparent, published, code-capped fair value; skews carry inventory state. No pricing primitive hardcoded — all from `quant/params.json` (cvAMM block).               |
| **Fair-value oracle** | `FairValueOracle` publishes `FairPremium = fairRate · MaxIL` on-chain for the specific geometry; `fairRate` is the `E_Q[min(IL,MaxIL)]/MaxIL` S-curve in `σ²·T`.                                                 | Pillar 1; theory-anchored (Lipton–Lucic–Sepp 2025, Singh et al. AFT 2025). The first on-chain price for IL risk.                                                                  |
| **Volatility oracle** | `σ_ref = max(σ_short, σ_long, floor)`, EWMA of log-returns from Chainlink ticks. **Never** price off raw realized σ. Deribit DVOL = optional enrichment only.                                                    | Solvency-load-bearing for the I10 cap and depositor solvency — **not** for the FULL no-bad-debt invariant (which stays structural and oracle-independent) (§6.5).                 |
| **Collateral models** | `FULL` (default, leverage 1 = collateral 100% of MaxIL); `PARTIAL` is a **leverage dial** on the **same** pool, gated on the quant model                                                                         | FULL is provably safe; PARTIAL (collateral < MaxIL + buffer) is capital-efficient but carries real bad-debt risk — build only once Monte Carlo says the numbers are safe (§8).    |
| **Settlement style**  | `EUROPEAN` only for the hack                                                                                                                                                                                     | Simplest, most hedgeable, FULL-compatible. `ASIAN`/`AMERICAN` reserved in the enum, deferred to roadmap                                                                           |
| **Durations**         | 7d / 30d / 90d                                                                                                                                                                                                   | Three liquid maturities; T handled by market separation (one marketId per duration)                                                                                               |
| **Premium unit**      | % of MaxIL                                                                                                                                                                                                       | MM/pool ROC is range-agnostic → no adverse selection on range width                                                                                                               |
| **Coverage**          | `payoff = min(realized IL, MaxIL)`                                                                                                                                                                               | Makes FULL bad-debt-free by construction; caps the unbounded beyond-range tail                                                                                                    |
| **Price cap (I10)**   | `premium ≤ FairPremium · (1 + maxLoadBps)`, enforced **by construction** on **both** paths, **upstream of settle**                                                                                               | Overcharge is impossible by code; does not touch settle/MaxIL/I1–I9 (§13).                                                                                                        |
| **Greeks**            | Read-only analytics (δ, γ, ν, θ, convexity-premium index) + 3 data surfaces                                                                                                                                      | Demonstrates the moat; zero security surface                                                                                                                                      |
| **Scalability**       | Enums + interface-driven settlement modules                                                                                                                                                                      | New payoff/collateral types plug in post-hack without touching the core                                                                                                           |

---

## 2. Scope & Build Priority

_(vNEXT: re-sequenced around the cvAMM. Launch scope made explicit; PARTIAL reframed as a leverage dial; the multi-MM RFQ book deprioritized to a single real MM; **time is not the constraint — order for correctness.**)_

This is the single most important section for execution. Build strictly in this order; do not start a later phase until the earlier one is end-to-end green.

### Launch scope (explicit)

**ONE pool, ETH/USDC, all 9 marketIds (3 fee tiers × 3 durations 7/30/90d), FULL mode only.** If everything works and time remains: add BTC/USDC, then PARTIAL. The settlement core, MaxIL math, and invariants I1–I9 are already built and tested (see §17 and ROADMAP.md baseline).

### Phase spine (P1 → P5)

The build is sequenced quant-first because no cvAMM pricing primitive may be hardcoded (it must come from the quant — §1, §9, the audit failure):

- **P1 — single-asset cvAMM quant.** `fairRate` S-curve, `baseLoad`, `maxLoad`, `util_skew` + `dispersion_skew` curves (single-asset-calibrated), diversification CVaR collapse (N=1→100), safe routable idle fraction, senior/junior cut, optimal pool-hedge fraction. Outputs feed the **new cvAMM params schema** (documented this turn in `quant/params.cvamm.schema.json`); they do **not** edit the frozen `params.json` this turn (§9).
- **P2 — `FairValueOracle` + σ-EWMA volatility oracle.** On-chain `FairPremium = fairRate · MaxIL`; `σ_ref = max(σ_short, σ_long, floor)` from Chainlink ticks (§6.5). Builds on the shipped `OracleManager`.
- **P3 — `ConvexityVault` + capped on-chain path + I10 + Path-B schema.** ERC-4626 pooled underwriter (one per pair, 9 markets, capital fungible); signature-free Path-A `createSwap` that prices on-chain and clamps at `maxLoad` (I10 by construction); Path-B `loadBps` schema (premium derived from on-chain `FairPremium`, `loadBps ≤ maxLoadBps`); EIP-1271 vault-signer wiring; routing to the cheaper of {pool, best MM quote}.
- **P4 — engine / SDK / subgraph / API / frontend.** Path B scaled to **one real MM** (do not seed a fake book). cvAMM-first surfaces and the depositor door.
- **P5 — spec finalization + roadmap retag.** This document; move multi-asset PARTIAL quant to `quant/legacy/`; retag the never-built multi-MM RFQ items.

### Roadmap / out-of-scope for launch

`BTC/USDC` + multi-pair; cross-asset concentration skew; the **PARTIAL leverage dial**; **senior/junior tranches**; **productive-collateral integration** (idle-only, compliant form only — §7.4); **pool-level partial hedge** execution; **Panoptic hedge SDK** execution (read-only convexity analytics at launch — §11); `ASIAN`/`AMERICAN`; additional AMMs; Greek-decomposition tokens; correlation swaps; CDO tranching. See §8, §18.

**Scalability mandate for launch code:** every place that branches on model or settlement style must read an enum, never a boolean. Settlement logic lives behind an `ISettlementModule` interface so `ASIAN`/`AMERICAN` are new modules, not edits to the core. The core never hard-codes "FULL" — it asks the collateral model for its required collateral. **No cvAMM/PARTIAL pricing constant is ever a literal** — all come from `quant/params.json` (cvAMM block).

---

## 3.0 The Three Pillars (vNEXT — new)

The protocol is organized around three named pillars. Read them before any section below; they are the conceptual spine.

### Pillar 1 — On-chain published fair value

The protocol computes and **publishes** the fair value of the claim **on-chain**, via `FairValueOracle`:

```
FairPremium = fairRate · MaxIL
```

- **`MaxIL` is pure geometry** (§3.2): the maximum in-range IL of the specific position, computable at creation from `(Pa, Pb, L, P0)`. It is **frozen at creation** and **identical across the three durations** for a given position — duration changes nothing about MaxIL.
- **`fairRate = E_Q[min(IL, MaxIL)] / MaxIL`** is the fraction of MaxIL the claim is worth under the risk-neutral measure. It is an **S-curve in `σ²·T`** (and in how centered/close-to-edge the range is): ≈0 in calm/short regimes (price rarely leaves a wide range), saturating →1 in violent/long regimes (price almost surely exits). **`fairRate` carries _all_ the vol/time dependence**; MaxIL carries none.
- The protocol prices the **specific position geometry** (width + distance-to-edge + T) read on-chain from `positions(tokenId)` — **never a band midpoint**.

**Theory anchors (cite, do not re-derive).** Two 2025 results make this claim priceable and hedgeable rather than actuarial guesswork:

- **Lipton, Lucic & Sepp (2025)** — an IL-protection claim is **statically replicable by a strip of vanilla options**, so it has a model-light fair value and a concrete hedge.
- **Singh, Tarun et al. (AFT 2025)** — **LVR equals the theta of the ATM straddle**, giving a closed-form anchor for the cost of short-gamma exposure.

`fairRate` is **not a fitted surface and has no calibrated coefficients** — it has an **exact closed form**. The v3 payoff `min(IL, MaxIL)` is piecewise (a constant, a linear-in-`P`, and a `√P` arm, split by the two cap-crossing prices), and each arm integrated against the GBM density of `P_T` is a standard interval moment in the normal CDF `Φ`. So `FairPremium = E_Q[min(IL, MaxIL)]` is a finite **`Φ`-sum** (≈6–10 terms, Black–Scholes class) — no Monte Carlo, no lookup table, no fitted coefficients, evaluated live per quote. **Verified exact against the repo's own `il.py`** (closed form ≡ quadrature ≡ MC) to **~5×10⁻¹¹** across width × σ × T (`quant/_scratch_fairvalue_closedform_check.py`). The **only** residual approximation is the GBM (`r = 0`) assumption itself, which no on-chain formula removes; it is covered by the conservative `σ_ref` (§6.5) and the residual forward-vol premium is deliberately left as **MM alpha** (§10.1, §4.0 Path B). The Lipton–Lucic–Sepp / Singh straddle-theta results are the **theory anchors** for _why_ the claim is priceable and hedgeable — **not** the on-chain pricer (the exact `Φ`-sum is).

### Pillar 2 — The cvAMM (the centrepiece, Path A)

A **pooled passive underwriter**: `ConvexityVault`, an ERC-4626 vault over USDC. It quotes **algorithmically on-chain** off `FairPremium` with inventory skews, posts collateral from the pool, and is **contractually capped at `FairPremium · (1 + maxLoad)` by invariant I10**. It is the default counterparty and is **always quoting**. It solves:

- **cold-start** — there is always a price, with no MM present;
- **overcharge** — the price is capped in code (I10), not by trust;
- **intra-pair diversification** — one pool writes many positions whose exits do not all cluster at the same price.

The cvAMM is the **floor of liquidity**.

### Pillar 3 — The MM competition rail (Path B)

Sophisticated MMs compete via EIP-712 signed quotes **below** the pool. They matter for **two load-bearing reasons** (state both in the pitch):

1. **Hedged MMs export short-gamma risk _out of the system_** to the global options market (Deribit / Panoptic). A closed pool cannot do this — without MMs the protocol becomes a **closed pocket of ETH short-gamma circulating against itself**. MMs who hedge make the whole system's risk smaller, not just relocated.
2. **Forward-looking-vol MMs correct the pool's structural backward-looking bias.** The pool prices off realized `σ_ref` (a backward-looking estimator); MMs price off implied/forward vol. They are the mechanism that incorporates forward information the pool structurally cannot see.

The MM rail is the **ceiling of price**: `createSwap` routes the LP to the cheaper of {pool, best MM quote}, so an MM only wins when it genuinely beats the capped pool price.

---

## 3. Mathematical Foundation

### 3.1 IL formula — Uniswap v3

_(KEEP — verbatim, settle-path math, untouched by the pivot.)_

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

_(KEEP the convexity proof and the cap framing verbatim. vNEXT: the reference-magnitude table is **corrected** from the repo's own `il.py`; a duration-independence note is added.)_

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

**Reference magnitudes (vNEXT — corrected from `il.py` / `test_il.py`; the previous v3.3 values were placeholders ~4.2× too low at the tight end).** Geometric-symmetric range `[P0/(1+w), P0·(1+w)]`:

```
±5%  range → MaxIL ≈ 1.27% of V0
±10% range → MaxIL ≈ 2.56% of V0
±20% range → MaxIL ≈ 5.23% of V0
±50% range → MaxIL ≈ 13.76% of V0    (arithmetic centering ±50% → 18.0%)
```

These are the verified outputs of the repo's `compute_max_il` (the contract `ILMath.sol` already computes them correctly — this was a doc fix, not a code change). **MaxIL is duration-independent:** for a given position the three durations (7/30/90d) share the **same** MaxIL — only `fairRate` (§3.0, §3.3) moves with `σ²·T`, so the cvAMM publishes **three different prices for the same position**, all backed by the same MaxIL.

### 3.3 The pricing method (read this before touching pricing)

_(vNEXT — rewritten. The v3.3 "premium streamed off-chain by MM models, protocol imposes no formula, fair value is intuition-not-enforced" framing is **inverted**: the fair value is now computed and published on-chain, and the load stack is code-capped by I10.)_

Pricing is layered. Keep the layers separate in code and in the pitch.

**Layer 1 — MaxIL (on-chain, Stylus/Solidity). The collateral unit.** Pure geometry from `(Pa, Pb, L, P0)`. Independent of volatility and time. It answers "how much capital must be locked," not "how risky is this." Identical across durations.

**Layer 2 — `fairRate` and `FairPremium` (on-chain, published — Pillar 1).**

```
fairRate   = E_Q[ min(IL, MaxIL) ] / MaxIL        // S-curve in σ²·T, the SPECIFIC geometry
FairPremium = fairRate · MaxIL                     // published on-chain by FairValueOracle
```

`fairRate` is computed for the specific geometry (width + distance-to-edge + T) by the **exact closed form** (§3.0: a finite `Φ`-sum over the piecewise payoff; verified vs `il.py` to ~5×10⁻¹¹), using `σ_ref` read on-chain from the volatility oracle (§6.5) and MaxIL from `ILMath`. **There are no `fairRate` coefficients to calibrate or hardcode — the only stochastic input is `σ_ref`.** Lipton–Lucic–Sepp 2025 / Singh et al. AFT 2025 are theory anchors (§3.0), not the pricer. Where the v3.3 spec said "σ enters via continuous MM requoting," the pivot replaces this with **σ read on-chain from the vol oracle**.

**Layer 3 — the load/skew stack and the I10 cap (on-chain).**

```
premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)
        , HARD-CAPPED at FairPremium · (1 + maxLoad)        // invariant I10, by construction
```

- `baseLoad` — the structural volatility-risk premium over fair value. Motivated by the **lone-writer CVaR gap** (a single position's CVaR95 sits at ~91–100% of MaxIL, so an uncharged writer is badly underpriced) which **diversification collapses** (per-contract CVaR ~100%→78.7% as N: 1→100). The pool charges `baseLoad`; the gap is its reason to exist (§7.3, §9).
- `util_skew(locked/(locked+free))` — rises as the pool nears full commitment (§3.5).
- `dispersion_skew` — rises as outstanding coverage clusters in one width/moneyness/duration corner (§3.5).
- The sum `baseLoad + util_skew + dispersion_skew` is **clamped ≤ maxLoad**, so `premium ≤ FairPremium · (1 + maxLoad)` holds **by construction** (invariant **I10**, §13). This is enforced **upstream of settle** and does not touch settle/MaxIL/I1–I9.

`baseLoad`, `maxLoad(Bps)`, the two skew curves, and the `σ_ref` windows/floor are read from `params.json` (cvAMM block). (**`fairRate` itself has no calibrated parameters** — it is the exact closed form, §3.0.) **Hardcoding any of the load/skew/σ primitives is the exact failure the audit flagged.**

**Why % of MaxIL (the key pricing innovation).** If premium were `X% of V0`, a narrow range (tiny MaxIL) gives the underwriter enormous ROC and a wide range (huge MaxIL) gives insufficient ROC → underwriters adversely select against wide ranges → liquidity fragments. With premium as `X% of MaxIL`, the underwriter posts collateral = MaxIL and earns `X%` ROC **regardless of range width** → indifference to range → full depth.

**Both paths use the same fair value.** Path A (cvAMM) computes the formula above on-chain. Path B (MM) carries a `loadBps`; the contract derives the MM premium as `FairPremium · (1 + loadBps)` and requires `loadBps ≤ maxLoadBps` (I10 on Path B). The LP gets the cheaper of the two.

**`maxLoad` vs `maxLoadBps`.** The same I10 ceiling: `maxLoad` is the rate; on-chain it is expressed as `maxLoadBps` (basis points).

**`fairRate` reference points (σ = 60%, risk-neutral, from the repo's `il.py` Monte Carlo).** `fairRate` as a % of MaxIL — the S-curve in `σ²·T`, varying ~2–4× across durations for a single width:

| range width | 7d    | 30d   | 90d   |
| ----------- | ----- | ----- | ----- |
| ±5%         | 69.5% | 84.8% | 91.3% |
| ±10%        | 44.9% | 70.8% | 82.9% |
| ±20%        | 18.2% | 47.3% | 67.4% |

(Pre-calibration reference magnitudes; P1 replaces them with the calibrated single-asset surface in `quant/params.cvamm.schema.json`. The lone-writer CVaR95 sits at ~91–100% of MaxIL almost everywhere — the **overcharge gap** that diversification collapses, §7.3 / §9.)

**Worked Example A — one position, three prices, same MaxIL.** 50,000 USDC position, ±10% geometric range, `σ_ref` = 60%, `baseLoad` = +15%, skews = 0:

```
MaxIL = 1,280 USDC  (2.56% of V0) — IDENTICAL for all three durations
                       fairRate   FairPremium   cvAMM publishes (@ +15%)
  7d   →               44.9%        574 USDC       661 USDC   (1.32% of V0)
  30d  →               70.8%        906 USDC     1,042 USDC   (2.08% of V0)
  90d  →               82.9%      1,061 USDC     1,221 USDC   (2.44% of V0)
30d load sensitivity:  @+5% → 952 USDC   ·   @+30% → 1,178 USDC   (ceiling = FairPremium·(1+maxLoad))
```

Only `fairRate` moves with `σ²·T`; collateral (MaxIL) is constant — over 90d the ±10% band is touched ~75% of the time vs ~24% over 7d, and the S-curve does all the work. The product carries the **most** convexity value for wide/short positions (cheapest fraction of MaxIL) and the **least** for tight/long (e.g. ±5%/90d: fairRate 91%, ~87% cap-hit → effectively pre-paying a near-certain loss).

**MaxIL is a collateral/normalization unit, NOT a risk metric.** Two positions with identical MaxIL can carry very different risk (distance from current price, delta profile). Both the pool and MMs price `E_Q[min(IL,MaxIL)]/MaxIL` for the _specific geometry_ — which the next section shows dissolves the old adverse-selection story entirely.

### 3.4 No geometry information asymmetry — pricing the specific position

_(vNEXT — rewritten. The v3.3 §3.4 "ratio bands so an MM quotes without targeting a specific range" + the F-#9 "intra-band adverse selection" caveat rested on a geometry information asymmetry that the pivot declares **void**.)_

**v3 position parameters are PUBLIC on-chain.** `token0`, `token1`, `fee`, `tickLower`, `tickUpper`, and `liquidity` are all readable via `positions(tokenId)` (public external view). The old framing — "the LP knows the specific range and the MM does not, so the MM quotes a band to avoid adverse selection" — is **VOID and is deleted.** Both the pool and any MM read the exact geometry and price the **specific position** (distance-to-edge included), which **dissolves the adverse-selection problem** the ratio-band machinery existed to manage.

Consequently:

- **No more "quote independent of the specific position."** Both paths price the exact `(width, distance-to-edge, T)`.
- **The F-#9 intra-band adverse-selection caveat is retired** — there is no band-only quote to be selected against.
- **`minMaxILRatioBps` / `maxMaxILRatioBps` survive only as an optional Path-B convenience filter** (an MM may still say "I only write 2%–7% MaxIL/V0 positions"), explicitly noted as a convenience, not the core pricing model.

`MaxIL/V0` remains a useful monotone proxy for width when displaying or filtering, but it is never the pricing input — the pricing input is the full on-chain geometry.

### 3.5 The two skews — util_skew and dispersion_skew (vNEXT — new)

The load stack (§3.3) carries the pool's inventory state through **two skews**, both **calibrated on a single-asset book** — neither inherits the dead cross-asset correlation `k ≈ 1.0` (a single-pair book has degenerate cross-asset correlation, so the old multi-asset concentration skew collapses to a constant and is useless here).

- **`util_skew(locked / (locked + free))`** — rises as the pool nears full commitment of its capital. As the fraction of locked collateral grows, marginal capacity becomes scarcer and the price of new coverage rises. This skew **wires directly into the withdrawal-delay / locked-free defense** (§7.3): the same accounting that prevents a run also drives the price up before the pool is over-committed.
- **`dispersion_skew`** — rises as outstanding coverage **clusters** in one width / moneyness / duration corner. This is the honest **single-pair analogue of concentration**: many positions bunched at the same edge all hit MaxIL together in a single move, so concentrated inventory is genuinely riskier even within one pair. A well-dispersed book (different widths, moneyness, durations) is charged less.

Both skews are **clamped** as part of the `baseLoad + util_skew + dispersion_skew ≤ maxLoad` sum that enforces I10 (§3.3, §13). Their curve shapes (slopes, knees, caps) come from `params.json` (cvAMM block); **none is hardcoded.** Calibration is a P1 single-asset quant deliverable (§9).

---

## 4. Market Structure — Two Paths Into One Settlement Core

_(vNEXT — restructured. §4.0 is new and leads with Path A; §4.1–§4.2 reframed; the signed-quote machinery (§4.3–§4.6) is **retained** and retitled "Path B" — it is the Fork-2 bearer-quote pickoff defense and is **not** deleted. A `loadBps` schema field and EIP-1271 vault-signer are added as **explicitly stated** EIP-712 changes.)_

### 4.0 Two paths into one settlement core

There are two parallel paths into the **same** on-chain settlement core. The settlement core (`settle`, the `min(IL, MaxIL)` cap, the MaxIL formula, invariants I1–I9) is **identical regardless of which path opened the swap** — every difference is in `createSwap` pricing/locking, **upstream of settle**.

**Path A — cvAMM (default, on-chain, signature-free).** The LP calls `createSwap`; the contract reads `FairValueOracle.fairPremium(marketId, maxIL)` and the `ConvexityVault`'s inventory state (locked/free, dispersion), computes `premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)` clamped at `FairPremium · (1 + maxLoad)` (**I10**), and locks `ConvexityVault` collateral. **No keeper, no signed quote, no validity clock, no off-chain relayer** on this path.

**Path B — MM signed quotes (parallel, optional).** An MM posts collateral and signs a quote **below** the pool price; the LP can take it instead. This path keeps the full signed-quote rail described in §4.3–§4.6 (`validUntil`, `priceBandBps`, bitmap nonces, the Fork-2 bearer-quote pickoff defense, invariant I9) — that machinery exists precisely to protect third-party-carried signed quotes and is **not** removed. The quote now carries a `loadBps` field; the contract **derives** the premium from the on-chain `FairPremium` as `FairPremium · (1 + loadBps)` and requires `loadBps ≤ maxLoadBps` (**I10** on Path B).

**Routing.** `createSwap` routes the LP to the **cheaper of {pool price, best MM quote}**. The pool is the **floor of liquidity** (always quotes); the MMs are the **ceiling of price** (win only when they beat the capped pool). For launch we do **not** seed a fake MM book — Path A is the always-on liquidity, and a single real MM plugs in to demonstrate Path-B competition (§15).

**Implementation order (not a scope cut).** Build Path A first (the headline + always-on liquidity). Path B stays **present** in spec and contracts.

### 4.1 The Path-B market structure (what it is, and what it is not)

Path B is a **quote-driven dealer market**: only MMs (dealers) post prices; LPs (takers) only take. Price discovery on this rail is one-sided, driven by MM competition.

- **Not a CLOB.** There is no two-sided crossing; LPs never rest bids.
- **Not request-and-wait RFQ.** The LP does not broadcast a request and wait for offers. The book is _always populated_ with live streamed quotes, so the LP fills **instantly** against the best one — _or_ against the always-on pool.

MMs run sophisticated models and **stream/cancel quotes continuously** (many updates/second) as their inputs move. On-chain post/cancel at that frequency is gas-prohibitive, so **Path-B matching is off-chain; settlement is on-chain and non-custodial.** (Path A needs no relayer at all — it is pure on-chain pool pricing.)

### 4.2 The split (Path B)

| Off-chain — Matching Engine (relayer, Path B only)         | On-chain — Settlement (`InflexionCore`)                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Maintains the live quote book per market                   | Verifies the matched quote's **MM EIP-712 signature** (now via EIP-1271-capable check)   |
| MMs stream signed quotes, cancel freely (gasless)          | Derives premium from on-chain `FairPremium`; requires `loadBps ≤ maxLoadBps` (I10)       |
| Ranks by resulting premium; **price-time / FIFO** priority | Checks MM **collateral** in `UnderwriterVault` ≥ MaxIL                                   |
| Returns best quote + signed payload to the LP frontend     | Locks collateral, pulls premium, takes NFT custody, writes `SwapRecord`; enforces I1–I10 |

**The FULL no-bad-debt guarantee is independent of matching** — it is enforced at on-chain settlement (collateral = MaxIL, payoff capped), regardless of how the quote was discovered or which path opened the swap.

### 4.3 The signed quote (Path B; firm, no last-look)

_(vNEXT: `loadBps` field added — premium is now derived from the on-chain `FairPremium`, not streamed as `premiumRateOfMaxIL`. The `SIGNED_QUOTE_TYPEHASH` string and `hashQuote` encoding change accordingly. **This is a pre-authorized EIP-712 verification change and is stated here explicitly.** Verification moves from `ECDSA.recover` to OZ `SignatureChecker.isValidSignatureNow` to support EIP-1271 contract signers — see §4.7.)_

```solidity
struct SignedQuote {
    address mm;                  // signer; must have collateral in UnderwriterVault (or be an EIP-1271 contract signer)
    bytes32 marketId;            // keccak(token0,token1,feeTier,durationSeconds)
    uint16  loadBps;             // MM's load over on-chain FairPremium (replaces premiumRateOfMaxIL); require ≤ maxLoadBps (I10)
    uint16  minMaxILRatioBps;    // optional ratio-band filter (convenience only — no longer an asymmetry fix, §3.4)
    uint16  maxMaxILRatioBps;    // optional ratio-band filter
    uint128 quotePrice;          // oracle price at signing — anchor for the band check (Fork 2, §4.3.3)
    uint16  priceBandBps;        // ±band around quotePrice; quote auto-voids on-chain if exceeded
    uint8   model;               // CollateralModel.FULL (PARTIAL deferred to the leverage-dial roadmap)
    uint16  partialRatioBps;     // 0 in FULL
    uint128 maxNotionalV0;       // capacity this quote may consume
    uint64  validUntil;          // absolute expiry ts; default now+8s, band [5s,15s] (see §4.3.1)
    bytes32 quoteId;             // unique id; on-chain capacity + replay tracking key (§4.3.2)
    uint256 nonce;               // Permit2-style bitmap (word<<8 | bit): selective cancel, never cancel-all (§4.3.2)
    bytes   signature;           // EIP-712 (ECDSA or EIP-1271)
}
```

> **vNEXT EIP-712 change (stated explicitly, pre-authorized).** `premiumRateOfMaxIL` is replaced by `loadBps`. The contract derives the MM premium as `premium = FairPremium · (1 + loadBps)` (rounded UP, F-#8) and requires `loadBps ≤ maxLoadBps` (invariant I10 on Path B). Because the struct changed, the `SIGNED_QUOTE_TYPEHASH` string and the `abi.encode(...)` in `hashQuote` are bumped accordingly. This is the only change to the EIP-712 schema; the verification recovery is also broadened to EIP-1271 (§4.7). Both are flagged here per CLAUDE.md's "do not silently change EIP-712 verification" rule.

**Firm quotes, not last-look — but oracle-anchored (Fork 2 — Option B).** The MM cannot reject at settlement. "Last look" is more MM-friendly but undercuts trustlessness and enables the abuse pattern auditors flag — the hybrid keeps firm quotes + the oracle band and adds no last-look path. MM protection comes from three deterministic, on-chain mechanisms: (1) an **oracle-anchored price band** (§4.3.3) that auto-voids the quote if the live oracle has drifted beyond `priceBandBps` from `quotePrice` — kills the dominant pickoff attack (gap-on-stale-quote, including bearer-instrument leakage past off-chain cancel); (2) a **short `validUntil` window** (§4.3.1) — bounds the leakage interval; (3) **on-chain selective nonce invalidation** (§4.3.2). All three are deterministic — no MM discretion at fill, so this is _not_ last-look (no fading, no abuse vector).

#### 4.3.1 Sizing `validUntil` (default **8s**; band **[5s, 15s]**; MM-configurable)

`validUntil` is a **latency parameter, not a risk-capital one** (the Monte Carlo of §9 does not set it). With the §4.3.3 oracle-anchored band as the **primary** pickoff defense, `validUntil` is now a secondary, leakage-window control — it bounds how long a bearer-instrument signed quote can survive in observer hands. (Path A has no `validUntil` — it has no signed quote.)

Window budget on Arbitrum: sequencer soft-confirmation is sub-second (~0.25s blocks), tx inclusion ~1–3s; the variable cost is **human** (wallet popup + read + click ≈ 5–12s), plus RPC margin. So:

- **Default `now + 8s`** — covers a fast wallet-sign + submit + inclusion under normal conditions; tight enough that a leaked quote dies quickly.
- **Protocol-enforced band [5s, 15s]** — tightened from v3.1's [5s, 60s] per audit. Floor 5s avoids griefing reverts; ceiling 15s caps the leakage window even when an MM picks the maximum.
- **UX rule:** the frontend fetches/locks the freshest quote **at the "Confirm" click**, not at page load, so the clock measures commit→confirm.
- **Book-freshness ≠ signed-validity.** The engine drops quotes not refreshed within ~1–2s; MMs re-sign continuously, so per-quote exposure auto-expires and on-chain cancels are rarely needed.
- **Calibrate the default** against measured fill latency on Arbitrum Sepolia in Week 2; the value lives in engine + frontend config, not hardcoded in the contract (the contract only enforces the [5s, 15s] band against `block.timestamp`).
- **If LP revert rate proves too high in Sepolia testing**, raise the default to 10–12s — the band check (§4.3.3) is the primary protection, so the clock can be relaxed.

#### 4.3.2 Cancellation, replay, and capacity (Path B; on-chain authoritative)

- **Selective cancel, never cancel-all (F-#7).** `nonce` is a **Permit2-style bitmap** (a 256-bit word index + bit). An MM cancels _one_ quote by flipping _one_ bit; a single incrementing nonce would invalidate every outstanding quote at once and empty the book during exactly the fast markets where the MM wants to pull only one. Cancels are batchable (flip many bits in one tx).
- **Replay / double-spend protection (F-#6).** The off-chain engine is advisory; **on-chain is authoritative.** `InflexionCore` tracks `consumedNotional[quoteId]`; `createSwap` requires `consumedNotional[quoteId] + V0 ≤ maxNotionalV0`, then increments it atomically (Phase 3, before any external call). A signed quote can fill repeatedly _only_ up to its capacity, and never after its bit is cancelled; concurrent submissions cannot over-consume because check-and-increment is one transaction.
- **Capacity unit (F-#6).** `maxNotionalV0` is denominated in **V0 (position value)**, not collateral. (Optionally the same accounting may cap per-market notional the pool writes on Path A — quant-sized — but the capacity logic itself is unchanged.) The SDK surfaces both numbers so MMs size capacity knowing it bounds notional, not capital.

#### 4.3.3 Oracle-anchored price band — Fork 2 resolution (Option B; Path B only)

The audit (GPT High) identified that firm quotes + any clock-based validity feed a one-sided stale-quote pickoff: when vol gaps, the MM is short convexity, and a searcher holding the signed bytes can submit on-chain even after the engine has dropped the quote — **signed payloads are bearer instruments that survive in any hand that copied them**, beyond off-chain engine cancellation. (Path A has no signed payload, so it has no such vector — it prices off the live `FairValueOracle` directly.)

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

**Frontend UX implication.** On a band-revert, the SDK auto-refetches the freshest quote and re-attempts transparently (the LP sees "refreshing quote..." and never a raw error). In stable markets this never fires; in fast markets it fires a few times and resolves once vol calms. (If the pool is cheaper, the SDK simply routes to Path A and the band never enters the picture.)

**Residuals (acknowledged, not blockers):**

- **Vol-only moves** (implied vol jumps without much spot drift): not caught by a spot band. Small attack surface on crypto majors where vol spikes correlate with spot; mitigated by `validUntil` + per-block caps. V1.5 may add an IV-anchored band when an on-chain IV oracle exists.
- **Within-band drift:** the MM bears it. Correct — they chose the band.
- **Oracle lag:** if Chainlink hasn't ticked yet on a fast move, `P_live` still equals the stale value and the check passes. Chainlink majors tick on 0.05% deviation (sub-second on real moves) so this is small; for thinner feeds, MMs widen `priceBandBps`.

### 4.4 Matching algorithm (Path B engine, off-chain)

```
On LP coverage intent (tokenId, duration, modelPref):
 1. Read position from NonfungiblePositionManager (off-chain RPC): token0/1, feeTier, ticks, L
 2. Compute MaxIL, V0, maxILRatioBps (same Stylus/SDK math as on-chain)
 3. marketId = keccak(token0, token1, feeTier, durationSeconds)
 4. Filter live quotes: model ok; (optional ratio filter) ; capacity ≥ V0; validUntil > now; nonce live; loadBps ≤ maxLoadBps
 5. Rank by premium = FairPremium·(1+loadBps) ASC; break ties by quote arrival time (FIFO)
 6. Compare the best MM premium to the on-chain pool premium; return the CHEAPER + (if MM) signed payload
 7. LP confirms → frontend submits createSwap(...) on the chosen path
```

If the top MM's capacity < V0, fall back to next quote (hackathon: single-MM full fill; production: walk the book / split fills). If no MM beats the pool, the LP simply takes Path A.

### 4.5 Trust model (the question every judge asks)

Settlement is **non-custodial**, so the engine's power (Path B only) is strictly bounded:

- **Cannot steal funds** — settlement is on-chain against the counterparty's own collateral (the pool on Path A, the MM's `UnderwriterVault` on Path B).
- **Cannot forge quotes** — every Path-B quote is MM-signed (EIP-712 / EIP-1271).
- **Cannot force a stale quote** — `validUntil` + on-chain nonce + the oracle band.
- **Cannot censor Path A at all** — Path A needs no engine; the LP transacts directly on-chain against the pool.
- **Can** censor or reorder Path-B flow (a liveness/fairness concern, not solvency). Three first-class mitigations (F-#13): (1) **direct-to-contract fallback** — because EIP-712 verification is on-chain, an LP holding any valid signed quote can call `createSwap` _directly_, bypassing the engine; the SDK exposes this path, so a censoring operator simply loses that flow. (2) The engine **publishes its full quote stream and match decisions** to an append-only log, making ordering auditable. (3) Deterministic price-time rules. The operator can degrade Path-B liveness/fairness but cannot capture users who route around it — and Path A is immune.

**Decentralization roadmap (Arbitrum-native pitch line):** a dedicated **Orbit chain** could host the Path-B quote book fully on-chain with negligible gas (the Hyperliquid model), removing the off-chain component entirely. Too large for the 3 weeks; it is the clean answer to "isn't the matcher centralized?" — and the cvAMM is already fully on-chain today.

### 4.6 Hackathon implementation of the engine (Path B)

Do **not** build an exchange-grade matcher. Build a **thin relayer**: MM bots push signed quotes over WebSocket/REST → in-memory (Redis) store keyed by market → best-per-quote maintained → `/quote?tokenId&duration` returns the ranked best (compared against the on-chain pool price) + signed payload. Because the demo MM is a bot we control, this is ~a weekend, and it demos beautifully (watch the pool quote always-on, then one MM undercut as we move price/vol; the LP always sees the live cheapest price). **Do not seed a fake multi-MM book** — a single real MM demonstrates Path-B competition; the cvAMM removes cold-start by always quoting.

### 4.7 EIP-1271 vault-signer (vNEXT — new; stated change to verification)

The `ConvexityVault` (Path A) **owns its collateral directly** — there is no keeper EOA that can drain pooled capital. To let the vault (a contract) act as an on-chain signer where needed, verification of Path-B signatures moves from `ECDSA.recover` to OpenZeppelin **`SignatureChecker.isValidSignatureNow`**, which supports **EIP-1271 contract signers** in addition to ECDSA EOAs. Path A is **signature-free at the point of sale** (the LP transacts directly against the pool); the vault still owns the collateral. OZ `SignatureChecker` is **already vendored** in `lib/`, so this adds no new external dependency. **This is a pre-authorized change to EIP-712/1271 verification and is flagged explicitly per CLAUDE.md.**

---

## 5. Swap Lifecycle — FULL / EUROPEAN

_(vNEXT: `createSwap` (§5.2) gains a Path-A branch and the I10 clamp; `settle` (§5.4), the `min(IL,MaxIL)` cap, stored-L (F-#2/I6), CEI ordering, ACTIVE freeze/claimFees, and "what is hedged" (F-#14) are **untouched** and KEEP verbatim. `SwapRecord` (§5.1) drops the stale `sqrtP0X96` field to align with shipped code — Task 5.12 removed it (−22.1k gas/op) — and records the collateral source / path.)_

### 5.1 `SwapRecord`

```solidity
struct SwapRecord {
    uint256 tokenId;
    address lp;
    address counterparty;     // Path A: address(convexityVault); Path B: the MM
    uint128 V0;
    uint128 maxIL;            // collateral unit; coverage cap
    uint128 collateral;       // FULL: == maxIL
    uint128 premium;
    uint8   model;            // CollateralModel
    uint8   settlement;       // SettlementStyle.EUROPEAN
    uint8   path;             // 0 = Path A (cvAMM), 1 = Path B (MM)  — selects the vault at settle
    uint64  createdAt;
    uint64  expiry;           // createdAt + duration
    uint128 amount0Entry;
    uint128 amount1Entry;
    uint128 liquidity;        // L snapshotted at creation; settlement uses THIS, never a re-read (F-#2)
    Status  status;           // CREATED → ACTIVE → SETTLED
}
```

> **vNEXT note.** `sqrtP0X96` was removed from the shipped contract in Task 5.12 (entry price is reconstructed from stored entry amounts) — the v3.3 spec still listed it; corrected here. `path` (and the renamed `counterparty`, which is the pool address on Path A and the MM on Path B) tells `settle` which vault holds the collateral; the settle math is otherwise identical.

### 5.2 `createSwap` — CEI, atomic (two paths, one effects/interactions block)

_(vNEXT: the READ → CHECKS → EFFECTS → INTERACTIONS skeleton is unchanged. The only changes are: how the premium is obtained (Path A computes it on-chain; Path B derives it from `FairPremium`), the I10 clamp, the routing, the vault dispatch for the collateral lock, and the premium-distribution branch. Everything else inside `createSwap` is UNTOUCHED: NFT `ownerOf`; `positions()` read + marketId cross-check; on-chain `Pa`/`Pb` via `TickMath`; the in-range gate `Pa ≤ P0 ≤ Pb`; `computeMaxIL`; the entry-amount snapshot; `V0`; dust floors; `consumedNotional`/I7; `_useNonce`/I7; the CEI ordering; the `SwapRecord` write.)_

```
PHASE 1 — READ (no state change)
  position = nftManager.positions(tokenId);  require ownerOf(tokenId) == msg.sender
  require Pa ≤ P0_tick ≤ Pb                     // F-#2/#3: reject out-of-range positions (entry must be in range)
  L = position.liquidity                        // snapshot ONCE → stored in SwapRecord; never re-read at settle
  P0 = oracle.getPrice(token0, token1)          // creation snapshot, TWAP-disciplined
  maxIL = ILMath.computeMaxIL(sqrtP0, sqrtPa, sqrtPb, L); V0 from amounts
  FairPremium = fairValueOracle.fairPremium(marketId, maxIL)         // Pillar 1: on-chain published fair value (uses σ_ref)

  // ---- Path A (cvAMM, signature-free, default) ----
  (locked, free, dispersion) = convexityVault.inventory(marketId)
  loadA = baseLoad + util_skew(locked,free) + dispersion_skew(dispersion)   // all curves from params.json (cvAMM block)
  loadA = min(loadA, maxLoad)                                                // I10 clamp, BY CONSTRUCTION
  premiumA = ceilDiv(FairPremium * (10000 + loadA), 10000)                   // round UP (F-#8)

  // ---- Path B (MM signed quote, optional) ----
  // if a signed quote is supplied:
  verify SignatureChecker.isValidSignatureNow(quote.mm, hashQuote(quote), quote.signature)   // EIP-712/1271 (§4.7)
  require quote.loadBps <= maxLoadBps                                        // I10 on Path B
  premiumB = ceilDiv(FairPremium * (10000 + quote.loadBps), 10000)          // derived from on-chain FairPremium

  // ---- Routing: cheaper of {pool, best MM quote} ----
  (premium, path, counterparty) = (premiumB < premiumA && quoteSupplied)
                                    ? (premiumB, PATH_B, quote.mm)
                                    : (premiumA, PATH_A, address(convexityVault));

PHASE 2 — CHECKS (requires only)
  require V0 >= MIN_POSITION_V0 && premium >= MIN_PREMIUM             // F-#8/#13: no dust / no free coverage
  // Path-B-only checks (a signed quote being validated):
  if (path == PATH_B) {
    require maxILRatioBps in [quote.min, quote.max]                   // optional ratio filter (§3.4)
    require quote.validUntil > block.timestamp && nonce-bit live (§4.3.2)
    require absBps(P0, quote.quotePrice) <= quote.priceBandBps        // Fork 2: oracle-anchored band (§4.3.3, I9)
    require consumedNotional[quoteId] + V0 <= quote.maxNotionalV0     // F-#6: on-chain capacity authority (I7)
    require underwriterVault.availableBalance(quote.mm) >= collateral // FULL: collateral = maxIL
  } else {
    require convexityVault.freeBalance() >= collateral               // FULL: collateral = maxIL, from pooled USDC
  }
  require premium <= maxPremiumUSDC                                   // LP slippage guard
  // I10 (both paths): premium <= FairPremium*(1+maxLoad) holds by the clamp / the require above

PHASE 3 — EFFECTS (state, no external calls)
  if (path == PATH_B) consumedNotional[quoteId] += V0; _useNonce(...)  // F-#6/#7: replay-safe (Path A skips nonces)
  (path == PATH_A ? convexityVault : underwriterVault).lockCollateral(counterparty, collateral)
  swaps[id] = SwapRecord{ ..., path, counterparty, liquidity: L }     // store L (F-#2)

PHASE 4 — INTERACTIONS (external last)
  USDC.transferFrom(lp, this, premium)               // USDC first: if it reverts, NFT never moved
  nftManager.safeTransferFrom(lp, ilVault, tokenId)  // NFT last
  _distributePremium(premium, path)                  // Path A: underwriter share → ConvexityVault (depositor yield) + treasury;
                                                      //         Path B: MM 99% / treasury 1% (unchanged)
  emit SwapCreated(...)
```

Premium-before-NFT ordering means an under-approved LP reverts before losing NFT custody. `MIN_POSITION_V0` (e.g. $100) and `MIN_PREMIUM` (e.g. $1 USDC) block dust swaps that would grief capacity into many tiny locked slots (F-#13) and close the integer-division free-coverage edge (F-#8); both governance-tunable.

**Premium distribution (vNEXT branch).** On **Path A** the counterparty is the pooled `ConvexityVault`, not a single MM, so the underwriter share routes **into the vault** (accruing to ERC-4626 depositors) plus the treasury cut. On **Path B** the existing MM/treasury split is unchanged. Splits remain governance/quant-sourced, not new hardcodes.

**Protocol fee (FULL) = 1% of premium** (the underwriter keeps 99%). It is a fee on _premium_, not notional: premium ≈ `FairPremium·(1+load)` ≈ a small % of V0 for typical 30-day ranges, so 1% of premium ≈ **0.005–0.05% of V0** — an order of magnitude below the LP's expected Uniswap fee income (it never flips the carry-positive calculus) and at/below peer venue takes (dYdX taker ≈ 0.05% of notional). Governance-tunable within **[0.5%, 2%] of premium**; chosen low to bootstrap flow.

### 5.3 ACTIVE

_(KEEP — verbatim. Settle-path / custody behavior is untouched by the pivot.)_

- NFT held in `ILVault`; LP keeps fee accrual and may `claimFees(tokenId)` anytime (no rehypothecation).
- **Position is frozen.** While in custody the LP cannot re-range, add/remove liquidity, or exit early — a real opportunity cost for active LPs and a key reason short durations exist. Disclosed prominently in the UX (§14.1); early-exit / re-range is on the roadmap (§18, F-#11).
- **Liquidity-modification safety (F-#2).** Anyone can call `increaseLiquidity` on a v3 NFT (it is not owner-gated), so a custodied NFT's `L` can be changed externally. This is **harmless because settlement uses the `L` stored at creation**, never a re-read — extra liquidity is simply returned to the LP with the NFT at settlement and can never inflate the payout above MaxIL. `decreaseLiquidity`/`collect` are owner-gated; the owner is `ILVault`, which exposes only `claimFees`.
- **What is hedged (F-#14).** The product hedges **gross in-range IL**, not the LP's net P&L. The LP also earns Uniswap fees (their pay for providing liquidity); total outcome = fees − IL + payout − premium, which _can_ be positive. That is correct, not a leak — invariant I4 (LP never profits _from the swap_) concerns the payout, which is still `0` whenever IL is `0`. Underwriters should price knowing LPs earn fees (rational WTP ≈ `E[IL] − E[fees] + risk premium`); the SDK/docs guide this.
- Collateral locked in the relevant vault (`ConvexityVault` on Path A, `UnderwriterVault` on Path B), non-withdrawable.
- `GreekDisplay` serves δ, γ, ν, θ, convexity-premium index (pure view).
- FULL: no monitoring needed — liquidation is mathematically impossible.

### 5.4 SETTLED (callable by anyone at `block.timestamp ≥ expiry`)

_(KEEP — verbatim. `settle` is the untouched core; it dispatches the release to whichever vault holds the collateral based on `SwapRecord.path`, but the payout math is identical.)_

```
oracle.requireHealthy()                       // sequencer up, prices fresh, deviation ok
P_T = oracle.getSettlementPrice(token, expiry, hintRoundId)   // Chainlink round at expiry T (§6.1)
realized_IL = ILMath.computeIL(sqrtP_T, sqrtPa, sqrtPb, swap.liquidity, amount0Entry, amount1Entry)  // STORED L (F-#2)
payout = min(realized_IL, maxIL)              // the cap

FULL:
  LP            ← payout            (from counterparty collateral)
  counterparty  ← maxIL − payout    (residual; Path A returns it to the pool, Path B to the MM)
  NFT           → LP
emit SwapSettled(id, realized_IL, payout)
```

If the oracle is unhealthy, settlement reverts and is retryable — neither party can exploit downtime. The release dispatches to `ConvexityVault.releaseAndDistribute` (Path A) or `UnderwriterVault.releaseAndDistribute` (Path B) per `SwapRecord.path`; the cap, the stored-L IL computation, and the no-bad-debt guarantee are identical.

---

## 6. Oracle Design (`OracleManager`) + Volatility Oracle

_(vNEXT: §6.1–§6.4 are the settlement/creation price oracle (Fork-1, lone-spike, liveness, feeds) and are **KEEP verbatim** — settle-path, untouched. §6.5 is **new**: the required on-chain volatility oracle that feeds `FairValueOracle`.)_

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

### 6.5 Volatility oracle — `σ_ref` (vNEXT — new; REQUIRED this build)

The cvAMM and `FairValueOracle` need an on-chain volatility estimate to compute `fairRate`. A **separate** `VolOracle` contract provides it (do **not** overload `OracleManager` with vol estimation — it may share the Chainlink feed reference, but the responsibilities are distinct).

```
σ_ref = max( σ_short , σ_long , floor )
```

- `σ_short`, `σ_long` are **EWMAs of log-returns** computed from Chainlink price ticks (two horizons). The EWMA half-lives, the floor, and the sampling cadence come from `params.json` (cvAMM block); **none is hardcoded.**
- **Mandatory conservatism caveat.** **Never price off raw realized σ.** Realized volatility _understates_ risk right before a regime change — a stale-σ regime jump is exactly where the in-flight book bleeds, and it is the single biggest model risk. The `max(σ_short, σ_long, floor)` construction is the conservative guard: it cannot fall below the slower estimate or the floor, so it does not collapse to a deceptively calm number just before a jump. This caveat is **mandatory** and is not optional engineering.
- **Do not chase on-chain implied vol.** There is no deep on-chain options market; Deribit holds >90% of ETH options off-chain. Depending on an on-chain IV oracle would reintroduce removed fragility. **Deribit DVOL is an optional published enrichment only — never depended on** by any solvency-relevant path.

**Load-bearing scope (precise, mandatory).** `σ_ref` (and `FairValueOracle`) is **solvency-load-bearing for the I10 cap and for depositor solvency** — a wrong σ mis-prices the load and can underpay the pool's depositors. It is **NOT** load-bearing for the **FULL no-bad-debt invariant (I1)**, which stays **structural and oracle-independent**: in FULL, collateral = MaxIL ≥ payout by construction regardless of what σ was. So a vol-oracle fault can cost depositors money (bad pricing) but can **never** create LP bad debt in FULL. These are two different guarantees and the spec never merges them.

---

## 7. Capital — Vaults + Yield on Collateral

_(vNEXT: §7.1 (`UnderwriterVault`, per-MM) is **KEEP** and now explicitly backs Path B. §7.2 (idle-only yield) is **KEEP and reinforced** — the prompt's "Aave for locked collateral" idea is **explicitly BLOCKED** by CLAUDE.md and is flagged, not encoded. §7.3 (`ConvexityVault`, the cvAMM pool) and §7.4 (compliant productive collateral) are **new**.)_

### 7.1 Pooled MM capital — `UnderwriterVault` (Path B)

One pool per MM; collateral auto-pulled at match (never in the quote payload). This is the collateral home for **Path B** and is unchanged by the pivot.

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

### 7.2 Yield on locked collateral (compliant form only — hard rule)

Locked USDC otherwise sits idle, forcing underwriters to demand a higher premium, which suppresses LP demand (§10). Route **idle/free** collateral to a conservative venue so the underwriter **earns base yield while idle**:

- **Launch:** design the hook + interface (`IYieldAdapter`), wire a no-op adapter (keep collateral liquid for the demo).
- **Roadmap:** route only to venues that are **instantly redeemable and not utilization-gated** — tokenized T-bills / `sDAI`-type wrappers. **Hard rule (F-#3): never route _locked_ collateral into utilization-based lending (Aave/Compound).** In a correlated crash, borrow utilization hits 100%, withdrawals revert, and `releaseAndDistribute` at settlement fails — silently breaking the no-bad-debt guarantee through an _external_ dependency. Only **idle (unlocked)** capital may touch any external venue, and collateral backing an active swap must stay instantly recallable. Cap the routed %; keep nude USDC for worst-case simultaneous claims; the LP premium and the invariant are never touched.

> **⚠ vNEXT CLAUDE.md CONFLICT (flagged, NOT encoded).** The pivot brief floated "route _locked_ collateral to Aave for yield." This **directly violates** CLAUDE.md's hard rule, spec §7.2 F-#3, and the original audit fix. It is **EXPLICITLY BLOCKED** and is **not** encoded as the design. Only the compliant form above (idle/free USDC, instantly-redeemable wrappers, hard cap, never utilization-gated, never 100%, nude-USDC buffer) is encoded. Routing locked collateral to a utilization-gated venue would require an explicit **owner override of CLAUDE.md** — until then, do not do it. The quant sizes only the **safe routable idle fraction** (§9). ROADMAP.

Lifecycle example (Path B): Bob deposits $50k once; posts quotes on 3 markets (no collateral in payload); Alice matches (MaxIL $2,400) → `lockCollateral(Bob, 2400)`, available $47,600; at settlement (IL $800) → Alice gets $800, Bob gets $1,600 back, available rises.

### 7.3 `ConvexityVault` — the cvAMM pooled underwriter (vNEXT — new; Path A; ERC-4626)

The centrepiece of Pillar 2. A **pooled passive underwriter** built as an OpenZeppelin **ERC-4626** vault over USDC (OZ ERC-4626 is already vendored in `lib/`).

- **One vault per pair, 9 markets inside it.** `marketId = keccak(token0, token1, fee, durationSeconds)`. For ETH/USDC that is **3 fee tiers × 3 durations (7/30/90d) = 9 marketIds**. **One** `ConvexityVault` holds pooled USDC and **quotes a separate price into each of the 9 markets** — same capital, 9 products, like one insurer's treasury backing 9 product lines. **Capital is fungible across the 9**; each written position locks its MaxIL on demand. This maximizes intra-pair diversification (different widths/durations/entries do not all exit at the same price) and capital efficiency vs 9 separate silos.
- **Algorithmic on-chain quoting.** Off `FairPremium` (Pillar 1) with the `util_skew` + `dispersion_skew` inventory skews (§3.5), **capped by I10** (`premium ≤ FairPremium·(1+maxLoad)`, by construction). It exposes its inventory state (locked/free, dispersion) to `createSwap` (Path-A pricing) and `lockCollateral`/`releaseAndDistribute` to `settle`.
- **Cannot be run; cannot (in FULL) be insolvent.** A **withdrawal delay** + locked/free accounting (free vs locked, like the MM vault) means depositors cannot run the pool, and in FULL the pool's locked collateral always equals MaxIL ≥ payout. The pool can have a **bad month**, but in FULL it **cannot be insolvent and cannot be run** (see the not-Bancor argument, §0).
- **EIP-1271 owner of collateral.** The vault owns its collateral directly and can act as an on-chain signer where needed (§4.7) — no keeper EOA can drain pooled capital. Path A is signature-free at the point of sale.
- **Depositor disclosure: CAPITAL IS NOT GUARANTEED** (§7.5).
- **No pricing primitive is hardcoded.** All skew/load/σ primitives (`baseLoad`, `maxLoad`, the two skew curves, the `σ_ref` windows/floor) come from `params.json` (cvAMM block). (`fairRate` is the exact closed form — no coefficients, §3.0.) **Hardcoding any of them is the exact audit failure.**

### 7.4 Productive collateral — compliant form only (vNEXT — new; ROADMAP)

The depositor-viability levers (§10, Inefficiency 3) include putting **idle** pool USDC to work. The **only** form encoded here is the compliant one (identical to §7.2's rule, applied to the pool):

- **Idle/free vault USDC only.** Never collateral backing an active swap.
- **Instantly-redeemable wrappers only** (`sDAI` / tokenized T-bills). **Never** utilization-gated venues (Aave/Compound).
- **A hard cap, never 100%.** Always keep nude USDC for worst-case simultaneous claims.
- The quant (§9) sizes the **safe routable fraction**. ROADMAP / P-later. The "Aave for locked collateral" idea is **BLOCKED** (§7.2 box).

### 7.5 Single-asset depositor disclosure (vNEXT — new; verbatim)

The cvAMM depositor surface (and `docs.inflexion.xyz`) **must** carry this disclosure. The tone is mandatory; **the numbers are PLACEHOLDER pending the P1 single-asset quant** (§9) — the earlier multi-asset figures are materially optimistic for one pair and must not be reused.

> **"You earn the volatility risk premium in calm markets and absorb losses in crashes. In FULL the pool cannot become insolvent and cannot be run, but YOUR CAPITAL IS NOT GUARANTEED."**

**Two claims, never merged:**

1. **LPs are always paid** — no bad debt, FULL, code-enforced (invariant I1).
2. **Depositors can lose principal in a crash** — capital is NOT guaranteed; this is a volatility-selling product.

**Do not call it stable or modest APY.** It is a vol-selling product: high variance, mono-factor on a single pair (§8, Inefficiency 3). Numbers go in only after the P1 single-asset quant produces the depositor loss distribution.

---

## 8. Collateral Leverage Dial — FULL (launch) / PARTIAL (roadmap)

_(vNEXT — reframed. FULL vs PARTIAL is a **leverage dial on the ONE `ConvexityVault`**, not a second pool. The v3.3 separate-`InsuranceVault`-product framing is retired; the safety stack remains ROADMAP and still sources every constant from `params.json` — hardcoding is the audit failure. Two depositor-viability/tail concepts (senior/junior tranching, pool-level partial hedge) are added as roadmap concepts. The depositor disclosure is the new single-asset version, §7.5.)_

**FULL vs PARTIAL is a leverage setting on one pool, not two pools.**

- **FULL (default, leverage 1):** collateral = 100% of MaxIL ⇒ **no bad debt possible** (the structural guarantee, the launch mode, and the headline).
- **PARTIAL (roadmap, gated on the quant):** collateral < MaxIL + buffer ⇒ capital-efficient, **but with real bad-debt risk**. It is a dial on the same `ConvexityVault`, not a distinct product. **Do not implement until the quant model (§9) returns validated single-asset parameters.** Building PARTIAL on guessed numbers _is_ the failure auditors warn about.

**Parameter provenance — no PARTIAL constant is hardcoded.** The liquidation buffer `k`, circuit-breaker health thresholds, collateral floor curve, leverage-tax curve, withdrawal delay, per-market/per-MM exposure caps, and first-loss size are **all read from `params.json`** (cvAMM/PARTIAL block) — never defaulted in code. (The multi-asset PARTIAL outputs from the v3.3 build — `c_min = 7.25%`, `fund_target = $74k`, fee curve, exposure caps, breakers, first-loss — are **moved to `quant/legacy/`**; the new P1 quant is single-asset.)

### 8.1 The PARTIAL risk (roadmap)

A PARTIAL position posts collateral `c < MaxIL` and the pool's own buffer absorbs the tail `(IL − c)⁺`. Economically the pool is then **short deep-OTM puts on the IL of a correlated single-pair book** — premium income in calm regimes, principal at risk in correlated crashes (positions clustered at the same edge all hit MaxIL together). The whole safety stack (convex floor, progressive leverage tax, circuit breakers, Dutch-auction forced early settlement, first-loss, exposure caps) exists to bound that tail and is **roadmap** — design preserved in `quant/legacy/`, all constants from `params.json`.

### 8.2 Senior / junior tranching (concept; roadmap)

A single-pair unhedged pool is intrinsically a **high-variance mono-factor vol seller — no engineering makes a vol seller low-risk.** The honest depositor-viability answer is to let each depositor pick a risk dose:

- **Senior tranche** — hedged, base yield + a small slice of the load, low tail. A "convexity savings account."
- **Junior tranche** — unhedged, **first loss**, captures most of the load, high APY. The pure vol-selling tranche.

The cut point between them is sized by the quant (the old PARTIAL waterfall machinery is reused for this — §9). Concept in spec; ROADMAP.

### 8.3 Pool-level partial hedge (concept; roadmap)

The pool buys back a **fraction of its aggregate tail convexity** (a long-option strip / long Panoptic position). This is the **only** lever that changes the **nature** of the risk (it can roughly halve the worst month) — at the cost of APY. The optimal hedge fraction is a quant output (§9). The hedge is **APPROXIMATE** (perpetual vs fixed-maturity gamma) and is **explicitly NOT relied on for solvency** — the FULL guarantee never depends on it. Concept in spec; ROADMAP.

---

## 9. The Quantitative Model

_(vNEXT: the method (jumpy/correlated underlying + waterfall + stress) and the "derived, not guessed" framing stay, but the deliverables now include the cvAMM/FairValue primitives, all **single-asset** calibrated. The cross-asset correlation `k ≈ 1.0` is **dead** for a single-pair book. The new cvAMM params block is **documented this turn in a NEW schema file** (`quant/params.cvamm.schema.json`); `params.json`/`params.py` are **not edited this turn** (pydantic `extra='forbid'` + a roundtrip test gate them). Old multi-asset PARTIAL outputs move to `quant/legacy/`.)_

A standalone, parallelizable deliverable (`quant/`) that **derives every cvAMM and PARTIAL parameter** and doubles as a flagship pitch artifact ("we did not guess our risk parameters — we derived them from Monte Carlo under fat-tailed, single-pair vol regimes, anchored to Lipton–Lucic–Sepp 2025 and Singh et al. AFT 2025").

**Method:**

1. **Risk-neutral pricing engine.** Drift-free GBM (`mu = 0`) Monte Carlo over the specific geometry computes `fairRate = E_Q[min(IL, MaxIL)]/MaxIL` per `(width × distance-to-edge × duration)`. Real-measure crash sims (jump-diffusion / bootstrap / common factor) are reserved for the real-world tail deliverables (tranche cut, pool-hedge fraction), not for the risk-neutral fair value.
2. **Paths → IL** via the §3 formulas, swept over the launch geometry grid (the 9 ETH/USDC marketIds × a width × distance-to-edge grid).
3. **Diversification analysis.** Lone-writer CVaR95 (~91–100% of MaxIL → the overcharge gap of 9–73 pts that justifies `baseLoad`) collapsing to ~78.7% per-contract as N: 1→100.
4. **Stress** (real measure): single-pair vol-regime shift, utilization spike, edge-clustering — for the tail levers only.

### 9.1 Open quantitative questions — the 10 cvAMM deliverables (single-asset, P1)

All single-asset; none inherits the dead cross-asset `k`. All feed the **new cvAMM params schema** (`quant/params.cvamm.schema.json`), not the frozen `params.json` this turn.

1. **`fairRate` S-curve** — `E_Q[min(IL,MaxIL)]/MaxIL` surface in `σ²·T` for the specific geometry; calibrated to the il.py MC and the two theory anchors.
2. **`σ_ref` estimator** — `σ_short`/`σ_long` EWMA windows, the floor, sampling cadence (with the mandatory never-raw-realized caveat).
3. **`baseLoad`** — sized from the lone-writer-CVaR-vs-diversified-pool overcharge gap.
4. **`util_skew(locked/(locked+free))`** curve shape — single-asset.
5. **`dispersion_skew`** curve shape — single-asset (the honest concentration analogue).
6. **`maxLoadBps`** — the I10 clamp ceiling; `baseLoad + util_skew + dispersion_skew ≤ maxLoad` by construction; applies to both paths, upstream of settle.
7. **Safe routable idle fraction** — productive-collateral cap (compliant form only — §7.4; Aave-for-locked is BLOCKED).
8. **Optimal pool-hedge fraction** — the tail lever (§8.3), from real-measure crash sims.
9. **Senior/junior cut point** — the tranche boundary (§8.2), from the (legacy) waterfall + `var_cvar`.
10. **Single-asset depositor loss distribution** — the placeholder-replacing numbers for the §7.5 disclosure (re-uses legacy `var_cvar`/`ruin_probability`). Until produced, all depositor numbers are PLACEHOLDER and the multi-asset figures are not reused.

**Outputs feed the build:** the documented cvAMM params schema (this turn), then a future `params.json` schema bump (minor, per the module's semver note) consumed by deploy scripts and contract constructors, plus charts (the `fairRate` S-curve, the overcharge gap, the depositor loss distribution) for the deck and `docs.inflexion.xyz`.

---

## 10. Economic Viability — The Levers

_(vNEXT: reframed around the hybrid. Adds the two load-bearing reasons MMs matter and the floor/ceiling framing. Cross-links to the Inefficiency Ledger, §10.1.)_

This section is honest about the binding constraint and shows we know how to attack it.

**The binding constraint:** premium must exceed `E[loss]` for the underwriter, but a rational LP only pays up to `E[loss] + their risk aversion`. The market exists only where the buyer is more risk-averse than the seller, or the seller bears the risk more cheaply. Where the surplus comes from:

- **Risk-aversion gradient (real).** Retail LPs _hate_ IL — a salient, regret-laden loss; underwriters are diversified and ~risk-neutral. The LP buys certainty. Genuine surplus.
- **Diversification.** One LP's IL is high-variance; a basket is far lower-variance until correlation hits → the pooled cvAMM prices closer to `E[IL]` (the overcharge gap, §9). This is the cvAMM's core efficiency.
- **Hedging (decides liquidity).** If MMs cheaply hedge short gamma (perps, Deribit, Panoptic), they charge hedging cost + thin spread, not a fat uncertainty premium. **Better MM hedging tooling → tighter quotes → LP demand.** European is far more hedgeable than American — another reason it is the default.
- **Basis harvesting (the flywheel).** If LP convexity trades rich to Deribit IV, vol-arb desks _want_ to sell coverage to capture the basis → sophisticated supply that prices tight. The data surface (§12) surfaces the basis.

**Why MMs matter in the hybrid (two load-bearing reasons — vNEXT).**

1. **Hedged MMs export short-gamma risk OUT of the system** to the global options market (Deribit/Panoptic). A closed pool cannot — without them the protocol is a **closed pocket of ETH short-gamma circulating against itself**. MMs who hedge shrink the system's total risk; the pool alone only relocates it.
2. **Forward-looking-vol MMs correct the pool's structural backward-looking bias.** The pool prices off realized `σ_ref`; MMs price off implied/forward vol. They incorporate the forward information the backward-looking pool structurally cannot.

**Floor + ceiling.** The cvAMM is the **floor of liquidity** (always quotes a code-capped price); the MMs are the **ceiling of price** (win only by beating it). `createSwap` routes to the cheaper of the two.

**Capital efficiency for underwriters:**

- **Yield on idle collateral** (§7.2, §7.4) — idle capital earns while not locked → lower required premium → more demand. Compliant form only.
- **PARTIAL leverage dial** (§8) — frees capital directly (at the cost of tail risk), roadmap.

**Target the price-inelastic customer.** Yield-chasing retail is the worst customer (elastic). The best are **DAOs / protocol treasuries running protocol-owned liquidity**, who need predictable, reportable P&L and pay for certainty. This reframes Inflexion as **treasury risk management for on-chain institutions** — the organic bridge to the program's RWA/institutional theme.

**Rebates — essential or dangerous? Both, about different markets.** In an _underwriting_ market they subsidize **risk-taking**, not liquidity: a mercenary MM farming rebates sells underpriced insurance and the pool eats the tail. Reconciliation: **incentivize capital _uptime/solvency_, not _volume_**; if used, **FULL-only** and **vested**. For the hackathon: implement no rebates, but articulate exactly this.

### 10.1 Inefficiency Ledger (vNEXT — new; honest economic self-assessment)

- **Inefficiency 1 — risk "merely moved": RESOLVED / void.** Geometry is public (no asymmetry, §3.4), and transferring risk to the cheapest pricer **is** an efficient market. Optional refinement (roadmap): make the skew sensitive to the book's **net hedgedness** (reward hedged MMs who export risk over fresh MMs who only relocate it).
- **Inefficiency 2 — rebalancing latency: ACCEPTED.** Self-resolves with protocol attractiveness / MM presence.
- **Inefficiency 3 — depositor viability: THE central challenge.** Addressed by the **combination** of productive collateral (compliant) + load-as-true-vol-premium + pool tail-hedge + senior/junior tranches. **None makes a vol seller safe (impossible); together they make it honest and viable for two audiences.**
- **Inefficiency 4 — backward-looking σ: calibrated, residual left as MM alpha.** Calibrate the on-chain estimator to the **frontier of public info** (`σ_short`/`σ_long` blend + floor + known-event calendar) and **deliberately leave the residual forward-looking premium as MM alpha** — that residual blindness **is** the incentive that keeps MMs in the two-sided market (a feature, not a bug).

---

## 11. Underwriter Hedging & the SDK (`@inflexion/sdk`)

_(vNEXT: the SDK becomes **convexity-aware** — adds READ-ONLY `bookGamma`/`bookVega`/`replicationStrip`/`suggestGammaHedge` mirroring the existing informational delta helpers; adds a cvAMM **depositor** surface; `getLPStructuralIV` is renamed to the convexity-premium index (F-#12); Panoptic execution is ROADMAP only and explicitly not-for-solvency.)_

The SDK is demand-side critical: it is how MMs price, stream, and **hedge**, how cvAMM depositors interact with the pool, and tighter underwriter books are what create LP liquidity (§10).

### 11.1 LP surface (simple)

```ts
previewSwap(tokenId, duration) → { V0, maxIL, maxILRatioBps, fairPremium, poolPremium, bestMMQuote, premium, premiumPct, expiry, path }
createSwap({ tokenId, duration, maxPremiumUSDC, slippageBps }) // routes to cheaper of {pool, MM}; approves NFT + USDC
claimFees(swapId)
getActiveSwaps(lp) ; getPositionSummary(swapId)  // δ, fees vs premium, IL-to-date
```

> `previewSwap` now surfaces the **on-chain `fairPremium`**, the **pool premium**, and the **best MM quote**, and tells the LP which path is cheaper.

### 11.2 MM surface (the cockpit)

```ts
depositCapital(amount)
withdrawCapital(amount)
// Streaming quote client — connects to the engine, pushes/cancels signed quotes (Path B)
quoter.stream({ market, loadBps, band, model, capacity, validitySecs }) // loadBps over on-chain FairPremium (≤ maxLoadBps)
quoter.cancel(market)
quoter.requoteLoop(modelFn) // re-price on a tick from the MM's own model
// Risk — per-position and PORTFOLIO Greeks (read-only)
risk.bookDelta()
risk.bookGamma()
risk.bookVega()
risk.exposureByMarket()
// Hedging helpers (read-only at launch)
hedge.suggestDeltaHedge() // size/venue to flatten net delta (GMX/Hyperliquid perps)
hedge.suggestGammaHedge() // vNEXT: read-only gamma-hedge suggestion (long-option strip)
hedge.replicationStrip() // vNEXT: the Lipton–Lucic–Sepp static-replication strip for the book
hedge.markToMarket() // live P&L, ROC, implied-vs-realized variance
// hedge.executeOnPanoptic(...) // ROADMAP only — Panoptic CollateralTracker + PanopticPool.mintOptions(tokenId);
//                                 APPROXIMATE (perpetual vs fixed-maturity gamma); EXPLICITLY NOT relied on for solvency
```

For the hack: ship the SDK + an **example MM bot** (`examples/mm-bot.ts`) that streams quotes and prints net book delta/gamma — this is the **single real MM** we run live in the demo to populate Path B (no fake book).

### 11.3 cvAMM depositor surface (vNEXT — new)

```ts
vault.deposit(usdc) // → ERC-4626 shares
vault.withdraw(shares) // subject to the withdrawal delay / queue
vault.nav() // net asset value per share
vault.lockedFree() // locked vs free accounting (drives util_skew + the run defense)
vault.skewState(marketId) // current util_skew / dispersion_skew inputs
```

The depositor surface must carry the **CAPITAL-NOT-GUARANTEED** disclosure (§7.5) at every entry point.

### 11.4 Data-consumer surface

```ts
getConvexityPremiumIndex(market) // vNEXT: renamed from getLPStructuralIV (F-#12) — observed clearing load over σ_ref
getRiskAppetiteIndex(market)
getConvexityDepth(market)
```

---

## 12. The Data Surfaces — The Moat

_(vNEXT: Surface 1 is reframed. The protocol now **publishes** the on-chain clearing load over a **transparent `σ_ref`**, so Surface 1 becomes "observed clearing load over a transparent `σ_ref`" rather than "back-solved `σ_LP` from an opaque rate." Surfaces 2–3 and the moat-not-paywall framing stay.)_

The flow is a byproduct that is itself a product. Built passively from day one; exposed as free public APIs (The Graph + REST). Revenue is protocol fees; **data is the moat, not a paywall.**

```
SURFACE 1 — LP Convexity-Premium Index   (vNEXT — observed clearing load over a transparent σ_ref)
  Source  : the on-chain clearing premium per (market × geometry) AND the published FairPremium / σ_ref
  Primary : publish the OBSERVED CLEARING LOAD = premium / FairPremium − 1 over the transparent on-chain σ_ref.
            Because σ_ref is published on-chain (§6.5), this is a well-defined, transparent quantity — NOT a
            back-solved, non-identifiable σ_LP. (Replaces the v3.3 "back-solved σ_LP from an opaque rate" framing.)
  Caveat  : the load is still CONTAMINATED by liquidity / SC-risk / capital-lock / inventory-skew premia.
            Trade the SPREAD (load vs implied/forward vol), not the level.
  Buyers  : quant funds, vol-arb desks, options-protocol integrations

SURFACE 2 — DeFi Convexity Risk-Appetite Index
  Source : engine + on-chain flow metadata, not just prices
  Signals: pool util_skew/dispersion_skew state; FULL/PARTIAL split (when PARTIAL ships); MM-vs-pool win rate
           (forward-vs-backward vol gap); ratio-band migration; vault inflow/NAV rate (retail tail pricing)
  Meaning: real-time DeFi vol-regime indicator (a VIX-like signal for LP markets)
  Buyers : macro funds, DeFi risk desks, structured-product issuers

SURFACE 3 — Convexity Supply Book
  Source : outstanding pool capacity + streamed MM capacity across markets/bands
  Meaning: where capital will sell gamma, at what price, what width, what duration
  Buyers : Nansen / DefiLlama / Kaiko / Dune, protocol treasuries, academics
```

Honest limits to put in the docs: the clearing load is **contaminated** (liquidity + SC risk premium + capital lock cost + inventory skew) — compare the spread, not the level; the signal is **reflexive** as the protocol scales (normal for any derivative market); calibration lags at launch (no historical realized-IL dataset — _the protocol is the mechanism that creates it; that is the data moat_).

---

## 13. Contract Architecture & Stack

_(vNEXT: `FairValueOracle`, `VolOracle`, and `ConvexityVault` are added to the architecture. The ILMath "~10× cheaper" claim is **corrected** to the measured reality (Task 2.12: ~5.3× MORE expensive cached for this small kernel). Invariants **I1–I9 are KEEP verbatim** (settle-path, untouched). New invariant **I10** is added — by construction, upstream of settle, does not touch settle/MaxIL/I1–I9.)_

```
ILMath (Stylus/Rust)   computeMaxIL, computeIL — pure fixed-point math; Arbitrum-native. Reference impl.
                       (vNEXT: the v3.3 "~10x cheaper than Solidity" claim is WRONG — Task 2.12 measured Stylus at
                       ~5.3x MORE expensive cached for this small kernel; see docs/MATH.md §7. Stylus is kept as the
                       production IL impl for its math fidelity / future kernel growth, not a current gas win.)
VolOracle.sol          (vNEXT NEW) σ_ref = max(σ_short, σ_long, floor), EWMA of Chainlink-tick log-returns (§6.5)
FairValueOracle.sol    (vNEXT NEW) FairPremium = fairRate·MaxIL; fairRate S-curve in σ²·T for the specific geometry (Pillar 1)
OracleManager.sol      Chainlink + sequencer + TWAP deviation; getPrice (entry) / getSettlementPrice (settle)
ConvexityVault.sol     (vNEXT NEW) ERC-4626 USDC cvAMM pool (Path A); one per pair / 9 markets; util+dispersion skews;
                       I10-capped; EIP-1271 owner of collateral; lockCollateral/releaseAndDistribute; locked/free
UnderwriterVault.sol   per-MM pool (deposited/locked/available) — Path B capital; lockCollateral/releaseAndDistribute
ILVault.sol            ERC-721 custody; reads NonfungiblePositionManager; claimFees passthrough
InflexionCore.sol      state machine; Path A (on-chain capped pricing) + Path B (EIP-712/1271 SignedQuote);
                       routes to cheaper; enforces I1–I10; CEI settlement
GreekDisplay.sol       read-only δ/γ/ν/θ + convexity-premium index + 3 surfaces (zero funds, zero state)
— Roadmap (PARTIAL leverage dial) —
LiquidationManager.sol Dutch-auction forced early settlement; Chainlink Automation target (PARTIAL only)

Interfaces: IILMath, IPositionManager, ICollateralModel, ISettlementModule, IYieldAdapter,
            IFairValueOracle, IVolOracle   (scalability seams)
```

Key Arbitrum One addresses: NonfungiblePositionManager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`; v3 Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`; WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`; native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`. (EIP-1271 via OZ `SignatureChecker` and the ERC-4626 base are **already vendored** in `lib/` — no new external dependency.)

```
Repo (pnpm monorepo)
  packages/contracts   Foundry — Solidity + Stylus; test/ (unit, fork, Invariants.t.sol); script/Deploy.s.sol
  packages/engine      off-chain matching relayer (Node/TS) — PATH B ONLY: WS quote intake, ranking, signed-payload API
  packages/sdk         @inflexion/sdk — LP / MM-quoter / cvAMM-depositor / data; examples/{lp-basic, mm-bot, data-consumer}.ts
  packages/subgraph    schema + mappings (Swap, Order, Market, MMStats, ConvexityBand, VaultSnapshot, FairValue)
  packages/api         public REST (Railway/Fly) over the subgraph
  apps/web             React+Vite, wagmi/viem, RainbowKit, Apollo, shadcn/ui, Recharts
  apps/docs            docs.inflexion.xyz (see §14.3)
  quant/               Python (§9) → cvAMM params schema (quant/params.cvamm.schema.json) + quant/SPEC.md; legacy/ = multi-asset PARTIAL
  docs/                README, INTEGRATION, API, SECURITY, MATH
```

Dev: local **Nitro** node (forks Arbitrum mainnet state → real Uniswap v3 + Chainlink, free gas, instant finality) for fork tests; `cargo-stylus` for ILMath. **Foundry invariants to prove** (fuzz prices across the _full_ domain — in-range, below Pa, above Pb, and the no-IL region where `V_lp ≥ V_hold`):

- **I1 — no bad debt (FULL):** `payout ≤ collateral == MaxIL`.
- **I2 — cap correctness:** `payout == min(realized_IL, MaxIL)`.
- **I3 — non-negativity / no underflow:** `payout ≥ 0` and the IL subtraction never underflows. Note: `assert(payout >= 0)` is _vacuously true_ on `uint256` and is not a real test by itself — the meaningful proof is that `realized_IL` is computed as `V_hold > V_lp ? V_hold − V_lp : 0` (never an unchecked `V_hold − V_lp`), and the fuzzer drives `V_lp > V_hold` cases asserting **no revert** and `payout == 0`.
- **I4 — LP never profits from the swap:** `V_lp ≥ V_hold ⟹ realized_IL == 0 ⟹ payout == 0`. The LP is made whole, never more; the swap is a hedge, not a lottery.
- **I5 — vault solvency:** `locked ≤ deposited` per MM (and `locked ≤ deposited` for the pool); `Σ locked` is fully backed by collateral.
- **I6 — liquidity immutability (F-#2):** settlement computes IL with the `L` stored at creation; external `increaseLiquidity` on the custodied NFT cannot raise `payout` above `MaxIL`. Fuzz: mutate on-chain `L` between create and settle, assert `payout` unchanged.
- **I7 — capacity authority (F-#6):** `Σ V0` filled against a quote ≤ its `maxNotionalV0`; a cancelled nonce-bit cannot fill; the same `quoteId` cannot over-consume under concurrent fills.
- **I8 — settlement liveness (Fork 1 fix):** for any swap, `settle()` succeeds by `expiry + LIVENESS_WINDOW + MAX_STALENESS + GRACE_PERIOD` under any price path — the lone-spike check never permanently locks funds. Fuzz: drive arbitrary price paths through `T` (including gaps, spikes, glitches) and assert `settle` eventually succeeds within the bound.
- **I9 — oracle-anchored band enforcement (Fork 2 fix):** `createSwap` reverts iff `absBps(P_live, quote.quotePrice) > quote.priceBandBps`. Fuzz: synthesize stale quotes + arbitrary oracle gaps ⇒ band-exceeding fills always revert; within-band fills always succeed; no stale-quote fill ever exceeds the MM's chosen band. _(Applies to Path B; Path A has no signed quote and prices off the live `FairValueOracle` directly.)_
- **I10 — price cap (vNEXT — new; by construction; upstream of settle):** `premium ≤ FairPremium · (1 + maxLoadBps)` on **both** paths. On Path A this is enforced by the clamp `baseLoad + util_skew + dispersion_skew ≤ maxLoad`; on Path B by `require(loadBps ≤ maxLoadBps)` with premium derived from the on-chain `FairPremium`. **I10 is enforced in `createSwap` pricing (PHASE 1/2), strictly UPSTREAM of `settle` — it does NOT touch `settle`, the MaxIL formula, or I1–I9.** Fuzz: drive `FairPremium`, the skews, and `loadBps` across their ranges and assert the charged premium never exceeds `FairPremium · (1 + maxLoadBps)`.

```solidity
// I3 + I4, stated explicitly (handler fuzzes sqrtP_T over the whole range)
uint256 payout = core.settlePreview(swapId, sqrtP_T);
assertGe(payout, 0);                          // I3 (formal; underflow-safety is the real content)
assertLe(payout, swap.maxIL);                 // I1/I2 upper bound
if (vLp >= vHold) assertEq(payout, 0);        // I4 — LP cannot profit

// I10, stated explicitly (handler fuzzes FairPremium, skews, loadBps in createSwap)
assertLe(charged, fairPremium * (10000 + maxLoadBps) / 10000);   // I10 — never overcharge, by construction
```

---

## 14. UX / UI — Full Website Cartography

_(vNEXT: the landing is **three doors** mapping cleanly to the three actors — LP / cvAMM depositor / MM. The cvAMM depositor door (was "/vault, Phase 2") becomes a **launch** door with the single-asset CAPITAL-NOT-GUARANTEED disclosure. `/protect` shows the on-chain `FairPremium` and the cheaper-of-{pool,MM} routing. `/markets` Surface-1 is relabeled away from "IV" to the convexity-premium / clearing-load.)_

**Design law: progressive disclosure.** The LP sees **one number and one button**; the MM gets a cockpit; the depositor gets a clear risk dose; the curious get docs. Complexity is opt-in, never forced.

### 14.1 `app.inflexion.xyz` (the product)

```
/                Landing. One-line value prop + THREE DOORS (the three actors):
                 "Protect my LP position" (LP)  ·  "Earn in the cvAMM" (depositor)  ·  "Underwrite & compete" (MM)
                 Live stats: total covered, IL paid out, active markets, pool NAV/health.
                 Trust band: "FULL mode: bad debt is mathematically impossible — here's the proof →"

/protect (LP)    1. Connect → auto-detect v3 NFTs (read NonfungiblePositionManager, positions(tokenId))
                 2. Pick a position (shows pair, range, V0, in/out of range)
                 3. Pick duration (7/30/90d) — same MaxIL, three published FairPremiums
                 4. ONE price, plain language, with the on-chain FairPremium + routing:
                    "Fair value $906. You pay $1,042 to cover up to $1,280 for 30 days."
                    secondary: pool vs best-MM (cheaper highlighted), load %, settlement = European
                    [Advanced ▸] FairPremium, σ_ref, load breakdown, model (FULL), raw MaxIL, oracle source
                 5. Confirm → routes to cheaper path → approve NFT + USDC → swap created (toast + dashboard link)

/dashboard (LP)  Active swaps as cards: "Delta: +0.42 ETH — a 1% ETH move ≈ ±$X";
                 "Fees earned $Y vs premium $Z → net cost of protection $(Z−Y)";
                 "IL to date: $W — fully covered" + countdown + Claim fees. Settled: payout, NFT returned.

/vault (LAUNCH)  cvAMM depositor door. Deposit USDC → shares; NAV; locked/free gauge; util_skew/dispersion_skew state;
                 historical load earned vs claims paid; withdrawal queue/cooldown;
                 PROMINENT single-asset risk disclosure modal (§7.5): "CAPITAL IS NOT GUARANTEED — this is a
                 vol-selling product." (Numbers PLACEHOLDER pending P1 quant.)

/underwrite (MM) Cockpit (power users): deposit/withdraw capital (available/locked gauge);
                 quoting panel (per market: loadBps over FairPremium, band, capacity, validity) with live book preview;
                 portfolio Greeks (net δ/γ/vega), replication strip, exposure by market, ROC, P&L,
                 implied-vs-realized variance; gamma/delta hedge suggestions; CapitalLow alerts.
                 (Roadmap: PARTIAL leverage controls, first-loss/junior stake, liquidation feed.)

/markets         The 3 surfaces, visualized (Recharts):
                 Surface 1 = convexity-premium / clearing-load over σ_ref (NOT "IV"); risk-appetite regime gauge +
                 time series; convexity-supply depth per market. "Free public data — consume via API →"
```

### 14.2 Demo-critical UI touches

- A **regime/price ticker** showing the (demo) oracle price so the audience _sees_ IL move.
- The **always-on pool quote** plus a **single live MM bot quote** updating in `/markets` and `/protect` as we move price/vol → proves the hybrid (pool floor + MM ceiling, cheaper-of routing).
- A **settlement animation**: at expiry, "LP made whole · counterparty paid residual · NFT returned" with tx links.

### 14.3 `docs.inflexion.xyz` (crucial — five audiences)

The protocol is sophisticated; docs are how non-finance people _get it_ and how pros automate. Built with a docs framework (Mintlify/Docusaurus), MDX, embedded diagrams.

```
1. "What is impermanent loss?"  (zero-knowledge reader)
   Visual, plain-language: "If you'd just held, you'd have more — that gap is IL."
   Interactive slider (move price → watch IL), analogy, glossary, FAQ. No jargon, no math.

2. LP guide        manual flow + SDK one-liner; what's covered / the MaxIL cap; the on-chain FairPremium + routing.
3. MM guide        run a quoting bot; the SDK quoter + delta AND gamma hedging + replication strip;
                   why MMs matter (export risk + forward vol); "uptime, not volume".
4. Data / API      REST + GraphQL + SDK reference; the 3 surfaces; the contamination caveats; curl + TS examples.
5. Protocol / security  math derivation (§3), the no-bad-debt proof + the not-Bancor argument, the cap,
                   FairValue + σ_ref oracle (load-bearing scope), the I10 cap, the trust model (§4.5),
                   the quant model (§9) with charts, the Inefficiency Ledger, invariants I1–I10, attack vectors,
                   and the cvAMM depositor disclosure (CAPITAL NOT GUARANTEED).
```

---

## 15. Testnet Demo Plan (Arbitrum Sepolia)

_(vNEXT: the cvAMM always-on quote (Path A) is the headline that removes cold-start; **do NOT seed a fake MM book** — a SINGLE real MM plugs in to demo Path-B competition. The demo-oracle adapter and seconds-scale durations stay; the new `FairValueOracle`/`VolOracle`/`ConvexityVault` are in the demo deploy.)_

**The hard problem:** real expiries are 7–90 days; a demo is 3 minutes. Solve it with a **demo deployment** that compresses time and controls price, _without_ faking the trust story.

### 15.1 Pre-seed (before the pitch)

- Deploy ILMath (Stylus) + `OracleManager` + `VolOracle` + `FairValueOracle` + `ConvexityVault` + all launch contracts to Arbitrum Sepolia; verify; record addresses.
- **Configurable durations** (allow seconds-scale, e.g. 120s) on the demo deployment only.
- **Demo oracle adapter**: an `OracleManager` mode where an operator key can set the price (still routed through the same health checks), so we can drive IL deterministically; the `VolOracle` likewise seeded with a demo σ. Mainnet uses pure Chainlink.
- **Seed the cvAMM**: deposit demo USDC into `ConvexityVault` so it can underwrite — it **always quotes** (no cold start, no fake book).
- Mint 2–3 real Uniswap v3 ETH/USDC NFTs on Sepolia (tight + wide ranges) into demo LP wallets.
- Run **ONE real MM bot** streaming signed quotes (Path B) so we can show a genuine undercut of the pool. **No multi-bot fake book.**
- Pre-create one swap **already near expiry** so we can settle within seconds on stage.
- Subgraph + REST + frontend pointed at Sepolia; faucets topped up (Sepolia ETH + Circle USDC).

### 15.2 Live sequence (~3 min, maximum features, minimum clicks)

1. `/markets` — the pool quoting **always-on** across the 9 markets; move demo vol → the published `FairPremium` and pool price reprice in real time (proves on-chain fair value + the data surface).
2. `/protect` — LP picks a real NFT → instant pool price ("Fair value $X, pay $Y, cover up to $Z") → the single MM bot **undercuts** → LP routed to the cheaper one → confirm. (Pool floor + MM ceiling, cheaper-of routing.)
3. `/dashboard` — δ shown, IL = $0, fees-vs-premium line.
4. Operator moves demo price → IL accrues → dashboard + Surface-1 update live.
5. Settle the **near-expiry** pre-seeded swap → LP made whole, counterparty residual, NFT returned, tx links. **Trustless.**
6. `/vault` — show pool NAV, locked/free, the skew state move, and the CAPITAL-NOT-GUARANTEED disclosure.
7. Close on `/markets`: "every trade fed these three surfaces — the first on-chain LP convexity-premium data, priced on-chain."

### 15.3 Risk management for the demo

- Everything scriptable + idempotent (one command reseeds).
- **Recorded fallback video** of the full flow in case Sepolia RPC/sequencer flakes on stage.
- Pin RPCs; pre-fund all gas; dry-run the exact click path twice.

---

## 16. Demo Pitch (technical + non-technical judges)

_(vNEXT: leads with **first to price IL risk on-chain** + the cvAMM always-on pooled underwriter; MM competition is the ceiling-of-price rail, not the sole liquidity source. The Stylus "~10× gas" claim is corrected. The honesty slide folds in the Inefficiency Ledger + the not-Bancor + capital-not-guaranteed framing. Q&A adds cold-start → cvAMM-always-quotes.)_

### 16.1 The 30-second hook (anyone)

_"If you've ever provided liquidity on Uniswap and ended up with less than if you'd just held — that's impermanent loss. It costs LPs over a billion dollars a year and there's no trustless way to hedge it. We built the first market that prices that risk on-chain: a pooled underwriter always quotes you a fair, code-capped price, market makers compete to beat it, and if your position suffers impermanent loss within its range you're paid back — from pre-locked collateral, with no middleman who can run off with the money."_

### 16.2 The intuitive mechanism (the picture)

- **A fair price, published on-chain.** For any position we compute the worst-case in-range loss — **MaxIL** — and the **fair premium** to cover it, on-chain. The pooled cvAMM always quotes off that fair value, capped in code so it can never overcharge.
- **Competition on top, not instead.** Market makers can undercut the pool when they have a real edge (a cheaper hedge, a forward vol view). You always get the cheaper of {pool, MM}.
- **The collateral is the genius.** The counterparty locks exactly MaxIL. So in our main mode **the protocol literally cannot owe more than it holds — bad debt is mathematically impossible.** (Show the one-line invariant I1.)
- **Honest scope.** It covers IL up to the worst case _within your range_; beyond-range divergence is directional, not impermanent. We show every LP their payoff diagram and call it an _in-range convexity hedge_.
- **The payoff is one number.** The LP never sees Greeks unless they want to.

### 16.3 The technical depth (for technical judges)

- **On-chain published fair value** (`FairPremium = fairRate·MaxIL`), theory-anchored (Lipton–Lucic–Sepp 2025; Singh et al. AFT 2025) — the first on-chain price for LP IL risk.
- **The cvAMM**: a pooled ERC-4626 underwriter that prices algorithmically and is **contractually capped by invariant I10** (`premium ≤ FairPremium·(1+maxLoad)`, by construction) — overcharge is impossible by code.
- MaxIL as the **collateral unit** (range-agnostic ROC → no adverse selection) with the **`min(IL, MaxIL)` cap** that makes the no-bad-debt claim a _construction_, not a hope.
- **Hybrid settlement**: signature-free on-chain pool (Path A) + EIP-712/1271 signed-quote MM rail (Path B) into one non-custodial settlement core — the matcher can't steal, forge, or force a stale quote, and Path A needs no matcher at all.
- **Stylus/Rust** IL math (Arbitrum-native). _(Honest note: for this small kernel Stylus measured ~5.3× more expensive cached than Solidity — we keep it for math fidelity and future kernel growth, not as a current gas win.)_
- **The quant model**: cvAMM and PARTIAL parameters _derived_ from single-asset Monte Carlo — not guessed.

### 16.4 The moat (why it compounds)

_"Every trade emits data that doesn't exist anywhere today: the first on-chain LP convexity-premium index (observed clearing load over a transparent on-chain σ), a DeFi risk-appetite index, and a convexity-supply book. Free public API from day one. We own the dataset because we create it."_

### 16.5 The honesty slide (wins technical credibility)

_"The hard part is depositor viability — a single-pair vol seller is intrinsically high-variance and no engineering makes it safe; together (true-vol-premium load + pool tail-hedge + senior/junior tranches + compliant idle yield) we make it honest and viable. We are explicit: this is NOT Bancor — we pay in pre-locked USDC and mint nothing; in FULL the pool cannot be insolvent and cannot be run, but depositor capital is NOT guaranteed. Two separate claims, never merged: LPs are always paid (I1); depositors can lose principal in a crash. FULL is live and provably safe today; PARTIAL ships only when the model says it's safe. Here is our Inefficiency Ledger — four inefficiencies, stated with their resolution status."_

### 16.6 Tough Q&A (rehearse)

- _"No MMs at launch / cold start?"_ The cvAMM **always quotes** a code-capped fair price — there is no cold start. One real MM demonstrates competition; more tighten the spread.
- _"Isn't this just Bancor / mutualized insurance?"_ No — pre-locked USDC, mints nothing; FULL cannot be insolvent and cannot be run; capital-not-guaranteed is stated, not hidden.
- _"Is the convexity-premium index comparable to Deribit IV?"_ No — structural, contaminated; trade the **spread** over the transparent on-chain σ.
- _"Won't reflexivity corrupt the signal?"_ Every derivative market is reflexive; it enriches the signal.
- _"Isn't the matcher centralized?"_ Path A is fully on-chain (no matcher); Path B settlement is non-custodial; Orbit-chain decentralizes the book.
- _"Why not Panoptic?"_ Different audience — our LP pays one number; we compute everything else.

---

## 17. Build Roadmap (pointer)

_(vNEXT: this in-spec mirror is replaced by a pointer to ROADMAP.md, the task source of truth, now organized P1→P5. The settlement-core / I1–I9 work below is DONE and untouched.)_

**ROADMAP.md is the single task source of truth.** The build is sequenced **P1 → P5**:

- **P1** — single-asset cvAMM quant (gates every pricing primitive; outputs to `quant/params.cvamm.schema.json`).
- **P2** — `VolOracle` (σ-EWMA) + `FairValueOracle` (on-chain FairPremium), on the shipped `OracleManager`.
- **P3** — `ConvexityVault` (ERC-4626) + Path-A capped `createSwap` + **I10** + Path-B `loadBps` schema + EIP-1271 wiring + cheaper-of routing; on the shipped `UnderwriterVault`/`ILVault`/`InflexionCore`.
- **P4** — engine (Path B, one real MM) / SDK (convexity-aware + depositor) / subgraph / API / frontend (three doors).
- **P5** — spec finalization (this document) + roadmap retag (deprioritize the never-built multi-MM RFQ items) + move multi-asset PARTIAL quant to `quant/legacy/`.

**Already built and verified (settle-path baseline, untouched):** `ILMath` (Sol + Stylus), `OracleManager`, `UnderwriterVault`, `ILVault`, `NoOpYieldAdapter`, `InflexionCore` (`createSwap`/`settle`, EIP-712, bitmap nonces, I9 band, I1–I9 tested), `TickMath`. **Time is not the constraint — order for correctness.**

---

## 18. Roadmap V1.5+ (enums/interfaces must accommodate; not built)

_(vNEXT: existing items stay; the new hybrid roadmap items are appended.)_

- **`ASIAN` settlement** (TWAP-averaged payoff) — lower variance → cheaper premium → more LP demand, smoother to hedge. Strongest near-term add.
- **`AMERICAN`** early exercise — most general, hardest to price/hedge; keep as an option, not a headline.
- **Secondary liquidity & exits (F-#11):** novation; the writer side as a transferable "protection-writer" ERC-721; LP early-termination by forfeiting unused premium. The European/locked design currently gives neither side an exit.
- Yield-on-collateral live adapters (idle-only, instantly-redeemable — sDAI / tokenized T-bills); ifUSDC composability.
- Greek-decomposition tokens (δ/γ/θ/ν), correlation/dispersion swaps, LP-CDO tranching, v4-hook barrier/variance swaps, the ULREX unified data layer.
- **vNEXT hybrid roadmap:** **BTC/USDC + multi-pair**; **cross-asset concentration skew** (when multi-pair exists); the **PARTIAL leverage dial** (§8); **senior/junior tranches** (§8.2); **productive-collateral integration** (idle-only, compliant — §7.4; Aave-for-locked BLOCKED); **pool-level partial hedge** execution (§8.3); **Panoptic hedge SDK** execution (read-only convexity analytics at launch — §11; APPROXIMATE, not-for-solvency).

---

## 19. Open Questions (non-blocking)

_(vNEXT: existing entries stay; an "Open quantitative questions (cvAMM, single-asset, P1)" block is added.)_

- **Resolved this round (audit):** out-of-range positions are **rejected at creation** (`Pa ≤ P0 ≤ Pb`, F-#2/#3); entry semantics pinned to the creation snapshot (§3.1); _what_ is hedged = gross in-range IL, not net P&L (§5.3).
- **Resolved this round (vNEXT):** geometry information asymmetry is **void** — v3 params are public on-chain, both paths price the specific position (§3.4).
- Uniswap fees during custody: LP-only (current) vs LP/MM split — affects underwriter incentive; V1.5.
- **One swap per NFT at a time** (the NFT is custodied by the first swap); overlapping swaps on one NFT are out of hack scope.
- **Non-USD-quoted pairs** (e.g. WBTC/ETH): settlement price = `tokenA/USD ÷ tokenB/USD`, requiring _both_ feeds healthy. Launch ships USD-quoted pairs only.
- **Collateral asset = native USDC**; a USDC depeg is a shared, disclosed systemic risk (premium and payout are both USDC). Reject non-standard ERC-20s via a token whitelist.
- Batch swaps; governance for parameter updates — post-hack.
- Exact `IYieldAdapter` venue and the % of _idle_ collateral safe to route (locked collateral is never routed to utilization venues — §7.2/§7.4, F-#3).

### 19.1 Open quantitative questions (cvAMM, single-asset, P1 — vNEXT)

All single-asset; all feed `quant/params.cvamm.schema.json`; none inherits the dead cross-asset `k`. (Mirrors the 10 deliverables, §9.1.)

- `σ_short` / `σ_long` EWMA window calibration + floor + cadence (with the never-raw-realized caveat).
- `baseLoad` / `maxLoad` sizing from the lone-writer-CVaR-vs-diversified overcharge gap.
- `util_skew` / `dispersion_skew` curve shapes on a single-asset book.
- The `fairRate` S-curve coefficients (calibrated to il.py MC + the two theory anchors).
- Diversification CVaR collapse target N (per-contract CVaR 100% → ~78.7% as N: 1→100).
- Senior/junior cut point; optimal pool-hedge fraction.
- Safe routable idle fraction (compliant productive collateral; Aave-for-locked BLOCKED).
- Single-asset depositor loss distribution (placeholder-replacing numbers for §7.5).

---

_Spec v4.0 — hackathon build doc (the hybrid pivot). The first market for Uniswap v3 IL risk, and the first to price it on-chain. Three pillars: (1) on-chain published FairValue (`FairPremium = fairRate·MaxIL`, theory-anchored to Lipton–Lucic–Sepp 2025 + Singh et al. AFT 2025); (2) the cvAMM — a pooled ERC-4626 passive underwriter (Path A) that quotes algorithmically on-chain off FairPremium with util/dispersion skews, capped by invariant I10; (3) the retained MM competition rail (Path B, EIP-712/1271 signed quotes — floor-of-liquidity + ceiling-of-price). One vault per pair / 9 markets, fungible capital. FULL (default, leverage 1, no bad debt) vs PARTIAL (leverage dial, roadmap). σ_ref = max(σ_short, σ_long, floor), EWMA of Chainlink ticks — load-bearing for the I10 cap + depositor solvency, NOT for the FULL no-bad-debt invariant (which stays structural and oracle-independent). Not Bancor; capital NOT guaranteed; LPs always paid (I1). coverage = min(IL, MaxIL); progressive-disclosure three-door UX; Stylus ILMath; scalable enums/interfaces for ASIAN/AMERICAN/PARTIAL._

---

### Changelog

_v4.0 — THE HYBRID PIVOT (this revision)._ Reorganized the protocol around **three pillars** (§3.0): on-chain published FairValue (`FairValueOracle`, §3.0/§3.3/§13), the cvAMM pooled underwriter (`ConvexityVault`, ERC-4626, §7.3), and the retained MM competition rail (Path B). **Architecture:** two parallel paths into one untouched settlement core — Path A (cvAMM, on-chain, signature-free, default) + Path B (MM signed quotes, parallel, optional); `createSwap` routes to the cheaper of {pool, best MM quote} (§4.0). **New on-chain components:** `VolOracle` (`σ_ref = max(σ_short, σ_long, floor)`, EWMA of Chainlink ticks, mandatory never-raw-realized caveat, §6.5) and `FairValueOracle` (`FairPremium = fairRate·MaxIL`, §3.3) — both **load-bearing for the I10 cap + depositor solvency, NOT for the FULL no-bad-debt invariant**, which stays structural and oracle-independent. **New pricing:** `premium = FairPremium·(1+baseLoad+util_skew+dispersion_skew)`, hard-capped by **new invariant I10** (`premium ≤ FairPremium·(1+maxLoad)`, by construction, **upstream of settle**, does NOT touch settle/MaxIL/I1–I9, §13). **Two new single-asset-calibrated skews** (util + dispersion, §3.5). **No geometry asymmetry** — v3 params are public, both paths price the specific position; §3.4 rewritten and the F-#9 caveat retired; Surface 1 reframed to observed clearing load over a transparent `σ_ref` (§12). **Capital:** one `ConvexityVault` per pair backing 9 marketIds with fungible capital; FULL vs PARTIAL is a **leverage dial on one pool**, not two pools (§8); senior/junior tranching (§8.2) and pool-level partial hedge (§8.3) added as roadmap concepts; the **not-Bancor argument** and the **single-asset depositor disclosure (CAPITAL NOT GUARANTEED, placeholder numbers)** stated verbatim (§0, §7.5). **Inefficiency Ledger** added (§10.1). **SDK** made convexity-aware (read-only `bookGamma`/`bookVega`/`replicationStrip`/`suggestGammaHedge`) + a cvAMM depositor surface (§11). **EIP-712/1271 changes stated explicitly (pre-authorized):** `SignedQuote.premiumRateOfMaxIL → loadBps` (premium derived from on-chain FairPremium); verification broadened to OZ `SignatureChecker` for the EIP-1271 vault-signer (§4.3/§4.7). **CLAUDE.md hard-rule flags (encoded, never silently broken):** "Aave for locked collateral" is **BLOCKED** — only the compliant idle-only/instantly-redeemable form is encoded (§7.2/§7.4); no cvAMM/PARTIAL constant is hardcoded — all come from the quant (the new cvAMM block is documented in `quant/params.cvamm.schema.json` this turn; `params.json`/`params.py` untouched, §9). **Doc fixes (sourced from shipped code):** §3.2 MaxIL/V0 table corrected to the `il.py` geometric values (±5% 1.27% / ±10% 2.56% / ±20% 5.23% / ±50% 13.76%; was ~4.2× too low); the ILMath "~10× cheaper" claim corrected to the measured ~5.3× more-expensive-cached reality (Task 2.12, §13/§16.3); `SwapRecord.sqrtP0X96` removed to match shipped code (Task 5.12, §5.1). **Scope:** launch = ONE ETH/USDC pool, 9 marketIds, FULL only; BTC/USDC + multi-pair + PARTIAL + tranches + productive collateral + pool hedge + Panoptic exec are roadmap (§2, §18). **Settlement core, MaxIL formula, and invariants I1–I9 are UNTOUCHED — every change is upstream of settle.**

_v3.3 Fork-2 resolution._ Quote-validity hardening shipped (§4.3.3, Option B): each signed quote carries `quotePrice` + `priceBandBps`; on-chain `createSwap` auto-voids the quote if the live oracle has drifted beyond the band — deterministic, **not last-look**. Kills the dominant stale-quote pickoff vector for bearer-instrument quotes. `validUntil` tightened: default **8s**, band **[5s, 15s]** (was [5s, 60s]). New invariant **I9** (band enforcement).

_v3.2 Fork-1 resolution._ Oracle settlement liveness redesigned (§6.1, Option B with C as Week-1 fallback): price still pinned to the Chainlink round at expiry `T` for fairness, but the hard Uniswap-TWAP gate is replaced by a **Chainlink lone-spike sanity check** + a **24h liveness backstop** that unconditionally accepts `px` after the window — funds can never lock indefinitely (new invariant **I8**). TWAP demoted to an advisory event.

_v3.1 audit pass (external multi-LLM)._ Applied 12 fixes: store `L` and use it at settlement (I6); reject out-of-range entries; ring-fence collateral rehypothecation (idle-only, never utilization-gated); on-chain authoritative quote capacity + replay + Permit2 bitmap-nonce selective cancel (I7); dust/precision floors; reposition as an in-range convexity hedge; Surface 1 reframed as a convexity-premium index; intra-band adverse-selection caveat; direct-to-contract bypass + published quote log; secondary-exit roadmap; gross-IL (not net-P&L) clarification; convexity proof written out.
