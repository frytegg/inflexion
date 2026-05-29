# Inflexion — Math

The formulas the protocol enforces and the implementations that compute them.
This document is the **single reference** for anyone implementing or
porting the IL math — most importantly, the **Rust / Stylus `ILMath`
contract on the home PC**. The Solidity reference impl (`src/ILMath.sol`)
and the Python notebook (`quant/il.py`) already match this spec; any new
implementation MUST too.

---

## 0. Conventions

- **Prices.** `P` denotes `token1 / token0` (Uniswap convention).
  `sqrtP` denotes `sqrt(P)`. Q64.96 representation: `sqrtPriceX96 = sqrtP · 2^96`,
  stored as `uint160`.
- **Amounts.** Token amounts are in raw wei (each token uses its own `decimals()`).
- **Numéraire.** IL is computed in **token1 wei** — typically USDC for the
  hackathon. The off-chain SDK is responsible for choosing which side of
  a pool is the numéraire (governance picks at market registration via
  `MarketConfig.oracleToken`).
- **`L`** is uint128 Uniswap "liquidity units" — not token wei, not price.

---

## 1. IL derivation (spec §3.1)

Setup: an LP holds a Uniswap v3 position with liquidity `L` in price range
`[Pa, Pb]`. They created the swap when the price was `P0` (with `Pa ≤ P0 ≤ Pb`
enforced at `createSwap`). At expiry `T` the settlement price is `P_T`.

The protocol asks: _how much value did the LP lose vs simply holding their
entry tokens?_ — that's IL.

**Entry amounts** (Uniswap whitepaper §6.30, evaluated at `P0`):

```
amount0_entry = L · (1/√P0  − 1/√Pb)             // token0 wei
amount1_entry = L · (√P0    − √Pa)               // token1 wei
```

**Hold value at `P_T`** (had the LP simply held entry tokens, numéraire = token1):

```
V_hold(P_T) = amount0_entry · P_T + amount1_entry
```

**LP value at `P_T`** — three regimes:

| Regime                    | Condition       | `V_lp(P_T)`                    |
| ------------------------- | --------------- | ------------------------------ |
| in range                  | `Pa ≤ P_T ≤ Pb` | `L · (2·√P_T − √Pa − P_T/√Pb)` |
| below `Pa` (fully token0) | `P_T < Pa`      | `L · (1/√Pa − 1/√Pb) · P_T`    |
| above `Pb` (fully token1) | `P_T > Pb`      | `L · (√Pb − √Pa)`              |

**Realised IL**:

```
realised_IL(P_T) = max(0, V_hold(P_T) − V_lp(P_T))      // token1 wei
```

The `max(0, …)` clamp is **load-bearing** — it encodes invariants **I3**
(no underflow when `V_lp > V_hold`) and **I4** (LP never profits from the
swap). Any implementation that uses unchecked subtraction here is wrong.

---

## 2. MaxIL — the collateral unit + payout cap (spec §3.2)

```
MaxIL = max( IL(Pa), IL(Pb) )                            // boundary max
```

`MaxIL` is the maximum IL the position can realise **while price stays
within `[Pa, Pb]`**. The protocol uses it for two things:

- FULL-mode **collateral unit** — the MM locks `MaxIL` wei of USDC.
- Payout **cap** — `payout = min(realised_IL, MaxIL)`.

### Convexity proof (the reason `MaxIL` is just the boundary max)

> `V_hold(P) = amount0_entry · P + amount1_entry` is **affine** in `P`.
> In range, `V_lp(P) = L · (2√P − √Pa − P/√Pb)`, so
> `d²V_lp/dP² = −¼ · L · P^(−3/2) < 0` → `V_lp` is strictly **concave**
> in `P`. Therefore `IL(P) = V_hold(P) − V_lp(P)` is the difference of an
> affine and a concave function, i.e. **convex**; and `max(0, IL)` (a max
> of convex functions) is convex too. A convex function on a closed
> interval `[Pa, Pb]` attains its maximum at an endpoint. ∎

The proof holds for **any** entry — centred or asymmetric — which is why
two external auditors specifically asked us to fuzz `P0` near the
boundaries. We do, in `ILMath.t.sol::testFuzz_convexity_MaxILBoundsInteriorIL`.

### Above-range IL is unbounded (and we don't cover it)

Above `Pb` the LP is fully in token1 (constant value) while `V_hold` keeps
growing linearly with `P_T`. Absolute IL is **unbounded** beyond the range.
The cap `min(realised_IL, MaxIL)` is the entire reason FULL mode is
no-bad-debt: bounded payout against bounded collateral, regardless of
how far price moves.

**Pitch framing.** This is an **in-range convexity hedge**, not "IL
insurance". Past the range, the LP has fully rotated into one asset and
any further "loss" is directional (foregone spot upside), not the
_impermanent_ loss they set out to hedge. Re-cover after re-ranging.

---

## 3. Reference magnitudes

From the calibrated quant model (`quant/notebooks/03_path_to_il.ipynb`,
re-derived per refactor — _not_ trusted as static documentation):

| Range half-width      | `MaxIL / V0` |
| --------------------- | ------------ |
| ±5% (tight)           | ~1.2%        |
| ±10% (active LP)      | ~2.4%        |
| ±20% (passive)        | ~4.7%        |
| ±50% (wide / v2-like) | ~13.8%       |

The spec §3.2 placeholders (`±5%→0.3%`, `±10%→1.2%`) are **wrong** —
they are ~4× too low and were never re-derived. The above are the
empirical values from `compute_max_il(P0=100, Pa=P0·(1−h), Pb=P0·(1+h), L=1e18)`
across `h ∈ {0.05, 0.10, 0.20, 0.50}`. Tracked as a spec-update TODO.

---

## 4. Hand-calculated fixture (the cross-check baseline)

Position: `P0 = 100`, `Pa = 80`, `Pb = 125`, `L = 1e18` (ETH-scale).

| Quantity         | Expected                        | Source                       |
| ---------------- | ------------------------------- | ---------------------------- |
| `amount0_entry`  | `10_557_280_900_008_417` wei    | `quant/il.py::entry_amounts` |
| `amount1_entry`  | `1_055_728_090_000_841_200` wei | same                         |
| `IL(P_T = Pa)`   | `≈ 111.456 · 1e15` wei          | il.py                        |
| `IL(P_T = Pb)`   | `≈ 139.320 · 1e15` wei          | il.py                        |
| `MaxIL = IL(Pb)` | `139_320_225_002_101_320` wei   | il.py                        |

Solidity reference (`src/ILMath.sol`) matches these to **~10k wei out of
1.4e17** — eight significant decimal places. The Rust / Stylus impl
(Phase 2.2+) is expected to match the Solidity reference to **~1 wei**
under the cross-check test (ROADMAP Task 2.11).

Test fixtures:

- Python: `quant/tests/test_il.py::test_compute_max_il_*`
- Solidity: `packages/contracts/test/ILMath.t.sol::test_fixture_*`

---

## 5. Q64.96 implementation notes (for the Rust port)

### 5.1 Why Q64.96

Uniswap v3 uses Q64.96 throughout: `sqrtPriceX96 = sqrt(P) · 2^96` stored
as `uint160`. This keeps sqrt prices in a representable range
(`2^-128 ≤ P ≤ 2^128`) with enough fractional precision (96 bits) that
the inverse / multiplication operations don't catastrophically lose
significant digits. The same convention is the input to every formula
above.

### 5.2 The mulDiv split pattern

`amount0 = L · (sqrtPb − sqrtP) · 2^96 / (sqrtP · sqrtPb)` cannot be
computed naïvely: `sqrtP · sqrtPb` overflows `uint256` because two Q64.96
values fit in 160 bits each and 160 + 160 = 320 > 256. The implementation
splits the expression into three `mulDiv(a, b, c) = a · b / c` calls:

```
t1     = mulDiv(L,  sqrtPb − sqrtP,  2^96)
t2     = mulDiv(t1, 2^96,            sqrtP)
amount0 = mulDiv(t2, 2^96,            sqrtPb)
```

Each step keeps the intermediate inside `uint256`. The Rust impl MUST
use the same ordering (or one with identical rounding behaviour) — see
`ILMath._amountsAt` for the reference. The cross-check test pins agreement
to ~1 wei; any rounding divergence shows up there.

`amount1 = L · (sqrtP − sqrtPa) / 2^96` is a single `mulDiv` — no split
needed.

### 5.3 The three lp_value regimes

The Solidity / Stylus impl branches on `sqrtP_T < sqrtPa` / `sqrtP_T > sqrtPb` /
in-range. The boundary helpers `_amount0Boundary` / `_amount1Boundary`
compute the fully-rotated amounts directly so the in-range formula
isn't reused with `sqrtP_T = sqrtPa` (which would just give the same
result but with one extra mulDiv chain).

### 5.4 V_hold = amount0 · P_T + amount1

`amount0 · P_T = amount0 · sqrtP_T² / 2^192`. To avoid the `sqrtP_T²`
overflow, split:

```
v_hold_part1 = mulDiv( mulDiv(amount0, sqrtP_T, 2^96), sqrtP_T, 2^96 )
v_hold       = v_hold_part1 + amount1
```

This appears as `_amount0InToken1` in `ILMath.sol`.

---

## 6. `IILMath` interface — the contract surface

```solidity
function computeMaxIL(
    uint256 sqrtPriceX96,    // P0 at swap creation
    uint256 sqrtPaX96,       // lower-tick sqrt price
    uint256 sqrtPbX96,       // upper-tick sqrt price
    uint128 liquidity        // L stored once at creation (invariant I6)
) external returns (uint256 maxIL);

function computeIL(
    uint256 sqrtPriceTX96,   // settlement price
    uint256 sqrtPaX96,
    uint256 sqrtPbX96,
    uint128 liquidity,
    uint256 amount0Entry,    // snapshot at create
    uint256 amount1Entry
) external returns (uint256 ilAmount);
```

Notes for the implementer:

- Declared `non-view` in the interface (so the Solidity ref impl's
  `MockILMath` recorder for I6 testing can write storage). Production
  impls can still be effectively `pure` — Solidity allows a more-
  restrictive override, and `eth_call` works regardless.
- Return type is `uint256` (token1 wei). Caller (`InflexionCore`)
  downcasts to `uint128` for storage; ensure your impl never returns
  values exceeding `type(uint128).max` for sane inputs (test fixture
  shows `MaxIL ≈ 1.4e17` for `L = 1e18` — plenty of headroom).
- `sqrtPriceX96 ∈ [sqrtPaX96, sqrtPbX96]` is the spec precondition for
  `computeMaxIL`. The Solidity impl reverts (`PositionOutOfRange`) if
  violated; the Rust impl should match. `computeIL` accepts any
  `sqrtPriceTX96` (above-range and below-range are valid settlement
  states).

---

## 7. Gas benchmark (Task 2.12)

To be filled when the Rust / Stylus version exists and `forge snapshot`
ranks ILMath operations. The spec claims **~10×** gas reduction vs
Solidity for these compute-heavy fixed-point ops. We will measure and
update the pitch claim accordingly — under-promise rather than
over-claim if the actual ratio is lower.

| Operation                  | Solidity gas | Stylus gas | Ratio |
| -------------------------- | ------------ | ---------- | ----- |
| `computeMaxIL` (in range)  | _TBD_        | _TBD_      | _TBD_ |
| `computeIL` (in range)     | _TBD_        | _TBD_      | _TBD_ |
| `computeIL` (out of range) | _TBD_        | _TBD_      | _TBD_ |

---

## 8. What this document does NOT cover

- **Tick math** (`tick ↔ sqrtPrice`) — see `src/libraries/TickMath.sol`
  (byte-for-byte port of Uniswap v3-core to Solidity 0.8).
- **PARTIAL mode + Insurance Fund math** — spec §8 / §9, and
  `quant/src/inflexion_quant/`. PARTIAL is gated on the quant model,
  not Phase 1.
- **Oracle round-at-T pinning** — spec §6.1, `src/OracleManager.sol`.
- **Premium pricing model** — that's an MM concern, off-chain. Spec
  §3.3 sketches the rational MM's fair-value anchor; the protocol
  itself imposes no formula.
