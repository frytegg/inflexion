# 02 — The Mathematics of Inflexion

> Knowledge-base source material for the public docs and founder judge-prep. Every
> technical claim is cited to `file:line` in the repo. Formulas are reproduced
> exactly as the code computes them; reference numbers are the verified outputs of
> the repo's own implementations, never invented. Where a number in a higher-level
> doc disagrees with the code, the discrepancy is flagged inline.

This document covers the four layered pieces of the protocol's math, in the order
they stack:

1. **The IL formula** (Uniswap v3, the settle-path math) — `V_hold` vs `V_lp`.
2. **MaxIL** — the boundary IL, pure geometry, the collateral unit *and* the cap.
3. **FairValue** — the exact closed-form Φ-sum, `FairPremium = E_Q[min(IL,MaxIL)]`,
   `fairRate` (the S-curve), and `σ_ref` (the vol oracle).
4. **The load stack + I10** — `baseLoad` + the two skews, the clamp, `premium`.

Plus: the no-bad-debt math, the LVR/convexity theory anchors, and the single-asset
depositor disclosure numbers (the P1.13 heavy run).

A one-line mental model: **MaxIL is pure geometry (the *how much capital*); `fairRate`
is pure stochastics (the *how risky*); the load stack is pure inventory state (the
*how scarce*). They multiply: `premium = fairRate · MaxIL · (1 + load)`.**

---

## 1. The Uniswap v3 IL formula — `V_hold` vs `V_lp`

**Spec:** `spec.md` §3.1 (lines 132–158). **Derivation:** `docs/MATH.md` §1 (lines
14–57). **Python reference:** `quant/src/inflexion_quant/il.py`. **On-chain
production:** `ILMath.sol` (Arbitrum Sepolia `0x7e90362bc6Df9cb5faA13952e07853ab16c77bd2`,
`deployments/arbitrum-sepolia.json:52`).

### 1.1 Setup and notation

Let price `P` = price of token0 in token1 — e.g. ETH measured in USDC. A position is
liquidity `L` over a tick range `[Pa, Pb]`, opened at `P0` with the **in-range
requirement `Pa ≤ P0 ≤ Pb`** enforced at creation (`il.py:35-36` raises
`ValueError` if violated; on-chain the in-range gate `a ≥ 1e18 || b ≤ 1e18` reverts
`OutOfRange`, `fairrate.rs:144-146`). The numéraire is token1 (USDC, 6 decimals —
`dUSDC` is the numéraire on the live deploy).

**Entry-snapshot semantics (load-bearing — `spec.md:158`):** all entry quantities
are snapshotted *at swap creation*, not at the LP's original mint. `P0` is the
oracle price at `createSwap`; the entry token amounts are the position's *current*
amounts at that instant. The swap therefore covers IL accruing **from creation
onward** — any IL already borne before covering stays the LP's. `L` is read once at
creation and **stored** in the `SwapRecord`; settlement uses the stored `L`, never
a re-read (invariant **I6**, see §6).

### 1.2 Entry token amounts

For `P0` in range (`il.py:40-41`, `docs/MATH.md:23-26`):

```
amount0_entry = L · (1/√P0 − 1/√Pb)      # token0, e.g. ETH
amount1_entry = L · (√P0 − √Pa)          # token1, e.g. USDC
```

### 1.3 Hold value — affine in price

`V_hold` is the value of simply *holding* the entry basket (`il.py:54`,
`docs/MATH.md:30-31`):

```
V_hold(P_T) = amount0_entry · P_T + amount1_entry
```

This is a **straight line in `P_T`** (affine). It is what the LP *would* have had if
they never provided liquidity — the benchmark IL is measured against.

### 1.4 LP value — three regimes

The actual position value at settlement price `P_T` (`il.py:80-87`,
`docs/MATH.md:39-47`):

```
in range  (Pa ≤ P_T ≤ Pb):
    V_lp(P_T) = L · (2√P_T − P_T/√Pb − √Pa)          ← strictly concave in P_T
below Pa  (P_T < Pa, position fully token0):
    V_lp(P_T) = L · (1/√Pa − 1/√Pb) · P_T            ← linear in P_T
above Pb  (P_T > Pb, position fully token1):
    V_lp(P_T) = L · (√Pb − √Pa)                       ← constant in P_T
```

The intuition for the three regimes: inside the range the position holds a
price-dependent mix of both tokens (concave value — the LP is short gamma); below
`Pa` the LP has rotated entirely into token0 so value scales linearly with price;
above `Pb` the LP has rotated entirely into token1 so value is *constant* (this is
what makes the beyond-range tail unbounded — see §2.2).

### 1.5 Realized IL — the settled quantity

```
realized_IL = max(0, V_hold(P_T) − V_lp(P_T))      [in token1 wei]
```

(`il.py:108`, `docs/MATH.md:52`.) The `max(0, ·)` is **invariant I3**: the
subtraction is *guarded*, never an unchecked underflow. At `P_T = P0`, `V_hold =
V_lp` exactly, so `realized_IL = 0` — no drift ⇒ no loss (`docs/MATH.md:56-57`;
the on-chain test `il_in_range_at_entry_is_zero` asserts this within ≤100 wei).
This also encodes **invariant I4**: if `V_lp ≥ V_hold` the LP never profits from
the swap, payout is 0 — the product is a hedge, not a lottery.

### 1.6 Fixed-point implementation (Q64.96)

The float `il.py` above is the Monte-Carlo reference. On-chain, everything is
integer math in Uniswap **Q64.96** (`docs/MATH.md` §3, lines 105–127):
`sqrtPriceX96 = floor(√P · 2^96)`, `Q96 = 2^96`. All products go through
`mulDiv(a,b,d) = floor(a·b/d)` with a 512-bit intermediate (because `L·sqrtP` can
reach 2^288), and `integer_sqrt` via Newton's method. **Floor rounding everywhere**
makes the result deterministic and reproducible. The Solidity `ILMath` and the
(now-rejected, benchmark-only) Stylus `ILMath` agree **to the wei by construction**
(`docs/MATH.md:212-227`) because they share the same `mulDiv` chain.

> **Note (`spec.md:945-953`, `docs/MATH.md:237-250`):** the headline "Stylus ~10×
> cheaper than Solidity" claim was *inverted* for this kernel — Stylus measured
> ~5.3× *more* expensive cached, because `computeMaxIL` is too little compute to
> amortize Stylus's fixed per-call overhead. **Solidity `ILMath` is the production
> contract; the Stylus `ILMath` port is a rejected benchmark artifact.** (This is
> separate from the Stylus *FairValueOracle*, which **is** production — §3.)

---

## 2. MaxIL — pure geometry, the collateral unit, and the cap

**Spec:** `spec.md` §3.2 (lines 160–191). **Proof:** `docs/MATH.md` §2 (lines
61–101). **Code:** `il.py:111-121` (`compute_max_il`).

```
MaxIL = max( IL(Pa), IL(Pb) )      ← the maximum in-range IL
```

### 2.1 The convexity proof (why the max is at a boundary)

`IL(P) = V_hold(P) − V_lp(P)` is **convex on `[Pa, Pb]`**, so its maximum *while
price stays in range* is attained at an endpoint. The proof (`docs/MATH.md:66-77`,
`spec.md:166`):

- `V_hold(P) = amount0_entry·P + amount1_entry` is **affine** in `P`.
- In range, `V_lp(P) = L(2√P − √Pa − P/√Pb)`, so
  `dV_lp/dP = L(P^(−1/2) − 1/√Pb)` and `d²V_lp/dP² = −¼·L·P^(−3/2) < 0` for all
  `P > 0` ⇒ `V_lp` is **strictly concave**.
- `IL = V_hold − V_lp = affine − concave = convex`, and `max(0, IL)` (a pointwise
  max of two convex functions) is convex too.
- A convex function on a compact interval attains its max at an endpoint. ∎

This holds for **any** entry `P0`, centered or not. (Two external auditors flagged
the asymmetric case; one re-derived and confirmed it. A `fuzz_asymmetric_entry_maxil`
property test samples highly asymmetric `P0` near `Pa`/`Pb`, 2,000×, to be sure —
`docs/MATH.md:79-82, 198`.)

**The asymmetry is real and predictable:** even for a *ratio*-symmetric range, the
convex IL curve is larger toward the upper boundary. In the canonical fixture
`[80, 100, 125]` (−20% / +25% around 100), `MaxIL = IL(Pb=125) > IL(Pa=80)`
(`docs/MATH.md:147-150`).

### 2.2 Why the cap is load-bearing (not a defect)

MaxIL is **not** the global worst case. Above `Pb` the LP is fully in token1 so
`V_lp` is *constant*, while `V_hold` keeps growing linearly with price — so absolute
IL is **unbounded** beyond the range (`docs/MATH.md:88-101`, `spec.md:172`). The
protocol therefore covers the **capped** payoff:

```
covered_payoff = min(realized_IL, MaxIL)
```

(`il.py:124-139`, `compute_payout`.) Because `collateral_FULL = MaxIL` and
`covered_payoff ≤ MaxIL` *by construction of the cap*, FULL mode **cannot produce
bad debt under any price path** (invariants I1 + I2, see §5).

**Product framing (`spec.md:180`):** at the range boundary the LP has fully rotated
into one asset; IL *beyond* that point is *directional* loss (foregone spot upside),
not the *impermanent* loss the LP set out to hedge. Capping at MaxIL keeps the
product fully collateralized and trustless. This is why Inflexion is an **in-range
convexity hedge, NOT "IL insurance"** — the cap *is* the no-bad-debt guarantee, not
a defect. (Audit-flagged: mislabeling it "IL insurance" is both a demand risk —
sophisticated LPs discount the truncated tail — and a reputational/regulatory one.
Every LP surface must show the payoff diagram and the "in-range convexity hedge"
label so the cap never surprises an LP.)

### 2.3 MaxIL is the unit of risk → positions are fungible

MaxIL is **frozen at creation**, **identical across the three durations** (7/30/90d)
for a given position, and **`L`-independent in the fair-rate sense** (`fairRate`
depends only on `a = Pa/P0`, `b = Pb/P0`, `σ`, `T` — not on `L`; §3.3). This is
what makes positions **fungible to an underwriter within a market**: an MM quote is
**per-market** (a load + an optional MaxIL-ratio band + capacity), **never per-NFT**
(`spec.md:191`, §3.4 at `spec.md:255-267`).

> **Important nuance (`spec.md:253`):** "MaxIL is a collateral/normalization unit,
> NOT a risk metric." Two positions with identical MaxIL can carry very different
> risk (distance from current price, delta). Both the pool and MMs price
> `E_Q[min(IL,MaxIL)]/MaxIL` for the **specific geometry**. `MaxIL/V0` is a useful
> monotone *proxy for width* when displaying/filtering, but is **never** the
> pricing input — the pricing input is the full on-chain geometry, which is public
> (`positions(tokenId)`), dissolving the old adverse-selection story entirely.

### 2.4 Reference magnitudes — MaxIL as a fraction of V0

These are pure geometry (no vol, no time). **Geometric-symmetric** range
`[P0/(1+w), P0·(1+w)]` (`spec.md:185-189`,
`params.cvamm.schema.json:72` `maxil_over_v0_geometric`, computed by
`cvamm.maxil_over_v0` / `il.compute_max_il`):

| range width | MaxIL / V0 (geometric centering) |
| ----------- | -------------------------------- |
| ±5%         | **1.27%** |
| ±10%        | **2.56%** |
| ±20%        | **5.23%** |
| ±50%        | **13.76%** (arithmetic centering ±50% → ~18.0%) |

> **Doc-correction flag (`spec.md:182-189`):** these are the *corrected* numbers
> from the repo's own `compute_max_il`. The **v3.3 spec and the current
> `docs/MATH.md` §4 (lines 155–160)** carry an *older, ~4.2× too-low* set
> (`±5% → 0.3%`, `±10% → 1.2%`, `±20% → 4.8%`, `±50% → 25%`). The
> contract `ILMath.sol` always computed the correct (higher) values — this was a
> doc bug, not a code change. **Use the §2.4 table above; the `docs/MATH.md` §4
> centered-range ballpark is stale.** (The `docs/MATH.md` §4 *fixture* table for
> `[80,100,125]` — `MaxIL = 0.13932023`, ~6.6% of V0 — is correct and verified.)

### 2.5 Worked fixture `[80, 100, 125]`, `L = 1e18` (verified)

From `docs/MATH.md` §4-5 (lines 138–179), asserted by
`amounts_fixture_matches_python` / `maxil_fixture_matches_python` and mirrored in
`ILMath.t.sol`:

| Quantity        | Value (token1 wei, integer)  | ≈ (× 1e18) |
| --------------- | ---------------------------- | ---------- |
| `amount0_entry` | `10_557_280_900_008_417`     | 0.01055728 |
| `amount1_entry` | `1_055_728_090_000_841_200`  | 1.05572809 |
| `V_hold(P0)`    | `2_111_456_180_001_682_900`  | 2.11145618 |
| `IL(Pa = 80)`   | `≈ 1.11456e17`               | 0.111456   |
| `IL(Pb = 125)`  | `139_320_225_002_101_320`    | 0.13932023 |
| **MaxIL**       | `139_320_225_002_101_320`    | 0.13932023 |

`MaxIL = IL(Pb) > IL(Pa)` confirms the upper-boundary asymmetry. `MaxIL/V_hold(P0)
≈ 6.6%`. The on-node integer-floor MaxIL (`139_320_225_002_103_011`) sits 1,691 wei
from the Python float anchor — inside the 10,000-wei float-vs-integer tolerance
(`docs/MATH.md:224-227`); Stylus≡Solidity is exact to the wei.

---

## 3. FairValue — the exact closed-form Φ-sum (Pillar 1)

**Spec:** §3.0 Pillar 1 (`spec.md:89-106`), §3.3 Layer 2 (`spec.md:201-208`).
**Python (single source of truth):** `quant/src/inflexion_quant/cvamm.py`
(`fair_rate`, `fair_premium`). **On-chain production:** Stylus
`FairValueOracle` (Arbitrum Sepolia `0x98a6aa75108b70fc0794bc3b87efe0ae99d5d52c`,
`deployments/arbitrum-sepolia.json:43`; Rust at
`packages/contracts/stylus/FairValueOracle/src/fairrate.rs`). The Solidity
`src/FairValueOracle.sol` is a **revm-testable CI cross-check, not a second
production oracle** (`spec.md:106`).

### 3.1 The two-layer factorization

```
fairRate    = E_Q[ min(IL, MaxIL) ] / MaxIL        // the S-curve in σ²·T
FairPremium = fairRate · MaxIL                      // published on-chain, USDC
```

(`cvamm.py:175-235`, `spec.md:93-94, 204-206`.) **`fairRate` carries ALL the
vol/time dependence; MaxIL carries none.** That is the whole point of the
factorization:

- **MaxIL** = pure geometry (§2), frozen at creation, identical across durations.
- **`fairRate`** = the *fraction of MaxIL the claim is worth* under the risk-neutral
  measure. It is an **S-curve in `σ²·T`** and in how centered/close-to-edge the
  range is: ≈0 in calm/short regimes (price rarely leaves a wide range), saturating
  →1 in violent/long regimes (price almost surely exits).

So for one position the cvAMM publishes **three different prices** (7/30/90d), all
backed by the **same** MaxIL — only `fairRate` moves (`spec.md:191, 246-251`).

### 3.2 It is an EXACT closed form, not a fitted/MC/lookup surface

This is the single most important "why we are first to price IL on-chain" point, and
the judges will probe it. `fairRate` **has no calibrated coefficients** — the only
stochastic input is `σ_ref` (`cvamm.py:11-14, 45` in `params.cvamm.schema.json`).

**The mechanism (`cvamm.py:176-230`, mirrored in `fairrate.rs:71-139`):** the capped
v3 payoff `min(IL, MaxIL)` is **piecewise in the terminal price** — three arms split
by the range edges and the two cap-crossing prices:

- **below `Pa`**: `IL = a1b·P + a0b` (linear, decreasing; `a1b < 0`), capped (= MaxIL)
  for `P < PcapL` if the cap binds.
- **inside `[Pa, Pb]`**: `IL = c1·P − 2L·√P + c0` (convex, **never capped** — a
  convex function on the range lies below its endpoint chord ≤ MaxIL).
- **above `Pb`**: `IL = a1a·P + a0a` (linear, increasing; `a1a > 0`), capped for
  `P > PcapR`.

Under risk-neutral GBM with **`r = 0` (forward = P0)** — see §3.5 — `P_T` is
lognormal, so each arm integrated against the density is a **standard lognormal
interval moment** in the normal CDF `Φ`. The building block (`cvamm.py:152-172`):

```
E[ P_T^p · 1{K1 < P_T < K2} ] = P0^p · exp(½·p(p−1)·σ²T) · (Φ(d(K1)) − Φ(d(K2)))
   with  d(K) = (ln(P0/K) + (p − ½)·σ²T) / (σ√T)
```

with the sentinels `K ≤ 0 ⇒ d = +∞ ⇒ Φ = 1` (lower bound) and
`K = +∞ ⇒ d = −∞ ⇒ Φ = 0` (upper bound). The arms use only `p ∈ {0, ½, 1}`
(`M0`, `Mh`, `M1` in `cvamm.py:208-216`). The integration limits are
`K ∈ {0, Pa, Pb, PcapL, PcapR, +∞}`. So `FairPremium = E_Q[min(IL,MaxIL)]` is a
**finite Φ-sum** (≈6–10 terms, Black–Scholes class) — **no Monte Carlo, no lookup
table, no fitted coefficients, evaluated live per quote** (`spec.md:106`).

The cap-crossing prices (`cvamm.py:205-206`):
`PcapL = (MaxIL − a0b)/a1b` (cap binds below it if `> 0`);
`PcapR = (MaxIL − a0a)/a1a` (cap binds above it if `> Pb`).

The Φ-sum is **L-independent**: it depends only on `a = Pa/P0`, `b = Pb/P0`, `σ`,
`T` (the on-chain entry `fair_rate_wad` takes `a`, `b` normalized to `P0=1`, `L=1` —
`fairrate.rs:71, 143-160`).

### 3.3 fairRate = FairPremium/MaxIL is the S-curve (the dial)

`fairRate ∈ [0, 1]` is the dimensionless S-curve. As `σ²·T → 0`, fairRate → 0
(price stays put, the cap is irrelevant, the claim is near-worthless). As
`σ²·T → ∞`, fairRate → 1 (price almost certainly exits the range, the claim almost
surely pays MaxIL — you are pre-paying a near-certain loss). The S-shape between
those asymptotes is the entire pricing surface, and it is **exact**, not fit.

**`fairRate` reference points (σ = 60%, risk-neutral, geometric half-widths)** —
`il.py` ground truth reproduced by `cvamm.fair_rate`
(`spec.md:230-237`, `params.cvamm.schema.json:62-65`):

| range width | 7d    | 30d   | 90d   |
| ----------- | ----- | ----- | ----- |
| ±5%         | 69.5% | 84.8% | 91.3% |
| ±10%        | 44.9% | 70.8% | 82.9% |
| ±20%        | 18.2% | 47.3% | 67.4% |

Read the table as the S-curve walking up `σ²·T`: a wide/short position (±20% / 7d)
is worth only **18%** of MaxIL — the cheapest fraction, the most convexity value;
a tight/long position (±5% / 90d) is worth **91%** of MaxIL — effectively pre-paying
a near-certain loss. **The product carries the most convexity value for wide/short,
the least for tight/long** (`spec.md:251`).

### 3.4 Verification — exact to the repo's own il.py

The closed form is verified ≡ `il.py` (which is verified ≡ dense quadrature ≡ Monte
Carlo) so it cannot drift from the settle-path math:

- **Closed form vs `il.py` quadrature/MC:** `max_abs_err ≈ 5.1e-11`
  (`params.cvamm.schema.json:55`, `cvamm.verify_closed_form` at `cvamm.py:355-383`,
  scratch `quant/_scratch_fairvalue_closedform_check.py` — verdict "CONFIRMED
  (machine precision)" if `< 1e-5`). The P1.13 heavy run re-states this as
  `≡ il.py to 3.3e-9` (`HEAVY_CALIBRATION.md:90`). Both are far inside tolerance.
- **Vectorized engine ≡ scalar:** `fair_rate_vec` (`cvamm.py:265-316`) folds the
  cap-branches into branch-free clipped split points (`PcapL_eff = max(PcapL,0)`,
  `PcapR_eff = max(PcapR,Pb)` — when a cap does not bind its interval collapses to
  zero width), ~1000× faster, verified ≡ scalar in the test suite.
- **Stylus Φ-sum vs mpmath 50-digit reference:** the on-chain Rust matches the
  high-precision `mpmath` fixtures to **≤ 1e-12 on fairRate (≤ 1e6 wei at 1e18
  scale; in practice ≤ a few wei)** — `fairrate.rs:188-197`, fixtures generated by
  `quant/_scratch_fairvalue_hp_reference.py` (dps=50). The Stylus erf is integer
  fixed-point and "machine-precise" precisely because Stylus **bans WASM floating
  point at activation** (`lib.rs:2-16`); the Solidity Abramowitz–Stegun erf is only
  ~1.5e-7 (÷MaxIL-amplified to ~1e-3 at the tight tier), which is why the Solidity
  oracle is a CI cross-check and the **Stylus oracle is production**.

> **Flag (precision figure):** the higher-level brief cites the Stylus FVO as
> "machine-precise to 6.7×10⁻¹⁵" (and `spec.md:106` repeats it). The figure I can
> verify *in the Stylus code* is **≤ 1e-12 absolute on fairRate vs the mpmath HP
> fixtures** (`fairrate.rs:188`). The `6.7e-15` figure may refer to the internal
> erf primitive precision rather than the end-to-end fairRate error; I could not
> locate it verbatim in `fairrate.rs`/`fixed.rs`/the scratch files. **Cite the
> ≤1e-12 fairRate figure for defensible claims.**

### 3.5 The only residual approximation: GBM, r = 0

The Φ-sum is exact *given* the model. The **only** modeling assumption is
risk-neutral **GBM with `μ = 0, r = 0`** (`measure: risk_neutral_gbm_mu0_r0`,
`params.cvamm.schema.json:43`; `cvamm.py:12, 156-157`). No on-chain formula removes
this. It is covered two ways (`spec.md:106`): (1) the conservative `σ_ref` (§3.6),
and (2) the residual forward-vol premium is deliberately left as **MM alpha** —
forward-looking-vol MMs price off implied vol and correct the pool's structural
backward-looking bias (Pillar 3, `spec.md:124`).

### 3.6 σ_ref — the EWMA volatility oracle (Pillar 1's only stochastic input)

**Spec:** §6.5 (`spec.md:638-652`). **Python:** `prices.py:264-329`
(`ewma_volatility`, `sigma_ref`). **On-chain:** `VolOracle`
(`0xfdEafBB381192FC5337499d041eaead04d565Ed9`,
`deployments/arbitrum-sepolia.json:51`).

```
σ_ref = max( σ_short , σ_long , floor )
```

- `σ_short`, `σ_long` are **EWMAs of log-returns** from Chainlink price ticks at two
  horizons. EWMA variance with weight `λ^age`, `λ = 0.5^(1/halflife)` (weight halves
  every `halflife` samples), normalized over the window, annualized by
  `√samples_per_year` (`prices.py:290-299`). Most recent return carries the largest
  weight. `demean=False` (RiskMetrics convention: short-horizon mean ≈ 0).
- **Calibrated values (`params.cvamm.schema.json:76-85`):** `short_halflife = 86400 s`
  (1 day), `long_halflife = 2592000 s` (30 days), `floor = 0.50`.
- **Why `max(...)` is MANDATORY (not optional engineering — `spec.md:647`,
  `prices.py:312-319`):** realized vol *understates* risk right before a regime
  change (vol lags the jump). A single fast EWMA would collapse to a deceptively
  calm number exactly before a crash — and a writer pricing off it would be badly
  underpriced when it matters most. Taking the max of a short window, a long window,
  *and* a hard floor is the conservative guard.
- **The floor sits ABOVE calm ETH vol on purpose.** `floor = 0.50 > ~0.45` observed
  calm ETH vol, so the pool **overcharges calm months** and is net-conservative to
  depositors (the heavy run measured all-months realized payout/premium = **0.654**)
  (`params.cvamm.schema.json:83`).
- **No on-chain implied vol.** There is no deep on-chain options market (Deribit
  holds >90% of ETH options off-chain). Deribit DVOL is an **optional published
  enrichment only, never depended on** by any solvency path (`spec.md:648`).

**Load-bearing scope (precise — `spec.md:650`, `prices.py:315-319`):** `σ_ref` (and
`FairValueOracle`) is solvency-load-bearing for **the I10 cap and depositor
solvency** only. A wrong/too-low `σ_ref` makes the pool *under-charge load*, so
premium income stops covering payouts and **NAV compresses** — junior absorbs it
first, senior in the tail. It is **NOT** load-bearing for the **FULL no-bad-debt
invariant (I1)**, which stays structural and oracle-independent: in FULL,
collateral = MaxIL ≥ payout *regardless of what σ was*. A vol-oracle fault can cost
depositors money but can **never** create LP bad debt in FULL. **Two separate
guarantees, never merged.** (`HEAVY_CALIBRATION.md:21-24`: a lagging σ_ref
underprices coverage written at a stress *onset* — payout/premium = 1.14 at onset —
that residual is the vol-risk-premium `baseLoad` must carry, not a no-bad-debt risk.)

---

## 4. The load stack and the I10 cap (Pillar 2 pricing)

**Spec:** §3.3 Layer 3 (`spec.md:210-228`), §3.5 the two skews (`spec.md:269-276`).
**Python:** `cvamm.py` (`util_skew`, `dispersion_skew`, `clamp_load`,
`base_load_from_envelope`). **On-chain:** the `CvammPricing` library
(`0x4a053d29a55a64172140f9ebbc27c321c0ba2b53`,
`deployments/arbitrum-sepolia.json:61`) inside `ConvexityVault`.

```
premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)
        , HARD-CAPPED at FairPremium · (1 + maxLoad)        // invariant I10, by construction
```

**Both paths use the same fair value.** Path A (cvAMM) computes the load on-chain.
Path B (MM) carries a `loadBps`; the contract **derives** the MM premium as
`FairPremium · (1 + loadBps/1e4)` and requires `loadBps ≤ maxLoadBps`. The LP gets
the **cheaper of the two** (`createSwapRouted`). (`spec.md:226, 290`.)

### 4.1 `baseLoad` — the structural volatility-risk premium

The load *over fair value*. Its economic justification is the **lone-writer CVaR
gap** (`cvamm.py:389-422`, `spec.md:217`): a single risk-averse writer must reserve
against the *tail* of what they may pay, not the mean. The lone-writer CVaR95 sits
at **~91–100% of MaxIL** almost everywhere — so an uncharged writer is badly
underpriced. **Diversification collapses that gap.** With a pool of `N`
identical-geometry contracts under a one-factor correlation model
(`cvamm.py:425-488`):

```
P_T,i = P0·exp(−½σ²T + σ√T·(√ρ·Z_common + √(1−ρ)·Z_i))
```

- `ρ = 0` (full cross-sectional diversification — distinct durations/staggered
  entries): per-contract CVaR95 **collapses ~100% → 78.5%** as `N: 1 → 100`
  (`params.cvamm.schema.json:91-95`, at σ=60%, ±10%, 30d; spec rounds to ~78.7%).
- `ρ = 1` (a *synchronized* single-pair book — one ETH move hits every contract):
  **NO diversification**, per-contract CVaR stays **~100%** — the crash-correlation
  tail. This is exactly why `dispersion_skew` exists (§4.3).

`baseLoad` is sized **inside the `[fair, diversified-CVaR]` envelope**
(`base_load_from_envelope`, `cvamm.py:491-520`): the pool must charge ≥ fair (else
negative-EV) and *can* charge up to the diversified-pool CVaR while still
undercutting a lone MM (whose CVaR is ~100%):

```
target_rate = fair + capital_fraction·(diversified_cvar − fair)
baseLoad    = target_rate / fair − 1
```

**Calibrated values — `baseLoad` keyed by `σ_ref` regime band**
(`params.cvamm.schema.json:97-107`):

| regime  | σ_ref band         | baseLoad |
| ------- | ------------------ | -------- |
| calm    | < 0.60             | **2000 bps (+20%)** |
| normal  | 0.60 – 1.025       | **3000 bps (+30%)** |
| stressed| ≥ 1.025            | **5000 bps (+50%)** |

(The depositor heavy run uses the same calm/normal/stressed = 0.20/0.30/0.50.)
`baseLoad` gives strongly positive long-run growth but does **not** by itself meet
the depositor safety targets — those need the structural levers (§6.3).

### 4.2 `util_skew` — utilization scarcity (the drawdown lever)

Rises as the pool nears full commitment, on `u = locked/(locked+free)`
(`cvamm.py:526-554`, `spec.md:273`):

```
util_skew(u) = min( cap , slope · (max(0, u − knee)/(1 − knee))^power )
```

Flat below `knee` (spare capacity is cheap), rising **convexly** toward full
commitment. **Calibrated (`params.cvamm.schema.json:115`):** `knee = 0.45`,
`slope = 0.6`, `power = 2.0`, `cap = 0.6`. This is the **same locked/free accounting
that powers the withdrawal-delay run-defense** — pricing new coverage up *before*
the pool is over-committed. The heavy run found **utilization is the dominant
DRAWDOWN lever** (not a tail-feasibility lever): at base loads, `u = 0.40 → P(3y
DD>50%) = 2.7%` vs `u = 0.60 → 18.0%` (`params.cvamm.schema.json:116`).

### 4.3 `dispersion_skew` — single-pair concentration (the honest analogue)

Rises as outstanding coverage **clusters** in one width/moneyness/duration corner —
the honest single-pair analogue of concentration (many positions bunched at the same
edge all hit MaxIL together in one move). It is measured by a **normalized
Herfindahl–Hirschman index** over the MaxIL-weighted coverage histogram across the
`width × moneyness × duration` grid (`coverage_concentration`, `cvamm.py:557-576`):
`0` = perfectly dispersed, `1` = all coverage in one corner. Then
(`cvamm.py:597-603`):

```
dispersion_skew(h) = min( cap , slope · h^power )
```

**Calibrated (`params.cvamm.schema.json:125`):** `slope = 0.5`, `power = 1.5`,
`cap = 0.5`. A well-dispersed book is charged ~0; full concentration adds +0.5 load.
This is **single-asset calibrated** — it does **not** inherit the dead cross-asset
correlation `k ≈ 1.0` (on a single-pair book the cross-asset concentration skew
degenerates to a useless constant, `spec.md:271-274`).

### 4.4 The I10 clamp — overcharge impossible by code

```
total_load = min( baseLoad + util_skew + dispersion_skew , maxLoad )
premium    = FairPremium · (1 + total_load)
```

(`clamp_load`, `cvamm.py:609-623`.) **Invariant I10, by construction:** because the
sum of loads is clamped to `maxLoad`, `premium ≤ FairPremium · (1 + maxLoad)` holds
for **any** inputs, on **both** paths, **upstream of `settle`** — it never touches
`settle`, the MaxIL formula, or I1–I9. On Path A it is a mechanical deterministic
clamp (no MM discretion, holds for all state sequences and all price paths, FULL and
PARTIAL both); on Path B it is `require(loadBps ≤ maxLoadBps)`
(`spec.md:1021`).

**Sizing `maxLoadBps` — the principled ceiling is `premium ≤ MaxIL`**
(`params.cvamm.schema.json:131`): you never charge more than the maximum possible
payout. Since `premium = fairRate·MaxIL·(1+load)`, that gives
**`maxLoad = 1/fairRate − 1`** — naturally width/duration/σ-conditional. The
on-chain preferred form evaluates it live:

```
maxLoadBps = clamp( round((1/fairRate(σ_ref) − 1)·10000) , floor , 16000 )
```

Static ceiling at `σ_ref = 0.75` (normal regime), clamped at 16000
(`params.cvamm.schema.json:133-138`):

| width | 7d    | 30d  | 90d  |
| ----- | ----- | ---- | ---- |
| ±5%   | 3282  | 1375 | 744  |
| ±10%  | 8502  | 3082 | 1578 |
| ±20%  | 16000 | 7773 | 3559 |

Tight/long cells get tiny load room — *economically exact*: a near-certain payout
(fairRate ≈ 1) cannot carry a risk premium beyond itself.

### 4.5 Worked example — one position, three prices (`spec.md:240-251`)

50,000 USDC position, ±10% geometric range, `σ_ref = 60%`, `baseLoad = +15%`,
skews = 0. **MaxIL = 1,280 USDC (2.56% of V0) — identical for all three durations:**

| duration | fairRate | FairPremium | cvAMM publishes (@ +15%) |
| -------- | -------- | ----------- | ------------------------ |
| 7d       | 44.9%    | 574 USDC    | 661 USDC (1.32% of V0)   |
| 30d      | 70.8%    | 906 USDC    | 1,042 USDC (2.08% of V0) |
| 90d      | 82.9%    | 1,061 USDC  | 1,221 USDC (2.44% of V0) |

30d load sensitivity: `@+5% → 952 USDC`, `@+30% → 1,178 USDC` (ceiling =
`FairPremium·(1+maxLoad)`). Only `fairRate` moves; collateral (MaxIL) is constant —
over 90d the ±10% band is touched ~75% of the time vs ~24% over 7d, and the S-curve
does all the work.

### 4.6 Live on-chain confirmation (2026-06-05 lifecycle, real numbers)

From the live create→settle run on the fresh stack
(`deployments/arbitrum-sepolia.json:77-106`), which demonstrates the whole stack and
the routing:

- **Path A (cvAMM pool):** V0 = $270,531.28, MaxIL = $1,669.24, **premium = $9.70
  (0.58% of MaxIL)**, realized IL at settlement = $148.64, payout = $148.64 paid
  from the `ConvexityVault`. (The tiny premium fraction reflects a wide/short
  position — low fairRate.)
- **Path B (MM won the route):** `createSwapRouted` chose the MM because its price
  (premium $8.93, `loadBps = 1000`) **strictly beat** the cvAMM price ($13.80).
  MaxIL = $3,215.65, the MM's **own** collateral was locked and paid the
  realized $245.66 payout from `UnderwriterVault`. This is the floor-of-liquidity /
  ceiling-of-price routing working end to end.

---

## 5. The no-bad-debt math

**Spec:** §3.2 (`spec.md:174-178`), invariants §13 (`spec.md:1012-1021`).

The guarantee, stated **only** with its full qualifying clause (`spec.md:24, 715`,
CLAUDE.md hard rule): **no bad debt is exact ONLY under** FULL collateralization +
capped payoff + solvent collateral asset (USDC) + oracle/settlement liveness + no
rehypothecation breach. Never state it unqualified.

The structural core, in three lines:

```
collateral_FULL = MaxIL                            (locked at creation)
covered_payoff  = min(realized_IL, MaxIL) ≤ MaxIL  (by construction of the cap)
∴ payout ≤ collateral = MaxIL                       (no bad debt — invariants I1, I2)
```

This is **orthogonal to the premium** and **oracle-independent**: it holds for any
price path and any (even wrong) `σ`. The relevant settle-path invariants
(`spec.md:1012-1021`):

- **I1 — no bad debt (FULL):** `payout ≤ collateral == MaxIL`.
- **I2 — cap correctness:** `payout == min(realized_IL, MaxIL)`.
- **I3 — non-negativity / no underflow:** `realized_IL = V_hold > V_lp ? V_hold −
  V_lp : 0` (never an unchecked subtraction).
- **I4 — LP never profits:** `V_lp ≥ V_hold ⟹ payout == 0`.
- **I5 — vault solvency:** `locked ≤ deposited` per MM and for the pool.
- **I6 — liquidity immutability:** settlement uses the `L` *stored at creation* —
  external `increaseLiquidity` on the custodied NFT cannot inflate payout above
  MaxIL.
- **I10 — price cap (by construction, upstream of settle):** `premium ≤ FairPremium
  · (1 + maxLoadBps)` on both paths; does **not** touch settle/MaxIL/I1–I9. Note
  I1 also depends on oracle/settlement liveness while **I10 is always-true by code**
  (it is a pure pricing clamp).

**Verified (P1.13 heavy run, `HEAVY_CALIBRATION.md:36-41`):** `payout_frac =
min(IL,MaxIL)/MaxIL ≤ 1.0` on **every** simulated path and over a ±99% (and a
widened −6…+6 log-move) grid: `max_payout_frac = 1.000000`, zero exceptions,
structurally and independent of any oracle.

> **Not Bancor (`spec.md:26`):** the cvAMM pays claims in **pre-locked USDC and
> mints nothing** — no token-inflation reinsurance, no death spiral. Two separate
> claims, never merged: (1) **LPs are always paid** (no bad debt, FULL, I1);
> (2) **depositors can lose principal in a crash** (junior first-loss; senior
> protected from underwriting loss while junior buffers, takes only the systemic
> tail). **CAPITAL IS NOT GUARANTEED** for either tranche.

### 5.1 Dual-tranche waterfall math

**Spec:** §7.3 (`spec.md:686-696`), §8.2 (`spec.md:739-746`). The structural senior
protection is the invariant **`totalLocked ≤ juniorAssets`**, enforced at *every*
`lockCollateral`. Since every payout ≤ its MaxIL = its locked amount:

```
Σ payouts ≤ totalLocked ≤ juniorAssets   ⟹   payout ≤ locked ≤ junior
```

so junior absorbs **all** underwriting loss before senior is ever touched. This is
the code form of the roadmap's "enforce `u ≤ 1−sf`", made **adaptive to the actual
junior buffer** (safer than a fixed ratio). The algebra: with target `sf = 0.60`,
junior fraction `1 − sf = 0.40`, so `totalLocked ≤ juniorAssets ⟺ u ≤ 0.40 = 1−sf`
— exactly the utilization bound under which the P1.13 senior-P(loss)=0 calibration
holds (`spec.md:746`). **Senior protection is calibrated, not guaranteed:** P(senior
loss) = 0 holds only while `u ≤ 1−sf`, and never against systemic failure.

---

## 6. Theory anchors and the depositor disclosure numbers

### 6.1 The convexity / LVR theory anchors (cited, not re-derived)

**Spec:** §3.0 (`spec.md:101-106`). Two 2025/2022 results make the IL claim
*priceable and hedgeable* rather than actuarial guesswork — they are **theory
anchors for *why* the claim is priceable, NOT the on-chain pricer** (the exact
Φ-sum is the pricer):

- **Lipton, Lucic & Sepp (2025):** an IL-protection claim is **statically
  replicable by a strip of vanilla options** ⇒ it has a model-light fair value and
  a concrete hedge.
- **Milionis, Moallemi & Roughgarden (2022), *Automated Market Making and
  Loss-Versus-Rebalancing*:** the AMM's adverse-selection cost (**LVR**) has a
  **closed form proportional to instantaneous variance** — equivalently the *theta*
  (time-decay) of the replicating short-option position. This is the closed-form
  anchor for the cost of short-gamma exposure: a v3 LP is structurally **short
  gamma** (concave `V_lp`, §1.4), and IL is the realization of that short-gamma /
  LVR cost.

The intuition tying it to §1-§3: `V_lp` concave ⇒ LP short gamma ⇒ pays LVR ⇒ owes
IL; Inflexion sells the LP the *long-convexity* leg that offsets it, capped at the
in-range maximum (MaxIL), and prices it with the exact risk-neutral expectation of
that capped payoff (the Φ-sum).

### 6.2 Single-asset depositor disclosure — the P1.13 heavy-run figures

**Source:** `quant/HEAVY_CALIBRATION.md`, `quant/cvamm_heavy_results.json`,
`params.cvamm.schema.json:169-202`, `spec.md:707-720`. The model is **stronger than
GBM** (the deliberate bar): Student-t fat tails (`t_df = 4`), a 3-state Markov vol
regime (calm 0.45 / normal 0.75 / stressed 1.30, persistence 0.82), tail-dependent
crash correlation → 1 (single pair, whole book settles against the same move) plus
Poisson deep-crash months (~0.8/yr, mean −45%), and a **lagging `σ_ref`** so
coverage at a stress onset is underpriced exactly as on-chain. It is a *labelled
historical-episode-anchored real-measure model* (CoinGecko free tier is 401-gated;
crash freq/magnitude bracket March 2020 / Terra-LUNA / FTX / 2022 bear).

**The depositor is a volatility seller:** collects premium priced under the
risk-neutral measure at the conservative `σ_ref`, pays realized `min(IL, MaxIL)`
under the *real* measure. The monthly P&L identity (`depositor.py:107-141`):

```
monthly_return = utilization · Σ(premium_i − payout_i) / Σ MaxIL_i
   premium_i = fairRate(σ_ref)·(1 + baseLoad)·MaxIL_i      (income, RN at σ_ref)
   payout_i  = min(IL_i, MaxIL_i)                          (claim, real measure)
```

**Headline figures — bare pool (unhedged, untranched), baseLoad calm/normal/stressed
= 20/30/50%, gross of demand/competition/fees, lead with the geometric 3y CAGR**
(`HEAVY_CALIBRATION.md:59-62`, `cvamm_heavy_results.json:3-27`):

| Operating point      | 3y CAGR (med/p10/p90) | P(3y NAV<1) | P(losing month) | 1-in-100 month | worst month | P(3y DD>50%) | no bad debt |
| -------------------- | --------------------- | ----------- | --------------- | -------------- | ----------- | ------------ | ----------- |
| Disciplined `u=0.40` | **122% / 50% / 247%** | 0.3%        | **26.5%**       | **−20.1%**     | **−26.8%**  | **2.7%**     | ✓ |
| Fully-deployed `u=0.60` | 209% / 72% / 491%  | 0.5%        | 26.5%           | −30.1%         | −40.1%      | 18.0%        | ✓ |

> **The honest headline finding (`HEAVY_CALIBRATION.md:43-51`):** the unhedged,
> untranched single-pair ETH pool **CANNOT meet the SPEC safety targets at any
> *marketable* load** (`premium ≤ MaxIL`). The binding constraints —
> `1-in-100 monthly loss ≤ 10%` and `P(losing month) ≤ 15%` — are **intrinsic to
> single-asset volatility selling** (you lose whenever realized > implied, and a
> crash pays the whole synchronized book). The targets were **NOT loosened**; the
> structural levers are the honest answer.

### 6.3 The structural levers (how the targets are actually met)

`HEAVY_CALIBRATION.md:73-81`, `cvamm_heavy_results.json:29-60`,
`params.cvamm.schema.json:152-167`:

| Lever                              | Effect (u=0.40, base loads)                                                          | Status  |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------- |
| **Utilization cap** (`util_skew`, knee 0.45) | the **drawdown** lever: `u=0.40 → P(DD>50%)=2.7%` vs `u=0.60 → 18%`        | launch  |
| **Pool hedge** (h≈0.60)            | 1-in-100 → **−9.6%** (target ~−10%), worst → −12.3%, P(DD>50%) → ~0%; CAGR barely moves. **Tail-tightening, NOT solvency** (basis risk; approximate perpetual-vs-fixed gamma) | roadmap |
| **Senior/junior tranche** (`sf=0.60`) | **senior P(loss)=0, worst=0%**, gross CAGR ~197% — the "convexity savings account." **Junior** worst **−67%** (high-APY first-loss vol tranche). Holds **jointly with `u ≤ 1−sf`** | LAUNCH (structural invariant); hedge is roadmap |

(Pool-hedge frontier verified: `h=0.50 → 1-in-100 −11.3%`; `h=0.60 → −9.6%`;
`h=0.75 → −7.0%` at ~1.15× fair hedge cost ($0.0227/mo) — `cvamm_heavy_results.json:29-56`.)

**Verbatim disclosure tone (mandatory — `depositor.py:44-48`, `spec.md:711`):**

> "You earn the volatility risk premium in calm markets and absorb losses in
> crashes. In FULL the pool cannot become insolvent and cannot be run, but YOUR
> CAPITAL IS NOT GUARANTEED."

Never call it "stable" or "modest APY." APY figures are gross of demand/competition/
fees and model-illustrative — present the **risk panel** as the robust part and lead
with the geometric 3y CAGR, never the arithmetic mean.

**Adversarial self-audit verdict: GO** (`HEAVY_CALIBRATION.md:83-98`) — a 6-agent
workflow independently re-ran the engine: no-bad-debt structural confirmed
(`max_payout_frac = 1.0`), infeasibility robust under heavier stress, measure split
correct (premium RN at σ_ref, payout real), model in fact **net-conservative** to
depositors (σ_ref floor 0.50 > calm vol 0.45 overcharges the 27% of calm months;
all-months payout/premium = 0.654).

---

## 7. Quick-reference summary

| Layer | Formula | Depends on | Where it lives |
| ----- | ------- | ---------- | -------------- |
| **IL** | `max(0, V_hold − V_lp)` | `Pa, Pb, L, P0, P_T` | `ILMath.sol` (prod) / `il.py` |
| **MaxIL** | `max(IL(Pa), IL(Pb))` | geometry only (`Pa,Pb,L,P0`) | `ILMath.sol` / `il.compute_max_il` |
| **fairRate** | `E_Q[min(IL,MaxIL)]/MaxIL` (exact Φ-sum) | `a=Pa/P0, b=Pb/P0, σ_ref, T` (L-independent) | Stylus `FairValueOracle` (prod) / `cvamm.fair_rate` |
| **FairPremium** | `fairRate · MaxIL` | the above | `FairValueOracle` |
| **σ_ref** | `max(σ_short, σ_long, floor)` | Chainlink log-return EWMAs | `VolOracle` / `prices.sigma_ref` |
| **premium** | `FairPremium·(1 + min(baseLoad+util+disp, maxLoad))` | + inventory state | `CvammPricing` lib / `cvamm.clamp_load` |

**Live deploy (Arbitrum Sepolia, chainId 421614, fresh redeploy 2026-06-05):**
Stylus FVO `0x98a6…d52c`, VolOracle `0xfdEa…5Ed9`, ConvexityVault `0xDE2f…c30d`,
ILMath `0x7e90…7bd2`, InflexionCore `0xC198…4848`, CvammPricing lib `0x4a05…2b53`.
dUSDC = 6 decimals (numéraire). Subgraph deploy pending (the on-chain moat dataset
begins at the redeploy that ships `SwapPriced`/`QuoteFilled`).
