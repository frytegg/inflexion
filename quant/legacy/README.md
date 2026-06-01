# Legacy — the PARTIAL study (preserved, not deleted)

> **This is an index, not a move.** This turn is documentation-only. The
> PARTIAL-specific modules still live at `quant/src/inflexion_quant/` and their
> outputs in `quant/params.json`. The **physical move** of the `.py` files into
> `quant/legacy/` (with their tests) is a **P1 refactor task** — do **not** move
> or delete any `.py` file now. This README records which modules and which
> serialized outputs are **legacy-PARTIAL** vs **cvAMM-launch**, and what each
> preserved output is reused for.

## Why these are legacy

The launch pivoted to the **cvAMM-FULL** design (one pooled ERC-4626
ConvexityVault, collateral = 100% of MaxIL, on-chain published FairPremium).
The PARTIAL study targeted the **multi-asset** design where an MM posts a
fraction `c` of V0 and an Insurance Fund reinsures the `(IL − c·V0)⁺` tail.
That design is **deferred to roadmap** (PARTIAL is now a _leverage dial_ on the
same ConvexityVault, not a separate pool). Its outputs are **preserved** because
they seed:

- the **PARTIAL roadmap** (the leverage dial: collateral < MaxIL + buffer), and
- the **senior/junior tranche** cut-point sizing (cvAMM deliverable 9), and
- the **pool-level hedge fraction** sizing (cvAMM deliverable 8),

all of which need real-measure crash sims that this stack already implements.

## Module classification

| Module                      | Class              | Disposition                                                                                                                                                                                               |
| --------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `il.py`                     | **cvAMM-launch**   | KEEP at `src/`. The single source of truth for IL/MaxIL; reproduces the authoritative geometry numbers. Not legacy.                                                                                       |
| `prices.py`                 | **cvAMM-launch**   | KEEP at `src/`. `gbm_paths(μ=0)` is the risk-neutral pricing engine; gains the `sigma_ref` EWMA helper (P1). Kou/common-factor/bootstrap stay (used by the legacy stress + roadmap hedge/tranche sims).   |
| `positions.py`              | **cvAMM-launch**   | KEEP at `src/`. Geometry sampling primitives are reused for the 9-marketId width × distance-to-edge grid. The `crypto_majors()` mix is the legacy-PARTIAL stress book.                                    |
| `data.py`                   | **shared**         | KEEP at `src/`. Historical/synthetic returns feed both the cvAMM backtest and the legacy stress.                                                                                                          |
| `portfolio.py`              | **legacy-PARTIAL** | → `quant/legacy/` (P1). The `c`-waterfall (`mm_pays = min(payout, c·V0)`, `fund_pays = (payout − c·V0)⁺`) has no cvAMM-FULL analogue. Reused for tranche/hedge sizing.                                    |
| `stress.py`                 | **legacy-PARTIAL** | → `quant/legacy/` (P1). Fund-solvency stress harness. `var_cvar` / `ruin_probability` are **re-imported** by the new cvAMM depositor-disclosure module (deliverable 10) and the hedge/tranche sims (8/9). |
| `calibrate.py`              | **legacy-PARTIAL** | → `quant/legacy/` (P1). Calibrates the 8 PARTIAL params. **EXTRACT** the vectorised payout/MaxIL kernel (`_vectorised_payouts_and_maxils`) into the new `cvamm.py` surface engine before/while moving.    |
| `deck_charts.py`            | **legacy-PARTIAL** | → `quant/legacy/` (P1). The 3 PARTIAL pitch charts. New cvAMM charts (fairRate S-curve, overcharge gap, depositor loss distribution) are separate renderers; copy `DECK_STYLE`/palette.                   |
| `params.py` / `params.json` | **frozen**         | Stay at `quant/`. Pydantic `extra='forbid'` + byte-identical roundtrip test at schema `2.0.0`. **Do NOT edit this turn.** The `cvamm` block is added in P1 with a minor `schema_version` bump.            |

## Preserved PARTIAL outputs (in `quant/params.json`, schema 2.0.0)

These are the calibrated multi-asset PARTIAL constants. They remain valid for
the PARTIAL roadmap and are reused for tranche/hedge sizing as noted.

| Output                     | Value (calibrated)                                          | Reused for                                                                                                     |
| -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `c_min`                    | 0.0725 (7.25%)                                              | PARTIAL leverage-dial floor; reference for the senior/junior cut point.                                        |
| `floor_curve`              | `c_at_baseline_vol` = 0.0725 (single-vol; multi-σ deferred) | PARTIAL multi-σ floor; informs `util_skew` knee shape (single-asset re-fit needed).                            |
| `fee_curve`                | exponent 2.32, `c_ref` 0.2 (the audit-flagged leverage tax) | PARTIAL only — **not** a cvAMM primitive (the cvAMM load is `baseLoad`+skews, not a leverage tax).             |
| `fund_target`              | ≈ $74,038 (CVaR estimator)                                  | PARTIAL Insurance Fund sizing; reference for first-loss / junior-tranche size.                                 |
| `exposure_caps`            | per-market 700, per-MM 140, 5 MMs/market                    | PARTIAL exposure caps; reference for per-market notional caps + dispersion calibration.                        |
| `breakers`                 | L0 1.0 / L1 0.7 / L2 0.4 / L3 0.0 (heuristic)               | PARTIAL circuit breakers; roadmap.                                                                             |
| `first_loss_fraction`      | 0.02 (heuristic)                                            | MM first-loss stake; reference for the junior-tranche first-loss size.                                         |
| `withdrawal_delay_seconds` | 604800 (7d, heuristic)                                      | Carries to the cvAMM directly — the locked/free + withdrawal-delay defense is shared (the pool cannot be run). |

> ⚠️ **The multi-asset depositor figures are materially optimistic for one
> pair.** The cvAMM-FULL launch needs a **single-asset** ETH calibration
> (cvAMM deliverable 10). Do not reuse the multi-asset disclosure numbers as
> single-asset launch numbers — they are placeholders only.

## Tests

The PARTIAL tests (`test_portfolio.py`, `test_stress.py`, `test_calibrate.py`,
`test_deck_charts.py`) move **with** their modules into `quant/legacy/tests/`
in P1 (update import paths) so the PARTIAL suite still runs and CI stays green.
`test_params.py`, `test_il.py`, `test_positions.py`, `test_prices.py` stay where
they are (those modules stay at `src/`). New cvAMM tests are added in P1
(fairRate surface reproduces the authoritative numbers within MC tolerance;
I10 cap `premium ≤ FairPremium·(1 + maxLoad)` holds by construction).
