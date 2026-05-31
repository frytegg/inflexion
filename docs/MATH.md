# Inflexion — Math

Derivation and reference values for the IL / MaxIL math implemented in
`ILMath` (Stylus/Rust, `packages/contracts/stylus/ILMath`) and its Solidity
reference twin (`packages/contracts/src/ILMath.sol`). The two implementations
use the **same `mulDiv` chain and floor rounding**, so they agree to the wei by
construction (Task 2.11 cross-check).

Spec source: [`spec.md`](../spec.md) §3.1 (IL formula) and §3.2 (MaxIL = the
collateral unit and the coverage cap).

---

## 1. IL formula — Uniswap v3 (spec §3.1)

Let price `P` = price of token0 in token1 (e.g. ETH in USDC). A position is
liquidity `L` over range `[Pa, Pb]`, entered at `P0` with `Pa ≤ P0 ≤ Pb`. All
entry quantities are snapshotted **at swap creation**, and `L` is stored once
and never re-read at settlement (invariant I6).

**Entry token amounts** (`P0` in range):

```
amount0_entry = L · (1/√P0 − 1/√Pb)
amount1_entry = L · (√P0 − √Pa)
```

**Hold value** at settlement price `P_T`, numéraire = token1:

```
V_hold(P_T) = amount0_entry · P_T + amount1_entry
```

This is the value of simply _holding_ the entry basket — it is **affine in
`P_T`** (a straight line).

**LP value** at `P_T` — three regimes:

```
in range  (Pa ≤ P_T ≤ Pb):
    x = L · (1/√P_T − 1/√Pb);   y = L · (√P_T − √Pa)
    V_lp(P_T) = x · P_T + y = L · (2√P_T − √Pa − P_T/√Pb)
below Pa  (P_T < Pa, position fully token0):
    V_lp(P_T) = L · (1/√Pa − 1/√Pb) · P_T          ← linear in P_T
above Pb  (P_T > Pb, position fully token1):
    V_lp(P_T) = L · (√Pb − √Pa)                     ← constant in P_T
```

**Realized IL** (the quantity the protocol settles), in token1 wei:

```
realized_IL = max(0, V_hold(P_T) − V_lp(P_T))
```

The `max(0, ·)` is invariant **I3**: the subtraction is guarded, never an
unchecked underflow. At `P_T = P0`, `V_hold = V_lp`, so `realized_IL = 0` (no
drift ⇒ no loss).

---

## 2. MaxIL = max(IL(Pa), IL(Pb)) — convexity proof (spec §3.2)

`IL(P) = V_hold(P) − V_lp(P)` is **convex on `[Pa, Pb]`**, so its maximum
_while price stays in range_ is attained at a boundary:

> **Proof.** `V_hold(P) = amount0_entry · P + amount1_entry` is affine in `P`.
> In range, `V_lp(P) = L(2√P − √Pa − P/√Pb)`, so
>
> ```
> dV_lp/dP   =  L(P^(−1/2) − 1/√Pb)
> d²V_lp/dP² = −¼ · L · P^(−3/2)  < 0   for all P > 0
> ```
>
> Therefore `V_lp` is **strictly concave**. `IL = V_hold − V_lp =
affine − concave` is **convex**, and `max(0, IL)` — a pointwise max of two
> convex functions — is convex as well. A convex function on a compact
> interval `[Pa, Pb]` attains its maximum at an endpoint. ∎

This holds for **any** entry `P0`, centered or not. (Two external auditors
flagged the asymmetric case; one re-derived and confirmed it. The
`fuzz_asymmetric_entry_maxil` property test samples highly asymmetric `P0`
near `Pa`/`Pb` to be sure.)

```
MaxIL = max( IL(Pa), IL(Pb) )      ← maximum in-range IL
```

### Why the cap is load-bearing

MaxIL is **not** the global worst case. Above `Pb` the LP is fully in token1
(`V_lp` constant) while `V_hold` grows linearly with price, so absolute IL is
**unbounded** beyond the range. The protocol therefore covers

```
covered_payoff = min(realized_IL, MaxIL)
```

Because `collateral_FULL = MaxIL` and `covered_payoff ≤ MaxIL` _by
construction of the cap_, FULL mode cannot produce bad debt under any price
path (invariants I1, I2). This is the in-range convexity hedge — not "IL
insurance"; the cap is the no-bad-debt guarantee, not a defect.

---

## 3. Fixed-point implementation (Q64.96)

All sqrt prices are Uniswap **Q64.96**: `sqrtPriceX96 = floor(√P · 2^96)`,
with `Q96 = 2^96`. The formulas above are evaluated entirely in integer math:

| Primitive           | Definition                                     | Notes                                                                                                            |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mul_div(a,b,d)`    | `floor(a · b / d)` with a 512-bit intermediate | OZ `Math.mulDiv` / Uniswap `FullMath` equivalent. `L · sqrtP` can reach 2^288, so the wide product is mandatory. |
| `integer_sqrt(n)`   | `floor(√n)` via Newton's method                | Exact for all `n`; matches OZ `Math.sqrt`.                                                                       |
| `sqrt_price_x96(P)` | `integer_sqrt(P << 192)`                       | `= floor(√P · 2^96)`.                                                                                            |

Position amounts (whitepaper §6.30), all via `mul_div`:

```
t       = mulDiv(L, sqrtPb − sqrtP, Q96)
t       = mulDiv(t, Q96, sqrtP)
amount0 = mulDiv(t, Q96, sqrtPb)
amount1 = mulDiv(L, sqrtP − sqrtPa, Q96)
```

Converting token0 wei to token1 wei at a price: `amount0 · (sqrtP / 2^96)²`,
computed as two chained `mulDiv`s by `Q96`. Floor rounding everywhere makes
the result deterministic and reproducible across Rust and Solidity.

---

## 4. Reference magnitudes

Regenerated from the `ILMath` test suite — **not trusted as-is** (spec §3.2).
Fixture: `P0 = 100`, `Pa = 80`, `Pb = 125`, `L = 1e18`, prices as token1 per
token0. These values are asserted by `amounts_fixture_matches_python` and
`maxil_fixture_matches_python` (and mirrored by `ILMath.t.sol`).

| Quantity        | Value (wei, integer)        | ≈ (× 1e18) |
| --------------- | --------------------------- | ---------- |
| `amount0_entry` | `10_557_280_900_008_417`    | 0.01055728 |
| `amount1_entry` | `1_055_728_090_000_841_200` | 1.05572809 |
| `V_hold(P0)`    | `2_111_456_180_001_682_900` | 2.11145618 |
| `IL(Pa = 80)`   | `≈ 1.11456e17`              | 0.111456   |
| `IL(Pb = 125)`  | `139_320_225_002_101_320`   | 0.13932023 |
| **MaxIL**       | `139_320_225_002_101_320`   | 0.13932023 |

`MaxIL = IL(Pb) > IL(Pa)`: although the range `[80, 125]` is symmetric in
_ratio_ (−20% / +25% around 100), the convex IL curve is larger toward the
upper boundary — exactly the asymmetry the proof predicts. Here
`MaxIL / V_hold(P0) ≈ 6.6%`.

Spec ballpark for **centered** ranges (to be regenerated by the quant
notebook, `quant/`, not hardcoded):

```
±5%  range → MaxIL ≈ 0.3% of V0
±10% range → MaxIL ≈ 1.2% of V0
±20% range → MaxIL ≈ 4.8% of V0
±50% range → MaxIL ≈ 25%  of V0
```

---

## 5. Worked example (fixture `[80, 100, 125]`, `L = 1e18`)

1. **Sqrt prices.** `sqrtP0 = √100 · 2^96 = 10 · 2^96` (exact, perfect
   square); `sqrtPa = floor(√80 · 2^96)`, `sqrtPb = floor(√125 · 2^96)`.
2. **Entry amounts at `P0`** → `amount0_entry = 10_557_280_900_008_417`,
   `amount1_entry = 1_055_728_090_000_841_200`.
3. **At `P_T = P0`**: `V_lp = V_hold` ⇒ `realized_IL = 0` (asserted within
   ≤ 100 wei by `il_in_range_at_entry_is_zero`).
4. **IL at the boundaries**, reusing the entry amounts:
   - `IL(Pa)` ≈ `1.11456e17` (price fell to 80, position rotated toward
     token0).
   - `IL(Pb)` = `139_320_225_002_101_320` (price rose to 125, position
     rotated toward token1).
5. **MaxIL** = `max(IL(Pa), IL(Pb))` = `IL(Pb)` =
   `139_320_225_002_101_320` ≈ 6.6% of `V_hold(P0)`. This is the FULL-mode
   collateral the MM locks, and the cap on the LP's payout.

---

## 6. Test coverage

`packages/contracts/stylus/ILMath/src/math.rs` (`#[cfg(test)]`, host-only):

- **Primitives (Task 2.2)** — `mul_div` (u128 domain + 512-bit wide product),
  `integer_sqrt` (`s² ≤ n < (s+1)²`), `abs_diff`, each fuzzed **10 000×**
  against a `num-bigint` arbitrary-precision oracle.
- **MaxIL (Task 2.4)** — 8 cases: Python fixture match, boundary-max identity,
  upward/downward asymmetry dominance, linearity in `L`, out-of-range ⇒ revert,
  tight-vs-wide ordering.
- **`computeIL` regimes (Tasks 2.5–2.7)** — in-range (entry-zero, signed moves,
  interior ≤ MaxIL, monotone away from entry, linear in `L`), below-Pa (linear
  `V_lp`, boundary continuity), above-Pb (constant `V_lp`, boundary
  continuity).
- **Fuzz (Tasks 2.8–2.9)** — cap holds in range (convexity), and
  `MaxIL = max(IL(Pa), IL(Pb))` for any valid asymmetric entry, **2 000×** each.

> **Gas benchmark (Task 2.12) — deferred.** The Stylus-vs-Solidity gas
> comparison and the on-chain integration cross-check (Task 2.11) require a
> live Nitro dev-node deploy (Group C), tracked in `ROADMAP.md` Phase 2. This
> document is updated with the measured `computeMaxIL` / `computeIL` gas once
> that lands.
