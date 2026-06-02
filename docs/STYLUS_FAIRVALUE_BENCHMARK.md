# Latent sub-task — FairValueOracle Stylus(Rust) port + Stylus-vs-Solidity benchmark (P2.2, part 2)

> **Run this on the personal machine that has the Stylus toolchain + a Nitro fork.**
> The Windows dev box can't build Stylus (`native_keccak256` link error in
> `stylus-proc`), so this is split out from the P2.2 first part (the Solidity
> `FairValueOracle`, already committed and Python-verified).
>
> **Scope of part 1 (DONE, committed):** Solidity `FairValueOracle.sol` (exact
> Φ-sum) + `Gaussian.sol` (A&S erf) + `test/FairValueOracle.t.sol` (≡ Python
> `inflexion_quant.cvamm.fair_rate`, stated tolerance). **Scope of THIS task
> (latent):** the Rust/Stylus port, the gas+accuracy benchmark, and the ship
> decision.

## Why this exists (the precision finding from part 1)

The algebraic Φ-sum is **exact**; the only approximation in the Solidity impl is
the normal CDF `Φ`, done with **Abramowitz–Stegun 7.1.26** (`Gaussian.sol`,
erf abs error ~1.5e-7). Because `fairRate = E_Q[min(IL,MaxIL)] / MaxIL` divides by
`MaxIL`, the Φ error is **amplified by ~1/MaxIL**:

| width                | 1/MaxIL amplification | Solidity (A&S) abs error on fairRate | economic premium error |
| -------------------- | --------------------- | ------------------------------------ | ---------------------- |
| ±10%                 | ~70×                  | ~1.1e-5                              | ~$0.01 on $1,280 MaxIL |
| ±5%                  | ~4000×                | ~6.4e-4                              | ~$0.4                  |
| ±2% (0.05% fee tier) | ~8700×                | ~1.3e-3                              | ~$0.3 (small MaxIL)    |

Economically negligible everywhere, but **not machine-precision** — so the
"exact closed form" property is only fully realized with a higher-precision `Φ`.
That higher-precision erf is the crux of this benchmark.

## The task

1. **Port the exact Φ-sum to Rust/Stylus**, mirroring `FairValueOracle.fairRate`
   (normalised `P0=1, L=1`; the three arms below/inside/above with the
   `PcapL_eff = max(PcapL,0)`, `PcapR_eff = max(PcapR,b)` uniform formulas; the
   interval moments `M0/M1/Mh`). Keep the numéraire = token1 and `r = 0` (GBM)
   conventions — identical to `quant/il.py` / `inflexion_quant.cvamm`.
2. **Use a HIGH-PRECISION erf** in the Rust port (libm-grade, e.g. Cody/CALERF or
   `libm::erf`) so fairRate matches the Python closed form to **machine precision**
   (target ≤ 1e-12 absolute across the domain **including the tight ±2% / 0.05%
   fee tier**, not just ±5%+). This is what the Solidity A&S baseline cannot do.
3. **Benchmark on a Nitro fork:** for the 9-marketId grid (ETH/USDC × 3 fee tiers
   × 3 durations) + the asymmetric / tight cases, record per-call **gas** and
   **max-error-vs-Python** for BOTH impls:
   - Solidity baseline (this repo): exact Φ-sum + A&S erf. (Local Solidity gas:
     ~66k/`fairRate` call — confirm on the fork; refine with a dedicated gas test.)
   - Rust/Stylus: exact Φ-sum + high-precision erf.
     ILMath precedent (Task 2.12): Stylus ~25.5k cached vs Sol ~4.8k — Stylus was
     _more_ expensive for that tiny kernel. FairValueOracle is a **much larger
     kernel** (lnWad/expWad/erf × ~8 terms), so the amortization may flip — **that
     is the open question this benchmark answers.** Carry the honest number.
4. **Decide which ships** (the cheaper impl that meets the precision bar) and
   **keep the other as the CI cross-check oracle** (the Stylus≡Solidity≡Python
   discipline). If Solidity ships, either (a) accept the A&S stated tolerance
   (economically negligible) or (b) upgrade `Gaussian.sol` to a high-precision erf
   (Cody) so it meets the tight-range bar too.
5. **Wire the equivalence into CI** (P2.3): on-chain `fairRate` ≡ the Python
   closed form on the 9-marketId grid on local Nitro; the Python reference
   (`inflexion_quant.cvamm.fair_rate` + `il.py` MC) stays as the CI equivalence
   test.

## Reference points

- Solidity impl: `packages/contracts/src/FairValueOracle.sol`,
  `packages/contracts/src/libraries/Gaussian.sol`.
- Equivalence test + 42 Python fixtures:
  `packages/contracts/test/FairValueOracle.t.sol`.
- Python ground truth: `inflexion_quant.cvamm.fair_rate` (verified ≡ `il.py`
  quadrature ≡ MC to ~5e-11); regenerate fixtures with
  `inflexion_quant.cvamm` (see the deleted `_scratch_fairvalue_fixtures.py` logic
  in git history, or `cvamm.fair_rate(P0,Pa,Pb,L,sigma,T)`).
- σ_ref source: `VolOracle` (P2.1, committed) via `IVolOracle.sigmaRef`.

## Done-when (completes P2.2 + P2.3)

- Rust/Stylus `fairRate` ≡ Python to machine precision across the FULL domain
  (incl. tight); gas+accuracy benchmark recorded for both impls; ship decision
  documented; the non-shipped impl wired as the CI cross-check oracle.
- **The FULL no-bad-debt guarantee (I1) stays provably independent of this
  oracle** — FairValueOracle is Pillar-1 pricing, upstream of settle.
