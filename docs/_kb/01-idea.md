# 01 — The Idea: Positioning, Narrative & Thesis

> Knowledge-base source material for the public docs (`docs.inflexion.xyz`) and the
> founder's judge Q&A. Domain: the **idea / positioning / narrative**. Every
> technical claim is cited to `file:line`. Framing here is load-bearing — it is what
> the founder says on stage and what a judge reads in the docs, so it must be
> exact, never aspirational, never over-claimed.
>
> Primary sources: `spec.md` §0–§3.0, §10.1, §12, §16 · `README.md` · `CLAUDE.md` ·
> `deployments/arbitrum-sepolia.json` · `apps/docs/market-makers.mdx`.

---

## 1. The one-sentence thesis

**Inflexion is the first market for Uniswap v3 impermanent-loss risk, and the first
to price that risk on-chain.** (`spec.md:14`, `spec.md:3`)

It sells a **European, fixed-maturity, in-range claim** that pays `min(IL, MaxIL)`:
an LP brings a specific Uniswap v3 position (its NFT), picks a duration, pays a
fixed upfront **premium**, and at expiry the protocol pays the LP their realized
IL — **capped at MaxIL** — trustlessly, from pre-locked collateral. (`spec.md:16`)

The precise product label, used everywhere: this is an **in-range convexity
hedge**, *not* unbounded "IL insurance." The cap is load-bearing for the
no-bad-debt guarantee, and mislabeling it as "insurance" is both a demand risk
(sophisticated LPs discount the truncated tail) and a reputational/regulatory one.
(`spec.md:16`, `spec.md:180`, `CLAUDE.md:9`)

### The locked pitch sentence (v4.0)

> "Inflexion is the first market for Uniswap LP convexity priced on-chain — MaxIL
> is the capital unit. A pooled cvAMM always quotes a code-capped fair price with
> dual-tranche structure (junior vol-seller, senior savings account), and competing
> market makers undercut it. The resulting flow is a structural DeFi
> volatility-risk-premium surface for Uniswap LPs — the first on-chain dataset of
> this market's microstructure." (`spec.md:28`)

### The 30-second hook (for anyone)

> "If you've ever provided liquidity on Uniswap and ended up with less than if
> you'd just held — that's impermanent loss. It costs LPs over a billion dollars a
> year and there's no trustless way to hedge it. We built the first market that
> prices that risk on-chain: a pooled underwriter always quotes you a fair,
> code-capped price, market makers compete to beat it, and if your position suffers
> impermanent loss within its range you're paid back — from pre-locked collateral,
> with no middleman who can run off with the money." (`spec.md:1158`)

---

## 2. The PROBLEM

### 2.1 LPs are structurally short gamma

Uniswap v3 LPs carry a **structural short-gamma exposure** — impermanent loss (IL)
— estimated at **>$1B/year of realized losses across DeFi**, with no trustless,
non-inflationary way to hedge it. (`spec.md:14`)

"Short gamma" is the precise framing: an LP's position value is a *concave*
function of price (it loses on both up and down moves relative to holding), so the
LP is implicitly **short an option / short volatility**. IL is the realization of
that short-gamma exposure. This is why the academic anchor is the LVR literature
(§5 below): the AMM's adverse-selection cost is the *theta* of the replicating
short option. (`spec.md:104`, `spec.md:20`)

### 2.2 Why IL has no clean on-chain hedge today

- **No trustless instrument exists.** Existing "IL protection" schemes (Bancor v2.1
  being the canonical example) relied on **token inflation** — minting new tokens to
  cover losses — which is a death-spiral mechanism, not a collateralized hedge.
  Inflexion explicitly is **not Bancor** (§7 below). (`spec.md:26`)
- **Beyond-range IL is unbounded.** Above the upper tick the LP is fully rotated
  into one asset (constant value) while a hold position grows linearly with price,
  so *absolute* IL is unbounded beyond the range. Any product that promised to
  cover unbounded IL could not be fully collateralized — so it could not be
  trustless. (`spec.md:172`)
- **The two-sided market has a cold-start problem.** A purely bilateral
  (LP-vs-MM) market has no liquidity until market makers show up — a classic
  chicken-and-egg. This is the cold-start problem the cvAMM is built to solve
  (§4, Pillar 2). (`spec.md:21`, `spec.md:115`)

### 2.3 The economic binding constraint (stated honestly)

The market exists only where the surplus is real: premium must exceed the
underwriter's `E[loss]`, but a rational LP only pays up to `E[loss] + their risk
aversion`. So the market exists only where **the buyer is more risk-averse than the
seller, or the seller bears the risk more cheaply.** (`spec.md:792`)

Four genuine sources of surplus (`spec.md:794`–`spec.md:797`):
1. **Risk-aversion gradient (real).** Retail LPs *hate* IL — a salient,
   regret-laden loss; underwriters are diversified and ~risk-neutral. The LP buys
   certainty. Genuine surplus.
2. **Diversification.** One LP's IL is high-variance; a basket is far lower-variance
   until correlation hits → the pooled cvAMM prices closer to `E[IL]`.
3. **Hedging (decides liquidity).** If MMs cheaply hedge short gamma (perps,
   Deribit, Panoptic), they charge hedging cost + thin spread, not a fat
   uncertainty premium. Better MM hedging tooling → tighter quotes → LP demand.
4. **Basis harvesting (the flywheel).** If LP convexity trades rich to Deribit IV,
   vol-arb desks *want* to sell coverage to capture the basis → sophisticated supply
   that prices tight.

---

## 3. The SOLUTION (what it actually is)

A **collateralized bilateral derivatives market on Arbitrum One** (live on Arbitrum
Sepolia for the hackathon). The core mechanic, in five parts:

1. **Capped in-range IL transfer.** Coverage payoff is `min(realized_IL, MaxIL)`.
   `MaxIL` is the maximum in-range IL of the *specific* position, computable at
   creation from `(Pa, Pb, L, P0)`, **frozen at creation**, and **identical across
   all three durations.** (`spec.md:48`, `spec.md:97`, `spec.md:169`)
2. **On-chain fair pricing.** The protocol computes and publishes
   `FairPremium = fairRate · MaxIL` on-chain via the `FairValueOracle` (Pillar 1,
   §4). (`spec.md:20`, `spec.md:94`)
3. **Two rails into one settlement core.** Path A = the always-on pooled cvAMM
   (signature-free, on-chain). Path B = competing market makers (EIP-712/1271 signed
   quotes). `createSwapRouted` gives the LP the **cheaper of {pool, best MM quote}**.
   (`spec.md:40`, `spec.md:286`–`spec.md:292`)
4. **Full collateralization (FULL mode, the default).** The counterparty locks
   exactly `MaxIL`. Because `covered_payoff ≤ MaxIL` by construction of the cap and
   `collateral_FULL = MaxIL`, FULL mode **cannot produce bad debt under any price
   path** — a structural invariant (I1), provable by Foundry invariant tests.
   (`spec.md:178`)
5. **Non-custodial on-chain settlement.** At expiry, `settle()` reads the Chainlink
   round pinned at expiry `T`, computes realized IL using the `L` stored at creation,
   pays the LP `min(realized_IL, MaxIL)` from the counterparty's locked collateral,
   returns the residual to the counterparty, and returns the NFT to the LP.
   (`spec.md:543`–`spec.md:554`)

### Entry requires the position to be in range

`Pa ≤ P0 ≤ Pb` is **enforced at creation** — out-of-range entries are rejected.
This is both a correctness requirement (the convexity proof and the MaxIL cap only
hold in range) and a product-honesty requirement (the product hedges *in-range* IL).
(`CLAUDE.md:84`, `spec.md:467`, `spec.md:469`)

### What is hedged (precise)

The product hedges **gross in-range IL accruing from creation onward**, *not* the
LP's net P&L. Entry quantities (`P0`, `amount0_entry`, `amount1_entry`, `L`) are
snapshotted **at swap creation, not at the LP's original mint** — any IL the LP
already bore before covering stays theirs. The LP also keeps Uniswap fee accrual
during custody, so total LP outcome = `fees − IL + payout − premium`, which *can*
be positive. That is correct, not a leak: invariant I4 (LP never profits *from the
swap*) concerns the payout, which is `0` whenever IL is `0`. (`spec.md:158`,
`spec.md:534`)

---

## 4. The THREE PILLARS (the conceptual spine — read before anything else)

Source: `spec.md:85`–`spec.md:127` (§3.0). These three pillars are how the protocol
is organized and how the pitch is structured.

### Pillar 1 — On-chain published fair value (`FairValueOracle`)

The protocol computes and **publishes** the fair value of the claim on-chain:

```
FairPremium = fairRate · MaxIL
```

- **`MaxIL` is pure geometry** (`spec.md:97`). Maximum in-range IL of the specific
  position, computable at creation from `(Pa, Pb, L, P0)`, frozen at creation,
  **identical across the three durations** — duration changes nothing about MaxIL.
- **`fairRate = E_Q[min(IL, MaxIL)] / MaxIL`** is the fraction of MaxIL the claim is
  worth under the risk-neutral measure. It is an **S-curve in `σ²·T`**: ≈0 in
  calm/short regimes (price rarely leaves a wide range), saturating →1 in
  violent/long regimes (price almost surely exits). **`fairRate` carries *all* the
  vol/time dependence; MaxIL carries none.** (`spec.md:98`)
- The protocol prices the **specific position geometry** (width + distance-to-edge +
  T), read on-chain from `positions(tokenId)` — **never a band midpoint.**
  (`spec.md:99`)

**It is an exact closed form, not a fitted surface.** The v3 payoff `min(IL, MaxIL)`
is piecewise (a constant arm, a linear-in-`P` arm, and a `√P` arm, split by the two
cap-crossing prices), and each arm integrated against the GBM density of `P_T` is a
standard interval moment in the normal CDF `Φ`. So `FairPremium = E_Q[min(IL,
MaxIL)]` is a finite **`Φ`-sum** (≈6–10 terms, Black–Scholes class) — no Monte
Carlo, no lookup table, **no calibrated coefficients**, evaluated live per quote.
The `Φ`-sum is **L-independent** (it depends only on `a = Pa/P0`, `b = Pb/P0`,
`σ_ref`, `T`); `σ_ref` is the only stochastic input. (`spec.md:106`)

**The `Φ`-sum is NEVER reimplemented off-chain** (a CLAUDE.md hard rule): the
production pricer is the **Stylus `FairValueOracle`** (machine-precise to 6.7×10⁻¹⁵,
`0x98a6…d52c` on Arbitrum Sepolia); the Solidity `src/FairValueOracle.sol` is a
revm-testable CI cross-check, **not** a second production oracle. The SDK reads the
on-chain `FairPremium` and never approximates it. Verified exact against the repo's
own `il.py` (closed form ≡ quadrature ≡ MC) to ~5×10⁻¹¹ across width × σ × T
(`quant/_scratch_fairvalue_closedform_check.py`). The **only** residual
approximation is the GBM (`r = 0`) assumption itself, covered by the conservative
`σ_ref` and with the residual forward-vol premium deliberately left as MM alpha.
(`spec.md:106`, `spec.md:959`–`spec.md:963`)

> **Theory anchors vs. the pricer (a distinction the founder must get right).** The
> two academic results below are the anchors for *why* the claim is priceable and
> hedgeable. They are **NOT** the on-chain pricer — the exact `Φ`-sum is. Do not
> conflate them. (`spec.md:106`)

### Pillar 2 — The cvAMM (the centrepiece, Path A)

A **pooled passive underwriter**: `ConvexityVault`, an ERC-4626 vault over USDC with
a **dual-tranche SENIOR/JUNIOR structure (LAUNCH, not roadmap)**. It quotes
algorithmically on-chain off `FairPremium` with inventory skews, posts collateral
from the pool, and is **contractually capped at `FairPremium · (1 + maxLoad)` by
invariant I10.** It is the default counterparty and is **always quoting.**
(`spec.md:108`–`spec.md:117`, `spec.md:21`)

It solves four things at once (`spec.md:113`–`spec.md:116`):
- **cold-start** — there is always a price, with no MM present;
- **overcharge** — the price is capped in code (I10), not by trust;
- **intra-pair diversification** — one pool writes many positions whose exits do not
  all cluster at the same price;
- **depositor-viability** — each depositor picks an honest risk dose (senior savings
  account vs junior vol-seller).

The cvAMM is the **floor of liquidity.** Deployed dual-tranche on Arbitrum Sepolia
at `0xDE2fFeBA2E6A18f3A53D43EC0fCCD299158eC30d`. (`spec.md:117`, `spec.md:688`,
`deployments/arbitrum-sepolia.json:55`)

### Pillar 3 — The MM competition rail (Path B)

Sophisticated MMs compete via EIP-712 signed quotes **below** the pool. They matter
for **two load-bearing reasons** (state both in the pitch) (`spec.md:121`–
`spec.md:124`, `spec.md:801`–`spec.md:802`):

1. **Hedged MMs export short-gamma risk *out of the system*** to the global options
   market (Deribit / Panoptic). A closed pool cannot — without MMs the protocol
   becomes a **closed pocket of ETH short-gamma circulating against itself.** MMs who
   hedge make the whole system's risk *smaller*, not just relocated.
2. **Forward-looking-vol MMs correct the pool's structural backward-looking bias.**
   The pool prices off realized `σ_ref` (a backward-looking estimator); MMs price off
   implied/forward vol — the mechanism that incorporates forward information the pool
   structurally cannot see.

The MM rail is the **ceiling of price**: `createSwapRouted` routes to the cheaper of
{pool, best MM quote}, so an MM only wins when it genuinely beats the capped pool.

> **Floor + ceiling, in one line:** the cvAMM is the floor of liquidity (always
> quotes a code-capped price); the MMs are the ceiling of price (win only by beating
> it). (`spec.md:804`, `spec.md:40`)

---

## 5. WHY NOW (the timing argument)

The timing argument rests on two 2025 academic results that make IL risk **priceable
and hedgeable rather than actuarial guesswork** — i.e., the theoretical foundation
for a *priced, collateralized* IL market only recently became rigorous.
(`spec.md:101`–`spec.md:104`, `spec.md:20`)

- **Lipton, Lucic & Sepp (2025)** — an IL-protection claim is **statically
  replicable by a strip of vanilla options**, so it has a model-light fair value and
  a *concrete hedge*. This is the theory anchor for *why the claim is priceable and
  hedgeable*. (`spec.md:103`)
- **Milionis, Moallemi & Roughgarden (2022), *Automated Market Making and
  Loss-Versus-Rebalancing (LVR)*** — the AMM's adverse-selection cost (LVR) has a
  **closed form proportional to instantaneous variance** — equivalently the theta
  (time-decay) of the replicating short-option position — a closed-form anchor for
  the cost of short-gamma exposure. (`spec.md:104`)

Additional "why now" enablers (from architecture decisions, `spec.md:38`):
- **Arbitrum One** has the deepest Uniswap v3 liquidity, Chainlink is fully
  deployed, and **Stylus** support enables the compute-heavy `Φ`-sum oracle in Rust
  at machine precision Solidity cannot match cheaply.
- The off-chain options market (Deribit) and on-chain options venues (Panoptic) now
  exist as places for MMs to *export* the short-gamma risk — making Pillar 3's
  risk-export argument concrete rather than theoretical.

---

## 6. The MaxIL doctrine — load-bearing cap AND unit of risk

This is the single most important concept in the protocol and the founder must be
able to explain it three ways.

### 6.1 MaxIL as the load-bearing cap

`IL(P) = V_hold(P) − V_lp(P)` is **convex on `[Pa, Pb]`**, so its maximum *while
price stays in range* is at a boundary: `MaxIL = max(IL(Pa), IL(Pb))`.
(`spec.md:164`, `spec.md:169`)

> *Proof.* `V_hold(P)` is affine in `P`; in range `V_lp(P) = L(2√P − √Pa − P/√Pb)`,
> so `d²V_lp/dP² = −¼·L·P^(−3/2) < 0` ⇒ `V_lp` strictly concave ⇒ `IL = affine −
> concave` is convex, and `max(0, IL)` (a max of convex functions) is convex. A
> convex function on a compact interval attains its max at an endpoint. Holds for
> *any* entry, centered or not. (`spec.md:166`)

Because `collateral_FULL = MaxIL` and `covered_payoff = min(realized_IL, MaxIL) ≤
MaxIL` by construction, **FULL mode cannot produce bad debt under any price path.**
(`spec.md:178`)

**Why the cap is the right product, not a defect:** at the range boundary the LP has
fully rotated into one asset; IL beyond that point is *directional* loss (foregone
spot upside), not the *impermanent* loss the LP set out to hedge. Capping at MaxIL
keeps the product fully collateralized and trustless. LPs who want beyond-range
protection re-cover after re-ranging. (`spec.md:180`)

### 6.2 MaxIL as the unit of risk (fungibility)

MaxIL is **pure geometry, frozen at creation, identical across durations,
L-independent in the fair-rate sense** — which makes positions **fungible to an
underwriter within a market.** This is why an MM quote is **PER-MARKET** (a load + a
MaxIL-ratio band + capacity), **NEVER per-NFT.** (`spec.md:97`, `spec.md:191`,
prompt framing)

**MaxIL is a collateral/normalization unit, NOT a risk metric.** Two positions with
identical MaxIL can carry very different risk (distance from current price, delta
profile). Both the pool and MMs price `E_Q[min(IL,MaxIL)]/MaxIL` for the *specific
geometry*. (`spec.md:253`)

### 6.3 Why premium is "% of MaxIL" (the key pricing innovation)

If premium were `X% of V0`, a narrow range (tiny MaxIL) gives the underwriter
enormous ROC and a wide range (huge MaxIL) gives insufficient ROC → underwriters
adversely select against wide ranges → liquidity fragments. With premium as `X% of
MaxIL`, the underwriter posts collateral = MaxIL and earns `X%` ROC **regardless of
range width** → indifference to range → full depth. (`spec.md:224`, `spec.md:47`)

### 6.4 No geometry information asymmetry (a deleted v3.3 concept)

v3 position parameters are **PUBLIC on-chain** (`token0`, `token1`, `fee`,
`tickLower`, `tickUpper`, `liquidity` via `positions(tokenId)`). The old framing —
"the LP knows the specific range and the MM does not, so the MM quotes a band to
avoid adverse selection" — is **VOID and deleted.** Both the pool and any MM read
the exact geometry and price the specific position, which **dissolves the
adverse-selection problem** the ratio-band machinery existed to manage.
(`spec.md:258`–`spec.md:267`)

### 6.5 Reference magnitudes (verified from `il.py`)

Geometric-symmetric range `[P0/(1+w), P0·(1+w)]` (`spec.md:184`–`spec.md:189`):

| Range width | MaxIL (% of V0) |
| ----------- | --------------- |
| ±5%         | ≈ 1.27%         |
| ±10%        | ≈ 2.56%         |
| ±20%        | ≈ 5.23%         |
| ±50%        | ≈ 13.76% (arithmetic centering ±50% → 18.0%) |

Verified outputs of the repo's `compute_max_il`
(`quant/src/inflexion_quant/il.py`); the contract `ILMath.sol` already computes them
correctly.

**`fairRate` reference points (σ = 60%, risk-neutral, from `il.py` MC)** — the
S-curve, varying ~2–4× across durations for a single width (`spec.md:232`–
`spec.md:236`):

| Range width | 7d    | 30d   | 90d   |
| ----------- | ----- | ----- | ----- |
| ±5%         | 69.5% | 84.8% | 91.3% |
| ±10%        | 44.9% | 70.8% | 82.9% |
| ±20%        | 18.2% | 47.3% | 67.4% |

**Worked Example — one position, three prices, same MaxIL** (50,000 USDC position,
±10% geometric range, `σ_ref` = 60%, `baseLoad` = +15%, skews = 0) (`spec.md:240`–
`spec.md:251`):

```
MaxIL = 1,280 USDC  (2.56% of V0) — IDENTICAL for all three durations
                       fairRate   FairPremium   cvAMM publishes (@ +15%)
  7d   →               44.9%        574 USDC       661 USDC   (1.32% of V0)
  30d  →               70.8%        906 USDC     1,042 USDC   (2.08% of V0)
  90d  →               82.9%      1,061 USDC     1,221 USDC   (2.44% of V0)
```

Only `fairRate` moves with `σ²·T`; collateral (MaxIL) is constant. The product
carries the **most** convexity value for wide/short positions (cheapest fraction of
MaxIL) and the **least** for tight/long (e.g. ±5%/90d: fairRate 91%, ~87% cap-hit →
effectively pre-paying a near-certain loss).

---

## 7. What this is NOT — the differentiators

Source: `spec.md:26` (§0), `spec.md:1183`, `spec.md:1188`.

### Not Bancor (the single most important "not")

The cvAMM pays claims in **pre-locked USDC and mints nothing** — no token-inflation
reinsurance, no death spiral. In FULL the pool **cannot become insolvent**
(collateral = MaxIL ≥ payout) and **cannot be run** (withdrawal delay + locked/free
accounting). (`spec.md:26`)

**Two separate claims, NEVER merged** (`spec.md:26`, `spec.md:713`–`spec.md:716`):
1. **LPs are always paid** — no bad debt in FULL, code-enforced (invariant I1).
2. **Depositors can lose principal in a crash** — the pool is a volatility seller
   and **capital is NOT guaranteed for either tranche** (junior first-loss; senior
   structurally protected from *underwriting* loss only, never from systemic
   failure).

### Not GammaSwap, not Panoptic, not "insurance"

- **Not GammaSwap** — that is perpetual vol trading needing active management.
  (`spec.md:26`)
- **Not Panoptic** — an options market for quants; our LP pays *one number* and we
  compute everything else. Different audience. (`spec.md:26`, `spec.md:1192`)
- **Not "insurance"** — no actuarial mutualization, no regulatory ambiguity. It is a
  collateralized derivative. (`spec.md:26`)

### The differentiators, distilled

| Differentiator | Why it matters |
| --- | --- |
| **First on-chain price for IL risk** (`FairPremium`, exact `Φ`-sum) | No one else publishes a fair value for LP IL on-chain. (`spec.md:42`) |
| **The cap makes no-bad-debt a *construction*, not a hope** | `collateral = MaxIL ≥ payout` by I1. (`spec.md:1172`) |
| **MaxIL = range-agnostic ROC** | Underwriter indifferent to range width → no adverse selection → full depth. (`spec.md:224`) |
| **cvAMM removes cold-start** | Always quotes a code-capped price; no MM needed to start. (`spec.md:21`, `spec.md:1187`) |
| **I10 caps overcharge in code** | `premium ≤ FairPremium·(1+maxLoad)`, by construction, not by trust. (`spec.md:49`) |
| **Hybrid, non-custodial settlement** | Path A needs no matcher at all; Path B matcher can't steal/forge/force a stale quote. (`spec.md:410`–`spec.md:418`) |
| **The data moat** (five behavioral signals) | The first on-chain view into the microstructure of the DeFi LP vol-risk premium. (`spec.md:898`–`spec.md:908`) |

---

## 8. The no-bad-debt guarantee — say it correctly, always

**Never state it unqualified.** The full clause (CLAUDE.md hard rule,
`CLAUDE.md:100`, `spec.md:24`, `spec.md:1259`):

> No bad debt is exact **ONLY** under: FULL collateralization + capped payoff (`≤
> MaxIL`) + solvent collateral asset (USDC) + oracle/settlement liveness + no
> rehypothecation breach.

Two structural facts that make it robust (`spec.md:650`):
- **The FULL no-bad-debt invariant (I1) is structural and oracle-independent.** In
  FULL, collateral = MaxIL ≥ payout by construction, *regardless of what σ was* — so
  a wrong `σ_ref` **cannot** violate I1.
- **`σ_ref` / `FairValueOracle` are load-bearing for the I10 price cap and for
  *depositor* solvency, NOT for the FULL no-bad-debt invariant.** A vol-oracle fault
  can cost depositors money (bad pricing → NAV compression → junior absorbs first,
  senior in the tail) but can **never** create LP bad debt in FULL.

These are **two separate guarantees, never merged**: (A) LPs are always paid in FULL
(structural, code-enforced I1); (B) depositors can lose principal (volatility sellers
in a crash, CAPITAL NOT GUARANTEED). Both are true; neither implies the other.

---

## 9. The data moat — the FIVE behavioral signals

Source: `spec.md:894`–`spec.md:939` (§12), `spec.md:22`, `spec.md:1179`.

The flow is a byproduct that is itself a product — **the first view into the
microstructure of the DeFi LP volatility-risk premium.** Built passively from day
one; exposed as free public APIs (The Graph + REST). **Revenue is protocol fees;
data is the moat, not a paywall.** (`spec.md:898`)

> **Critical framing correction (v4.0):** the moat is **FIVE BEHAVIORAL SIGNALS**,
> not a circular implied-vol surface. The old "invert `fairRate` for an implied-vol
> surface" claim is **DROPPED** — `charged/MaxIL = fairRate(σ_ref)·(1+load)` only
> recovers our own `σ_ref` + dealer load, not a market IV. The signals are
> actor-driven and non-circular. (`spec.md:896`, `spec.md:919`)

The five signals (`spec.md:900`–`spec.md:906`):
1. **Realized clearing LOAD over a transparent `σ_ref`** — bucketed by `width ×
   distance-to-edge × duration` (exclude cap-bound fills). Pool load is mechanical;
   MM load (`QuoteFilled.loadBps`) is the behavioral choice — the real signal.
2. **Pool-vs-MM load spread + MM win-rate** — a forward-vol read from MM behavior
   (MM prices implied/forward vol; pool prices backward `σ_ref`). Dynamic with ≥3
   MMs.
3. **Term structure of convexity** — MM `loadBps` slope across 7/30/90d per range
   (behavioral; the Path-A load is duration-independent / mechanical, so the slope is
   an MM signal).
4. **Moneyness / demand skew** — realized on-chain **plus** the LATENT / unfilled
   half via off-chain engine telemetry (`DEMAND_LOG`).
5. **Net convexity / gamma supply** — off-chain Greeks summed over the active set.

**Honest framing (mandatory):** we sell the **architecture** of the moat — the
structures exist from day one; the dynamic/latent halves (signals 2 & 4) are captured
by day-one engine telemetry and **mature with volume (≥3 MMs).** The on-chain half of
signals 1/2/3/5 depends on the **redeploy-pending** `SwapPriced` / `QuoteFilled`
events — the on-chain moat dataset **begins at the single redeploy.** (`spec.md:908`)

**Honest limits to put in the docs** (`spec.md:939`): the clearing load is
*contaminated* (liquidity + SC-risk + capital-lock + inventory-skew premia) — compare
the *spread*, not the level; the signal is *reflexive* as the protocol scales (normal
for any derivative market); calibration lags at launch (no historical realized-IL
dataset — the protocol is the mechanism that creates it; that is the moat).

---

## 10. The Inefficiency Ledger (honest economic self-assessment)

Source: `spec.md:815`–`spec.md:821` (§10.1). Four inefficiencies, each stated with
its resolution status — the founder presents this as the "honesty slide"
(`spec.md:1183`).

| # | Inefficiency | Status | Detail |
| - | --- | --- | --- |
| 1 | Risk "merely moved" | **RESOLVED / void** | Geometry is public (no asymmetry), and transferring risk to the cheapest pricer *is* an efficient market. Optional roadmap refinement: make the skew sensitive to the book's net hedgedness (reward hedged MMs who *export* risk over fresh MMs who only relocate it). (`spec.md:817`) |
| 2 | Rebalancing latency | **ACCEPTED** | Self-resolves with protocol attractiveness / MM presence. (`spec.md:818`) |
| 3 | Depositor viability | **THE central challenge** | Addressed by the *combination* of productive collateral (compliant) + load-as-true-vol-premium + pool tail-hedge + senior/junior tranches. **None makes a vol seller safe (impossible); together they make it honest and viable for two audiences.** (`spec.md:819`) |
| 4 | Backward-looking σ | **Calibrated; residual left as MM alpha** | Calibrate the on-chain estimator to the frontier of public info (`σ_short`/`σ_long` blend + floor + known-event calendar) and **deliberately leave the residual forward-looking premium as MM alpha** — that residual blindness *is* the incentive that keeps MMs in the two-sided market (a feature, not a bug). (`spec.md:820`) |

> The central challenge (Inefficiency 3) is the founder's most important honest
> admission: **a single-pair unhedged pool is intrinsically a high-variance
> mono-factor vol seller — no engineering makes a vol seller low-risk.** The honest
> answer is the dual-tranche structure that lets each depositor pick a risk dose.
> (`spec.md:741`, `spec.md:819`)

---

## 11. Target users

Source: `spec.md:811`, `spec.md:1045`–`spec.md:1046` (the three doors), §14.

The landing is **three doors mapping cleanly to the three actors:**

1. **LPs ("Protect my LP position")** — Uniswap v3 LPs who want to hedge in-range
   IL. The **price-inelastic** subset is the prize. (`spec.md:1046`)
   - **The best LP customer: DAOs / protocol treasuries running protocol-owned
     liquidity**, who need predictable, reportable P&L and pay for certainty. This
     reframes Inflexion as **treasury risk management for on-chain institutions** —
     the organic bridge to the program's RWA/institutional theme. (`spec.md:811`)
   - **The worst customer: yield-chasing retail** (price-elastic). (`spec.md:811`)
2. **cvAMM depositors ("Earn in the cvAMM")** — capital providers who want to *earn
   the volatility risk premium*. Two tranches, two risk doses (`spec.md:1063`–
   `spec.md:1073`):
   - **Senior** = a "convexity savings account" (base yield + small premium slice,
     structurally protected from underwriting loss, low variance).
   - **Junior** = a pure vol-selling tranche (most of the load, high APY, first-loss).
   - Every depositor entry point must carry the **CAPITAL IS NOT GUARANTEED**
     dual-claim disclosure (`spec.md:711`, `spec.md:881`).
3. **Market makers ("Underwrite & compete")** — sophisticated underwriters who run
   their own vol models, stream firm signed quotes, and hedge their short gamma
   off-system (Deribit / Panoptic / perps). They are optional and additive — the
   protocol is complete and solvent with Path A alone. (`spec.md:1075`,
   `apps/docs/market-makers.mdx:30`–`apps/docs/market-makers.mdx:49`)

Data consumers (quant funds, vol-arb desks, macro funds, DeFi risk desks, structured
-product issuers, Nansen/DefiLlama/Kaiko/Dune, academics) are the moat's audience but
not a "door" — they consume the free public API. (`spec.md:924`, `spec.md:931`,
`spec.md:936`)

---

## 12. Live deployment (the "it's real" facts)

Source: `deployments/arbitrum-sepolia.json`, `spec.md:1119`.

- **Network:** Arbitrum Sepolia, **chainId 421614**. Fresh full redeploy
  **2026-06-05** (replaces the 2026-06-03 P3.10 stack). (`arbitrum-sepolia.json:2`,
  `arbitrum-sepolia.json:38`, `arbitrum-sepolia.json:41`)
- **Numéraire:** demo USDC (`dUSDC`) = **6 decimals**.
  (`arbitrum-sepolia.json:70`, prompt framing)
- **Production oracle:** Stylus `FairValueOracle`
  `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c` (machine-precise `Φ`-sum).
  (`arbitrum-sepolia.json:43`, `spec.md:959`)
- **Core contracts** (`arbitrum-sepolia.json:48`–`arbitrum-sepolia.json:56`):
  `InflexionCore 0xC198…4848`, dual-tranche `ConvexityVault 0xDE2f…C30d`, `VolOracle
  0xfdEa…5Ed9`, Solidity `ILMath 0x7e90…7bd2`, `OracleManager 0x2c18…529b`,
  `UnderwriterVault 0x4Fb4…8D64`, `ILVault 0x9f76…7664`.
- **Live create→settle lifecycle proven on the fresh stack** (2026-06-05), both
  rails (`arbitrum-sepolia.json:77`–`arbitrum-sepolia.json:105`):
  - **Path A (cvAMM convexity hedge):** swap #1, V0 $270,531, MaxIL $1,669.24,
    premium **$9.70 (0.58% of MaxIL)**, settled realized IL $148.64, payout $148.64
    — paid from the `ConvexityVault`.
  - **Path B (routed to MM):** swap #2, `createSwapRouted` picked the MM because its
    premium **$8.93 beat the cvAMM's $13.80**; MM `loadBps` 1000, MaxIL $3,215.65,
    **the MM's own collateral was locked and paid out** (settled IL/payout $245.66
    from `UnderwriterVault`). This concretely demonstrates the floor/ceiling routing.
- **Subgraph deploy is pending** — the on-chain moat dataset (the `SwapPriced` /
  `QuoteFilled` events) begins at a single redeploy; until then, history degrades to
  a typed pending state. (`spec.md:990`–`spec.md:993`, prompt framing)

> **Two honest deployment caveats the founder should know:** (1) the moat events +
> `CvammPricing.loadComponents` + an `InflexionCore` EIP-170 size-pass are
> **redeploy-pending** (coded on `main`, not yet in deployed bytecode —
> `spec.md:987`–`spec.md:995`); (2) Arbitrum Sepolia has **no Chainlink L2 Sequencer
> Uptime Feed** (testnet, no SLA), so `OracleManager` skips the sequencer check on
> testnet — this **must** be set before any mainnet deploy
> (`arbitrum-sepolia.json:11`–`arbitrum-sepolia.json:12`).

---

## 13. The narrative arc (how the founder tells the story)

A clean 6-beat story the founder can run in the pitch (synthesized from `spec.md`
§0, §16):

1. **The pain.** Uniswap LPs are structurally short gamma — IL costs them >$1B/yr,
   with no trustless hedge. (`spec.md:14`, `spec.md:1158`)
2. **The insight.** IL within a position's range is *bounded* and *convex*, so its
   worst case — **MaxIL** — is exact geometry, and the fair premium is an exact
   closed-form `Φ`-sum. The risk is finally priceable on-chain. (`spec.md:164`,
   `spec.md:106`)
3. **The product.** Pay a fixed premium; if your in-range IL realizes, you're paid
   `min(IL, MaxIL)` from pre-locked collateral. The cap makes **no bad debt a
   construction, not a promise.** (`spec.md:1164`)
4. **The market.** A pooled cvAMM always quotes a code-capped fair price (floor of
   liquidity, no cold-start), and competing MMs undercut it (ceiling of price). You
   always get the cheaper rail. (`spec.md:40`, `spec.md:804`)
5. **The honesty.** Depositor viability is the hard part — a single-pair vol seller
   is intrinsically high-variance; we make it honest with dual tranches, not safe by
   hand-waving. *Not Bancor; capital not guaranteed; LPs always paid.* (`spec.md:1181`–
   `spec.md:1183`)
6. **The moat.** Every trade emits the first on-chain dataset of the DeFi LP
   volatility-risk premium — five behavioral signals, free public API. We own it
   because we create it. (`spec.md:1179`)

---

## 14. Phrases the founder must get exactly right (and the traps)

- ✅ "in-range convexity hedge" — ❌ never "IL insurance." (`spec.md:16`,
  `CLAUDE.md:9`)
- ✅ "no bad debt *under FULL + capped payoff + solvent USDC + oracle/settlement
  liveness + no rehypothecation breach*" — ❌ never "bad debt impossible"
  unqualified. (`CLAUDE.md:100`)
- ✅ "MaxIL is the *collateral / capital unit*, not a risk metric." (`spec.md:253`)
- ✅ "the `Φ`-sum is the on-chain pricer; Lipton–Lucic–Sepp and
  Milionis–Moallemi–Roughgarden are the *theory anchors*, not the pricer."
  (`spec.md:106`)
- ✅ "the data moat is *five behavioral signals*, not an implied-vol surface" — the
  circular IV-inversion claim is dropped. (`spec.md:896`)
- ✅ "capital is NOT guaranteed for *both* tranches" — senior is protected from
  *underwriting* loss only, never systemic. (`spec.md:716`)
- ✅ "the cvAMM removes cold-start because it *always quotes*; one real MM
  demonstrates competition." Do NOT seed a fake MM book. (`spec.md:1187`,
  `spec.md:422`)
- ✅ "Solidity ILMath is production; the Stylus ILMath port is a *rejected benchmark*
  (~5.3× more expensive cached for that tiny kernel). Stylus is production *for the
  compute-heavy FairValueOracle*." (`spec.md:948`–`spec.md:956`, `spec.md:1174`)
- ⚠ "route locked collateral to Aave for yield" is **BLOCKED** by CLAUDE.md /
  spec §7.2 — only idle/free USDC into instantly-redeemable wrappers, never
  utilization-gated venues. Do not state it as the design. (`spec.md:682`,
  `CLAUDE.md:86`)
