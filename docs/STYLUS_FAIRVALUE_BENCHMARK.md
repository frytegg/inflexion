# FairValueOracle — Stylus vs Solidity benchmark + ship decision (P2.2 part 2)

> **Status: DONE.** Stylus port built, benchmarked on a local Nitro node, and
> chosen for ship. This doc is the authoritative record of the float-point
> constraint, the machine-precision integer implementation, the gas-optimization
> waterfall, and the verdict.

## TL;DR / verdict

- **Stylus bans WASM floating point** (verified empirically — activation rejects
  `f64`). So the Rust port uses **integer fixed-point** (SCALE = 1e24), not `libm`.
- The integer port matches the Python closed form (`inflexion_quant.cvamm.fair_rate`,
  itself ≡ a mpmath 50-digit reference) to **machine precision** — worst
  `|fairRate − truth| = 6.7e-15` across the 9-marketId grid incl. the tight ±2% /
  0.05%-fee tier. The shipped **Solidity** impl (Abramowitz–Stegun erf) is only
  accurate to **1.3e-3 at the tight tier** (the "exact closed form" property is not
  fully realized in Solidity).
- After a deep gas-optimization pass, the Stylus `fairRate` costs **~58k gas mean**
  vs Solidity's ~54k — **1.08×**, and is **cheaper than Solidity for the common
  tight/±10% geometries**. Down from a naïve 463k (8×). The **shipped** contract is
  a complete drop-in `IFairValueOracle` (`fairRate` / `fairRateFromPrices` /
  `fairPremium` / `volOracle` / `init`): adding `fairPremium` (a cross-contract
  STATICCALL to `VolOracle.sigmaRef` + `·MaxIL`) pushed the binary to 27.8 KB, over
  the 24 KB Stylus cap, so `#[inline(always)]` was relaxed to `#[inline]` — back to
  **21.7 KB** at a cost of only **~1.6k gas** (`fairRate` → **59.6k, 1.11×**).
  `fairPremium` verified on Nitro (premium / fairRate / σ all exact). Core points
  at this contract via `setCvamm` — no core change (same ABI/selectors).
- **Decision: SHIP STYLUS** as the production `FairValueOracle`. It is
  machine-precise (Solidity is not), at gas parity, and an Arbitrum-native Stylus
  showcase for the buildathon. Solidity is kept as the CI cross-check oracle.

---

## 1. The floating-point constraint (why integer fixed-point)

The plan was "Stylus hits machine precision via `libm` (f64); Solidity can't." That
premise is **false on Stylus**. A minimal contract using `f64` + `libm::erf`
compiles to WASM fine but **fails activation**:

```
program activation failed: failed to build user module
Caused by: No implementation for floating point operation
           ConvertIntOp(F64, I64, true) in user   (prover/src/wavm.rs:1000)
```

This is a determinism constraint of the Arbitrum fraud-proof WAVM and is not
expected to change (confirmed against the stylus-sdk-rs README and
[nitro#2710](https://github.com/OffchainLabs/nitro/issues/2710)). `libm` itself
emits `f64` ops, so it is out too.

**Consequence:** machine precision must come from an **integer fixed-point** erf,
which is implementable in either language — so the precision advantage is NOT
inherent to Stylus; it comes from spending the ops on a high-precision algorithm.
The real differentiator is therefore **gas**, which the benchmark below settles.

## 2. Implementation (`packages/contracts/stylus/FairValueOracle/`)

Same exact Φ-sum as `src/FairValueOracle.sol` and `inflexion_quant.cvamm.fair_rate`
(the capped v3 payoff integrated against the lognormal density), in **1e24 fixed
point** on `I256`:

| Primitive      | Method                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exp`          | argument-reduce by ln2, Taylor on the remainder, scale by 2^k                                                                                                          |
| `ln`           | normalise mantissa to [1,2), atanh series                                                                                                                              |
| `sqrt`         | Newton (U256)                                                                                                                                                          |
| `erf` (t ≤ 2)  | Maclaurin series — **exact**, handles the high-amplification tight tier                                                                                                |
| `erfc` (t > 2) | **Cody/Clenshaw rational**: `erfc = P(1/t²)·exp(−t²)/t`, `P` a degree-15 Chebyshev polynomial evaluated by Clenshaw recurrence (no per-term division, no cancellation) |
| `Φ(d)`         | `½·erfc(−d/√2)`, assembled to keep both terms un-saturated                                                                                                             |

Why **SCALE = 1e24** (not 1e36): every intermediate product fits U256
(max 2^167 ≪ 2^256), so multiplies are 256-bit, not 512-bit — and 1e24 still leaves
~4 orders of margin inside the 1e-12 bar. The precision-critical tight tier uses
small `d` (narrow range ⇒ small `ln`), where the exact Taylor `erf` is both cheap
and full-precision; the Cody rational is used only on the wide/asymmetric tail
(t > 2), which is low-amplification (large MaxIL) so ~1e-13 relative suffices.

The algorithm was prototyped and validated in
`quant/_scratch_fairvalue_fp2.py` (Python big-ints simulating U256, truncate-toward-
zero to match Rust) against the mpmath 50-digit reference
`quant/_scratch_fairvalue_hp_reference.py` **before** the Rust transliteration, so
the Rust is a mechanical port of a verified integer algorithm.

## 3. Accuracy (machine precision vs A&S)

`fairRate` error vs the mpmath 50-digit ground truth, on-node:

| Impl       | erf method                             | worst `\|fairRate − truth\|` (all geom) | tight ±2% tier    |
| ---------- | -------------------------------------- | --------------------------------------- | ----------------- |
| **Stylus** | integer fixed-point (Taylor + Cody)    | **6.7e-15**                             | **0** (wei-exact) |
| Solidity   | Abramowitz–Stegun 7.1.26 (~1.5e-7 erf) | ~1.3e-3                                 | 1.3e-3            |

The Solidity error is the A&S erf (~1.5e-7) amplified by `1/MaxIL` (~1e4 at the
tight tier). It is economically negligible (< ~$0.5 on a small-MaxIL position) but
it is **not** machine precision — so the "exact closed form" claim is only fully
true for the Stylus impl. The f64 Python fixtures themselves carry up to 1.4e-12 at
the tight tier, which is why the Stylus port is validated against the **mpmath HP**
values, not the f64 fixtures.

## 4. Gas (local Nitro, cached, warm) + optimization waterfall

`fairRate` gas, mean over the 10-fixture grid (ETH/USDC × width × duration × σ,
incl. tight/asym/wide). Solidity ≈ **53.7k** (flat).

| Stage                                   | Stylus mean | ratio     | what changed                                                                          |
| --------------------------------------- | ----------- | --------- | ------------------------------------------------------------------------------------- |
| Naïve                                   | 463k        | 8.6×      | 1e36 scale, U512 mul-div, fixed 80-iter continued fraction, opt-level "z"             |
| + 1e24/U256, adaptive CF, memoised `ln` | 146k        | 2.72×     | drop 512-bit math; ~3× fewer ops; `iln` 16→4 calls                                    |
| + `opt-level=3`, `#[inline(always)]`    | 66k         | 1.23×     | fewer WASM opcodes (unroll + no call overhead)                                        |
| + Cody/Clenshaw erfc                    | 62k         | 1.16×     | replace the iterative CF (~108 divisions) on the tail with a rational (asym 104k→61k) |
| **+ erf division-fold**                 | **57.9k**   | **1.08×** | one variable-divisor division per erf term instead of two                             |

Per-geometry at the final stage, **Stylus is cheaper than Solidity** for ±10%
(0.88–0.96×), tight ±2% (0.89×), ±5%/±35% (1.00×); only the wide ±20–50% and
asymmetric cases are 1.1–1.35× (the mean is dragged by those).

### Techniques that mattered (sourced)

- **Division is ~8× a multiply** in Stylus ink (`I64DivU` 1270 vs `I64Mul` 160) —
  eliminating 256-bit and series divisions is the dominant lever
  ([opcode pricing](https://docs.arbitrum.io/stylus/reference/opcode-hostio-pricing)).
- **`opt-level=3` + `#[inline(always)]`** on hot helpers: the largest single jump
  (146k→66k). Mirrors the OpenZeppelin Poseidon waterfall (inlining −38%,
  unrolling −39%)
  ([OZ Poseidon](https://www.openzeppelin.com/news/poseidon-go-brr-with-stylus-cryptographic-functions-are-18x-more-gas-efficient-via-rust-on-arbitrum)).
- **Avoid U512 / byte-copy widening**: SCALE=1e24 keeps everything in U256.
- **Rational (Clenshaw) instead of iterative** for the erfc tail: trades ~108
  divisions for ~17 muls + 2 divisions + 1 exp.
- **ArbOS caching** (`cargo stylus cache bid`) for the steady-state per-call cost.
- `wasm-opt -O4` was tried and gave **no** improvement here (cargo-stylus's
  `opt-level=3` + fat-LTO already captured it) and slightly grew the compressed
  size, so it is not in the pipeline.

Binary size is **23.6 KB** compressed (under the 24 KB Stylus cap).

## 5. Reproduce

```bash
# 1. host-side machine-precision proof (no node):
cd packages/contracts/stylus/FairValueOracle && cargo test   # 8 tests, worst 6712 wei

# 2. on-node gas + accuracy (needs a local Nitro dev node + funded key):
cargo stylus deploy --endpoint $LOCAL_RPC --private-key $DEPLOYER_PRIVATE_KEY --no-verify
cargo stylus cache bid --endpoint $LOCAL_RPC --private-key $DEPLOYER_PRIVATE_KEY <addr> 0
cd ../../ && STYLUS_FVO=<addr> DEPLOYER_PRIVATE_KEY=… LOCAL_RPC=… \
  node script/fairvalue-bench.mjs           # deploys Solidity FVO + FairValueProbe, prints the table

# 3. regenerate the mpmath HP fixtures / re-validate the algorithm:
quant/.venv/Scripts/python.exe quant/_scratch_fairvalue_hp_reference.py   # -> src/fixtures_hp.rs
quant/.venv/Scripts/python.exe quant/_scratch_fairvalue_fp2.py            # scale/precision/op-count sweep
```

The Python closed form (`inflexion_quant.cvamm.fair_rate` + `il.py` MC) is the CI
cross-check oracle; the Rust host test pins Stylus ≡ that closed form (≡ mpmath) to
machine precision; `script/fairvalue-bench.mjs` is the on-node Stylus ≡ Solidity ≡
truth cross-check (run against a Nitro fork in CI).

## 6. Sources

- Float ban: stylus-sdk-rs README; [nitro#2710](https://github.com/OffchainLabs/nitro/issues/2710); WAVM SoftFloat (prover-only).
- Gas model: [ink/opcode pricing](https://docs.arbitrum.io/stylus/reference/opcode-hostio-pricing), [gas metering](https://docs.arbitrum.io/stylus/concepts/gas-metering), [optimizing binaries](https://docs.arbitrum.io/stylus/how-tos/optimizing-binaries), [caching](https://docs.arbitrum.io/stylus/how-tos/caching-contracts).
- Optimization case studies: [OZ Poseidon](https://www.openzeppelin.com/news/poseidon-go-brr-with-stylus-cryptographic-functions-are-18x-more-gas-efficient-via-rust-on-arbitrum), [Superposition lessons](https://medium.com/@Superpositionso/stylus-lessons-learned-road-to-superposition-7035fea4432c), [LimeChain benchmark](https://github.com/LimeChain/stylus-benchmark).
- erf/erfc methods: W. J. Cody 1969, Rational Chebyshev Approximations for the Error Function; libm `erf.rs`. (We fit our own Chebyshev coeffs via mpmath rather than transcribing f64 constants, to keep 1e24-grade precision.)
