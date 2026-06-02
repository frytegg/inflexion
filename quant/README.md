# Inflexion Quant Model

> **Gates cvAMM pricing.** Derives every pricing primitive the on-chain
> ConvexityVault (cvAMM) and FairValueOracle consume — `fairRate` surface,
> `baseLoad`, `maxLoadBps`, `util_skew`, `dispersion_skew`, `sigma_ref`
> windows — from fat-tailed, crash-correlated Monte Carlo. No constant the
> contracts read is ever guessed; all of them land in the `cvamm` block of
> `params.json` (see [`params.cvamm.schema.json`](params.cvamm.schema.json) and
> the work order in [`SPEC.md`](SPEC.md)).
>
> Also a flagship pitch artifact: _"we did not guess our risk parameters — we
> derived them under fat-tailed, crash-correlated stress, and we published the
> fair value on-chain."_

## Context: the cvAMM-FULL launch

The protocol pivoted from a pure MM quote-book to a **hybrid** that prices
Uniswap v3 impermanent-loss risk **on-chain**. The quant package's job is to
feed the on-chain pricing stack. Three pillars (see `../spec.md` §3.0):

1. **On-chain published FairValue.** The protocol computes
   `FairPremium = fairRate · MaxIL` on-chain via a `FairValueOracle`.
   `MaxIL` is pure geometry (frozen at creation, identical across durations);
   `fairRate = E_Q[min(IL, MaxIL)] / MaxIL` is an S-curve in `σ²·T` that
   carries **all** vol/time dependence. Theory anchors (cite, do not
   re-derive): Lipton–Lucic–Sepp 2025 (the IL-protection claim is statically
   replicable by a strip of vanilla options ⇒ priceable/hedgeable) and
   Milionis–Moallemi–Roughgarden 2022 (LVR — the AMM's adverse-selection cost —
   has a closed form ∝ instantaneous variance, i.e. the theta of the replicating
   short option ⇒ a closed-form anchor for short-gamma cost).
2. **The cvAMM (centrepiece, Path A).** A pooled passive underwriter
   (`ConvexityVault`, ERC-4626 over USDC) that quotes algorithmically on-chain
   off `FairPremium` with inventory skews and is contractually capped at
   `FairPremium·(1 + maxLoad)` by **invariant I10**.
3. **MM competition rail (Path B).** Sophisticated MMs compete via EIP-712
   signed quotes below the pool, exporting short-gamma risk out of the system
   and correcting the pool's backward-looking-σ bias. The pool is
   **floor-of-liquidity + ceiling-of-price**.

**Pricing formula (both paths, on-chain):**

```
premium = FairPremium · (1 + baseLoad + util_skew + dispersion_skew)
        clamped to FairPremium · (1 + maxLoadBps)          # I10, by construction
```

**Launch scope:** ONE pool, ETH/USDC, all 9 marketIds
(`marketId = keccak(token0, token1, fee, durationSeconds)` — 3 fee tiers × 3
durations of 7/30/90d), **FULL mode only** (collateral = 100% of MaxIL ⇒ no
bad debt under capped payoff + solvent USDC + oracle/settlement liveness).
PARTIAL is a **leverage dial** on the same pool, deferred to roadmap.

## Setup

```powershell
# From repo root, install uv if missing
python -m pip install --user uv

# Set up the quant project
cd quant
uv sync                              # creates .venv and installs deps
uv run jupyter lab notebooks/        # open notebooks in browser
```

`uv sync` reads `pyproject.toml`, creates `.venv` if missing, and installs all
project + dev dependencies. The `inflexion_quant` package is installed in
editable mode (`[tool.uv] package = true`), so changes to `src/` are picked up
immediately in notebooks.

## Layout

```
quant/
├── pyproject.toml              # project + dependency declaration (uv-managed)
├── README.md                   # this file — cvAMM-FULL launch + hybrid framing
├── SPEC.md                     # the quant work order: 10 cvAMM deliverables + methodology
├── params.json                 # SERIALIZED PARAMS — frozen this turn (pydantic, roundtrip-tested)
├── params.cvamm.schema.json    # PROPOSED cvAMM block schema (TODO/placeholder; lands in params.json at P1)
├── .python-version             # pinned: 3.12+
├── notebooks/                  # numbered notebooks — run in order
│   └── 01_underlying.ipynb
├── src/inflexion_quant/        # importable helpers (IL math, simulators, etc.)
│   ├── il.py                   # cvAMM-launch: Python mirror of the Stylus ILMath contract
│   ├── prices.py               # cvAMM-launch: gbm_paths(μ=0) risk-neutral engine + (P1) σ_ref EWMA helper
│   ├── positions.py            # cvAMM-launch: geometry sampling primitives (width × distance-to-edge × T)
│   ├── portfolio.py            # LEGACY-PARTIAL: waterfall (MM collateral + insurance fund tail)
│   ├── stress.py               # LEGACY-PARTIAL: fund-solvency stress harness (also reused for hedge/tranche sizing)
│   ├── calibrate.py            # LEGACY-PARTIAL: the 8 PARTIAL parameters (kernel reusable)
│   ├── deck_charts.py          # LEGACY-PARTIAL: the 3 PARTIAL pitch charts
│   ├── params.py               # pydantic v2 schema for params.json — FROZEN this turn
│   ├── data.py                 # historical/synthetic price data
│   └── __init__.py
└── legacy/                     # (P1) home for the moved PARTIAL stack — see legacy/README.md
    └── README.md               # index of preserved PARTIAL outputs (this turn: doc only, no .py moved)
```

> **This turn is documentation-only.** No `.py` file is edited and
> `params.json` / `params.py` are left byte-for-byte unchanged (they are
> `extra='forbid'` pydantic + roundtrip-tested at schema `2.0.0`; editing them
> would break CI). The PARTIAL modules listed as `LEGACY-PARTIAL` above are
> **logically** legacy now; the physical move into `quant/legacy/` is a P1
> refactor task. See [`legacy/README.md`](legacy/README.md) for the index.

## The 10 cvAMM deliverables → which module each builds on

The single source of truth for IL/MaxIL math is `il.py` — it already
reproduces the authoritative geometry numbers exactly (geometric symmetric
MaxIL/V0: ±5% = 1.27%, ±10% = 2.56%, ±20% = 5.23%, ±50% = 13.76%). The
prototype `_scratch_cvamm_sim.py` grounds deliverables 1–3 against `il.py` and
will be promoted into a new committed `cvamm.py` module in P1.

| #   | Deliverable                                                                                    | Builds on (existing module)                                                                                                                                                           | Status                 |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | **FairPremium surface** `fairRate(width, distance-to-edge, T, σ)` + straddle-theta cross-check | `il.py` (`compute_max_il`/`compute_payout`) + `prices.gbm_paths(μ=0)` + the vectorised kernel from `calibrate.py` swept over the 9-marketId geometry grid (`positions.py` primitives) | P1, NEW `cvamm.py`     |
| 2   | **`sigma_ref`** = `max(σ_short, σ_long, floor)`, EWMA of log-returns                           | `prices.py` — ADD an EWMA realized-vol helper (consumed on-chain by VolOracle)                                                                                                        | P1, MODIFY `prices.py` |
| 3   | **`baseLoad`** = vol-risk-premium / lone-writer-CVaR-vs-diversified gap                        | the scratch sim's lone-writer CVaR95 (≈91–100% of MaxIL) vs diversified-N CVaR (→78.7% as N:1→100)                                                                                    | P1, NEW `cvamm.py`     |
| 4   | **`util_skew(locked/(locked+free))`** curve                                                    | NEW — single-asset book; wires into the withdrawal-delay / locked-free defense                                                                                                        | P1, NEW `cvamm.py`     |
| 5   | **`dispersion_skew`** + concentration metric                                                   | NEW — single-asset analogue of concentration (coverage clustered in one width/moneyness/duration corner)                                                                              | P1, NEW `cvamm.py`     |
| 6   | **`maxLoadBps`** (by width × duration) — the I10 cap                                           | NEW config — clamp enforcing `baseLoad + util_skew + dispersion_skew ≤ maxLoad`                                                                                                       | P1, NEW config         |
| 7   | **Productive-collateral SAFE CAP** (idle-only, instantly-redeemable)                           | `IYieldAdapter` contract constraint (compliant form only) — FLAG: Aave-for-locked is BLOCKED                                                                                          | ROADMAP                |
| 8   | **Pool-level hedge fraction** (APY/tail tradeoff)                                              | `legacy/stress.py` real-measure crash sims + `var_cvar`                                                                                                                               | ROADMAP                |
| 9   | **Senior/Junior tranche cut point**                                                            | `legacy/portfolio.py` fund-pays distribution + `legacy/stress.py` `var_cvar`                                                                                                          | ROADMAP                |
| 10  | **Real single-asset ETH depositor disclosure numbers**                                         | NEW depositor loss distribution (reuses `legacy/stress.py` `var_cvar` / `ruin_probability`)                                                                                           | P1, NEW `cvamm.py`     |

## The no-hardcoded-constants rule (CLAUDE.md invariant 6)

**Every cvAMM pricing primitive is produced here and read by the contracts
from `params.json`.** Hardcoding any of `fairRate` curve coefficients,
`baseLoad`, `maxLoadBps`, `util_skew`, `dispersion_skew`, the `sigma_ref` floor
or EWMA halflives, the productive-collateral cap, the pool-hedge fraction, or
the tranche cut in Solidity/Rust is a **bug** — it is the exact failure the
external audit flagged. Provenance is tracked per-field in `params.json`'s
`parameter_provenance` map.

Because `params.json` and `params.py` are frozen this turn, the proposed
`cvamm` block is **documented** in
[`params.cvamm.schema.json`](params.cvamm.schema.json) with placeholder values.
It is wired into the pydantic schema (with a minor `schema_version` bump) and
populated by a calibration run in **P1**, not now.

## Legacy: the PARTIAL study

The full PARTIAL stack (`portfolio.py` waterfall, `stress.py` solvency harness,
`calibrate.py` 8-parameter calibration, `deck_charts.py`, and the serialized
`params.json` outputs `c_min = 7.25%`, `fund_target ≈ $74k`, `fee_curve`,
`exposure_caps`, `breakers`, `first_loss`) targeted the **multi-asset PARTIAL**
design, which the launch defers. Those outputs are **preserved, not deleted** —
they seed the PARTIAL roadmap (leverage dial) and the senior/junior tranche +
pool-hedge sizing. See [`legacy/README.md`](legacy/README.md) for the index and
what each output is reused for.

> The earlier multi-asset depositor figures are **materially optimistic for one
> pair**. The cvAMM-FULL launch needs a **single-asset** ETH calibration
> (deliverable 10); the old numbers are placeholders only.
