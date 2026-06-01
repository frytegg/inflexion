# Quant Work Order — cvAMM-FULL launch (single-asset ETH/USDC)

> **This document is STRUCTURE / SCOPE only.** It enumerates the 10 cvAMM
> deliverables and the methodology each must satisfy. The heavy calibration run
> that produces the final numbers is a **separate execution (P1)**. Do **not**
> read any number below as a calibrated result — every concrete figure here is
> a target, a placeholder, or an authoritative geometry constant already
> verified against `il.py`. Final values land in the `cvamm` block of
> `params.json` (schema: [`params.cvamm.schema.json`](params.cvamm.schema.json)).

## Ground rules (non-negotiable, from CLAUDE.md + the audit)

1. **No hardcoded constants.** Every primitive below is produced here and read
   by the contracts from `params.json` (`cvamm` block). Hardcoding any is the
   exact audit failure.
2. **No-bad-debt only with the qualifying clause.** The FULL guarantee
   (`payout ≤ collateral == MaxIL`) is **structural** — capped payoff + solvent
   USDC + oracle/settlement liveness. The vol oracle and every primitive below
   are load-bearing for the **I10 cap** and **depositor solvency**, NOT for the
   FULL no-bad-debt invariant (I1), which is oracle-independent.
3. **`MaxIL` is pure geometry, frozen at creation, identical across durations.**
   Only `fairRate` carries vol/time. Authoritative geometric-symmetric MaxIL/V0
   (verified against `il.py` / `test_il.py`): **±5% = 1.27%, ±10% = 2.56%,
   ±20% = 5.23%, ±50% = 13.76%** (arithmetic ±50% = 18.0%).
4. **Settle / MaxIL / I1–I9 are untouched.** Every primitive here is **upstream
   of settle** (it shapes `createSwap` pricing). I10 (`premium ≤
FairPremium·(1 + maxLoadBps)`) is additive and enforced by construction.
5. **Never price off raw realized σ.** The vol estimator must take a
   conservative `max(σ_short, σ_long, floor)` — realized vol understates risk
   right before a regime change, the single biggest model risk.
6. **Productive collateral: compliant form only.** Idle/free USDC, instantly
   redeemable wrappers (sDAI / tokenized T-bills), never utilization-gated
   (Aave/Compound), hard cap, never 100%. The "Aave for locked collateral" idea
   is **BLOCKED** pending an explicit owner override of CLAUDE.md — do not
   encode it.

---

## The 10 deliverables

### 1. FairPremium surface — `fairRate(width, distance-to-edge, T, σ)`

`FairPremium = fairRate · MaxIL`, published on-chain by the FairValueOracle.

- **Definition:** `fairRate = E_Q[min(IL, MaxIL)] / MaxIL` under the
  **risk-neutral** GBM measure (`r = 0`, `μ = 0`).
- **It is an EXACT closed form — not an MC / fitted / lookup surface.** The v3
  payoff `min(IL, MaxIL)` is piecewise (a constant arm, a linear-in-`P` arm, and
  a `√P` arm, split by the two cap-crossing prices); each arm integrated against
  the lognormal density of `P_T` is a standard interval moment in the normal CDF
  `Φ`. So `FairPremium` is a finite **`Φ`-sum** (≈6–10 terms, Black–Scholes
  class) — **no coefficients to fit, no grid to store, no MC at runtime** —
  evaluated live from `(Pa, Pb, L, σ_ref, T)`. The straddle-theta /
  static-replication results (Singh et al. AFT 2025; Lipton–Lucic–Sepp 2025;
  **cite, do not re-derive**) are the **theory anchors** for _why_ the claim is
  priceable/hedgeable — **NOT** the pricer, and **NOT** approximations to ship.
- **VERIFIED (this pivot):** the closed form ≡ `il.py` (quadrature ≡ MC) to
  **~5×10⁻¹¹** across width × σ × T (`quant/_scratch_fairvalue_closedform_check.py`).
  The quant **calibrates `baseLoad` / skews / `maxLoadBps` by calling THIS exact
  function** (one source of truth), never a separate MC.
- **The only residual approximation is GBM itself** (real prices jump / have
  stochastic vol); no on-chain formula removes it. Covered by the conservative
  `σ_ref = max(σ_short, σ_long, floor)` (deliverable 2); the residual
  forward-vol premium is deliberately left as MM alpha.
- **Domain:** the specific position geometry (public on-chain via
  `positions(tokenId)`), never a band midpoint — so there is **no geometry
  information asymmetry**. The on-chain pricer takes the position's actual
  tick-derived `(Pa, Pb)`, so the arithmetic-vs-geometric "±width" convention is
  a **reference-table convention only**, not a pricing input.
- **Authoritative reference points** (`il.py` ground truth, σ = 60%):
  - **geometric** half-width (`Pa=P0/(1+w)`, `Pb=P0·(1+w)`): ±5% — 7d 69.5 / 30d
    84.8 / 90d 91.3%; ±10% — 44.9 / 70.8 / 82.9%; ±20% — 18.2 / 47.3 / 67.4%.
  - **arithmetic** half-width (`Pa=P0·(1−w)`, `Pb=P0·(1+w)`): ±10% — 7d 42.88 /
    30d 69.42 / 90d 82.06%; ±5%/30d 84.53%; ±20%/30d 43.12%; ±35%/90d 40.53%
    — all reproduced by the closed form to `<1e-3`.
    Worked Example A (50,000 USDC, ±10% **geometric**, 30d, σ = 60%):
    MaxIL = 1,280 USDC (2.56% of V0); fairRate 70.8% ⇒ FairPremium = 906.
- **Implementation (P2):** exact `Φ`-sum in Stylus AND Solidity, gas+accuracy
  benchmarked; a Solidity `Φ` is itself an approximation (Abramowitz–Stegun etc.)
  so its error must stay below a stated tolerance or the "exact" property is
  lost; ship the cheaper that meets the bar, keep the other as the CI cross-check.
- **Builds on:** `il.py` (`compute_max_il` / `compute_payout`) as the
  verification reference; the closed form lives in a new `cvamm.py` (promote
  `quant/_scratch_fairvalue_closedform_check.py`).

### 2. `sigma_ref` construction — short/long EWMA + floor, conservative `max(...)`

The on-chain VolOracle's reference vol, consumed by the FairValueOracle.

- **Form:** `sigma_ref = max(σ_short, σ_long, floor)`, where `σ_short` and
  `σ_long` are EWMAs of log-returns from Chainlink ticks at two halflives.
- **Mandatory caveat:** NEVER price off raw realized σ (it understates risk
  before a regime change). The `max(...)` is the conservative guardrail and is
  load-bearing for the I10 cap + depositor solvency.
- **Do NOT chase on-chain implied vol.** No deep on-chain options market exists
  (Deribit holds >90% of ETH options off-chain); depending on it reintroduces
  removed fragility. **Deribit DVOL = optional published enrichment only, never
  depended on.**
- **Calibrate:** `short_halflife`, `long_halflife`, and `floor` against the
  historical backtest (below) so `sigma_ref` does not lag a regime jump.
- **Builds on:** ADD an EWMA helper to `prices.py` (lean; the on-chain estimator
  mirrors it).

### 3. `baseLoad` — vol-risk-premium by regime

The structural load over FairPremium that compensates the pool for selling
volatility — the cvAMM's reason to exist.

- **Motivation:** a lone risk-averse writer's CVaR95 is ≈91–100% of MaxIL
  everywhere (overcharge gap 9–73 pts vs fairRate). Diversification across the
  pool collapses per-contract CVaR from ≈100% (N=1) to ≈78.7% (N=100). The
  difference is the room the pool has to undercut a lone MM while staying
  solvent — `baseLoad` is sized inside that envelope.
- **Form:** `baseLoad` **by vol regime** (calm / normal / stressed), keyed off
  `sigma_ref` band. The vol-risk-premium is a true premium in calm markets and
  must remain positive-EV under fat tails + crash correlation (see safety
  targets).
- **Builds on:** the scratch-sim lone-writer-CVaR-vs-diversified analysis →
  `cvamm.py`.

### 4. `util_skew` — curve form on `locked/(locked+free)`

- **Argument:** utilization `u = locked / (locked + free)` of the pool.
- **Behavior:** rises as the pool nears full commitment; wires into the
  withdrawal-delay / locked-free defense (the pool cannot be run).
- **Single-asset:** calibrated on a single-asset book — does **not** inherit the
  dead cross-asset `k ≈ 1.0`.
- **Spec the curve form** (e.g. monotone convex in `u`, parameterized by knee +
  slope) + its params; both go in `params.json`.

### 5. `dispersion_skew` — curve + concentration metric

- **Concept:** the honest single-pair analogue of concentration. Outstanding
  coverage clustered in one width/moneyness/duration corner all hits MaxIL
  together in a move.
- **Concentration metric:** define a single-asset dispersion/concentration
  measure over the outstanding-coverage distribution across width × moneyness ×
  duration (e.g. a Herfindahl-style index on the coverage histogram). The dead
  cross-asset `k`-skew degenerates to 1.0 on one pair — do **not** reuse it.
- **Behavior:** `dispersion_skew` rises with concentration; spec the curve form
  - params.

### 6. `maxLoadBps` — width/duration-conditional [the I10 cap]

- **Role:** the hard cap. `premium ≤ FairPremium·(1 + maxLoadBps)` — invariant
  **I10**, enforced **by construction**: `baseLoad + util_skew +
dispersion_skew` is clamped to `maxLoadBps`.
- **Applies to BOTH paths.** Path A computes the load; Path B derives premium
  from on-chain FairPremium and requires the quote's `loadBps ≤ maxLoadBps`.
- **Conditioning:** by width × duration (tight/short positions tolerate a
  different cap than wide/long). Keyed to the same 9-marketId grid.
- **Upstream of settle.** I10 does not touch settle / MaxIL / I1–I9.

### 7. Productive-collateral SAFE CAP — idle-only, instantly-redeemable only

> ⚠️ **CLAUDE.md HARD-RULE CONFLICT — FLAGGED.** The pivot brief floated "Aave
> for locked collateral." This is **BLOCKED** by CLAUDE.md + spec §7.2 F-#3 +
> the `IYieldAdapter` instantly-redeemable contract: routing locked collateral
> to a utilization-gated venue lets a utilization→100% event break
> `releaseAndDistribute` and the no-bad-debt guarantee via an external
> dependency. **Encode only the compliant form.** Overriding this needs an
> explicit owner decision against CLAUDE.md.

- **Compliant form only:** idle/free vault USDC only; instantly-redeemable
  wrappers only (sDAI / tokenized T-bills); never utilization-gated; a hard cap;
  never 100%; keep a nude-USDC buffer for worst-case simultaneous claims.
- **Deliverable:** size the **safe routable fraction** of idle capital and the
  nude buffer — the yield/safety frontier. Locked collateral is never routed.
- **Status:** ROADMAP.

### 8. Pool-level hedge fraction — APY / tail tradeoff

- **Concept:** the pool buys back a fraction of aggregate tail convexity (long
  option strip / long Panoptic). The only lever that changes the **nature** of
  the risk (halves the worst month) at the cost of APY.
- **Deliverable:** find the optimal hedge fraction on the APY-vs-tail frontier,
  under real-measure crash sims.
- **Panoptic note:** hedge is **approximate** (perpetual vs fixed-maturity
  gamma) and **explicitly NOT relied on for solvency**.
- **Builds on:** `legacy/stress.py` real-measure crash sims + `var_cvar`.
- **Status:** ROADMAP.

### 9. Senior / Junior tranche cut point

- **Concept:** a single-pair unhedged pool is intrinsically a high-variance
  mono-factor vol seller — **no engineering makes a vol seller low-risk.** The
  honest answer is tranching: SENIOR (hedged, base yield + small load slice,
  low tail — "convexity savings account") and JUNIOR (unhedged, first loss,
  captures most of the load — high-APY vol tranche). Each depositor picks risk
  dose.
- **Deliverable:** the cut point between tranches, sized from the depositor loss
  distribution.
- **Builds on:** the legacy fund-pays distribution (`legacy/portfolio.py`) +
  `var_cvar`.
- **Status:** ROADMAP.

### 10. REAL single-asset ETH depositor disclosure numbers

- **Deliverable:** the **single-asset** ETH depositor loss distribution and its
  headline disclosure figures: long-run mean APY, P(losing month),
  1-in-100-month loss, worst-month drawdown.
- **The old multi-asset PARTIAL figures are materially optimistic for one
  pair** — they are placeholders. These must be re-derived single-asset.
- **Verbatim disclosure tone (mandatory):** _"You earn the volatility risk
  premium in calm markets and absorb losses in crashes. In FULL the pool cannot
  become insolvent and cannot be run, but YOUR CAPITAL IS NOT GUARANTEED."_
  Do **NOT** call it stable/modest APY — it is a vol-selling product.
- **Two separate claims, never merged:** (1) LPs are always paid — no bad debt,
  FULL, code-enforced (I1); (2) depositors can lose principal in a crash —
  capital NOT guaranteed.
- **Builds on:** NEW depositor-loss module reusing `legacy/stress.py`
  `var_cvar` / `ruin_probability`.

---

## Methodology requirements

The launch numbers must survive more than vanilla GBM. The estimator and the
backtest must be stronger than the price model used to _price_; a fair value
computed under thin tails and validated under thin tails is not validated.

### Price / return model (beyond GBM)

- **Fat tails:** jump-diffusion (the existing Kou double-exponential in
  `prices.py`) and/or Student-t innovations (`data.synthetic_returns`).
- **Volatility clustering:** stochastic-vol / GARCH-style clustering — realized
  vol arrives in bursts; calm and stressed regimes persist.
- **Tail-dependent crash correlation → 1 in the left tail.** Even on a single
  asset, the _positions_ in the book are tail-dependent (a crash hits every
  outstanding contract at once); the common-factor / correlated-crash machinery
  models that the diversification benefit collapses in the tail. Dispersion
  (deliverable 5) is the on-chain hook for this.

### Historical backtest (2020–2025)

- **Episodes:** must include **March 2020** (COVID), **LUNA/Terra (May 2022)**,
  and **FTX (Nov 2022)** — the canonical ETH stress windows.
- **Data source:** document the source explicitly (e.g. Chainlink historical
  feed / CoinGecko / exchange OHLC). If the live fetch is unavailable, fall back
  to the synthetic generator (`data.synthetic_returns`) and **label the fallback
  clearly** in the output — never present synthetic data as historical.
- **Use:** validate `sigma_ref` does not lag the regime jump; confirm `baseLoad`
  - skews keep the pool positive-EV through each episode; feed deliverable 10's
    disclosure numbers.

### Demand / adverse-selection model

- Confirm that **geometry-specific pricing defends** against selection. Because
  geometry is public, an LP cannot pick off the pool by hiding the range; the
  pool prices distance-to-edge directly. Model an adversarial LP choosing
  position geometry/duration to maximize EV-to-LP and verify the priced load
  still clears positive-EV-to-pool. If a specific corner is selectable, that
  corner's `maxLoadBps` / dispersion response must close it.

### Safety targets (the bar the calibration must clear)

- **P(losing month) ≲ 15%.**
- **1-in-100 monthly loss ≲ 10% of capital.**
- **Long-run mean APY clearly positive** under fat tails + crash correlation.
- **Negligible >50% drawdown over 3 years in FULL.**
- **Verify FULL no-bad-debt on EVERY simulated AND historical path:**
  `payout ≤ collateral == MaxIL` must hold path-by-path with zero exceptions.
  A single violation invalidates the run.

### Adversarial self-audit (after first results)

After the first calibration produces numbers, run an adversarial self-audit:
re-attack the result (worse tails, faster regime jumps, more concentrated book,
selection-aware demand). **If a safety target is infeasible without a load that
is unmarketable** (a load no rational LP would pay), **SAY SO** — do not bury it
behind an optimistic assumption — and **propose a structural change** (e.g.
mandatory pool-hedge fraction, a tighter `maxLoadBps`, a lower utilization cap,
or shipping only the SENIOR tranche). Honesty over a pretty number; the
Inefficiency Ledger (spec) is where the residual is recorded.

---

## What lands where

| Output                       | Destination                                                 |
| ---------------------------- | ----------------------------------------------------------- |
| All 10 calibrated primitives | `params.json` `cvamm` block (P1) — never hardcoded          |
| Proposed schema (this turn)  | [`params.cvamm.schema.json`](params.cvamm.schema.json)      |
| Surface engine + analysis    | NEW `src/inflexion_quant/cvamm.py` (P1)                     |
| `sigma_ref` EWMA helper      | ADD to `src/inflexion_quant/prices.py` (P1)                 |
| Legacy PARTIAL stack         | `quant/legacy/` (P1 physical move) — see `legacy/README.md` |

> `params.json` and `params.py` are **frozen this turn** (pydantic
> `extra='forbid'` + byte-identical roundtrip test at schema `2.0.0`). The
> `cvamm` block is added with a **minor `schema_version` bump** in P1, after the
> calibration run produces real values.
