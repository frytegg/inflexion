# Heavy single-asset cvAMM calibration — results (P1.13)

> The reproducible run is `inflexion_quant.heavy.run_launch_calibration()`
> (CLI: `uv run python -m inflexion_quant.heavy`). Output:
> `cvamm_heavy_results.json`. Final numbers are in
> [`params.cvamm.schema.json`](params.cvamm.schema.json). **Settle / MaxIL /
> I1–I9 untouched; `params.json`/`params.py` byte-unchanged.**

## What was run

A real-measure ETH model **stronger than GBM** (the `quant/SPEC.md` bar — a fair
value validated under thin tails is not validated), driving the cvAMM depositor
P&L:

- **Fat tails** — Student-t monthly innovations (`t_df = 4`).
- **Volatility clustering** — a 3-state Markov vol regime (calm 0.45 / normal
  0.75 / stressed 1.30 annualised) with persistence 0.82.
- **Tail-dependent crash correlation → 1** — a single ETH pair: every outstanding
  position settles against the *same* move, plus Poisson deep-crash months
  (~0.8/yr, mean −45%) hitting the whole locked book together.
- **Stale-σ regime risk** — premium priced at a **lagging** `σ_ref` EWMA, so
  coverage written at a stressed-regime onset is underpriced exactly as it would
  be on-chain (the biggest model risk, spec §6.5).

### Data source (per SPEC — documented; fallback labelled)

CoinGecko's free tier is now key-gated (**HTTP 401**), so there is **no live
daily feed**. The model is **historical-episode-anchored**: crash frequency and
magnitude bracket the documented ETH stress episodes — March 2020 (COVID, ETH
−40/−50% in 24h), Terra-LUNA (May 2022, ETH ≈ −35%/week), FTX (Nov 2022, ETH
≈ −22%/3d), 2022 bear (ETH −68% YoY, ≈ −82% peak-to-trough) — cited in
`legacy/stress.py` and corroborated by public price history. This is a **labelled
historical-episode-anchored real-measure model, NOT a real daily series.**

## FULL no-bad-debt — VERIFIED (I1/I2)

`payout_frac = min(IL, MaxIL)/MaxIL ≤ 1.0` on **every** simulated path and over a
±99% (and a widened −6…+6 log-move) grid: `max_payout_frac = 1.000000`. FULL
collateral == MaxIL ⇒ `payout ≤ collateral`, **structurally**, independent of any
oracle. Zero exceptions.

## The headline finding (honest)

**The unhedged, untranched single-pair ETH pool CANNOT meet the SPEC safety
targets at any _marketable_ load** (price ≤ MaxIL). The feasible set is empty —
robustly, and stress only makes it worse. The binding constraints are
`1-in-100 monthly loss ≤ 10%` and `P(losing month) ≤ 15%`, both **intrinsic to
single-asset volatility selling** (you lose whenever realized > implied, and a
crash pays the whole synchronized book). This is the SPEC's "infeasible without an
unmarketable load → SAY SO and propose a structural change" outcome. **The targets
were NOT loosened.**

### Disclosure — REAL single-asset ETH depositor numbers

Real-measure, warm-up-trimmed steady state, baseLoad calm/normal/stressed =
20%/30%/50%, **gross of demand/competition/fees** (lead with the geometric 3y
CAGR, never the arithmetic mean):

| Operating point | 3y CAGR (med / p10 / p90) | P(3y NAV<1) | P(losing month) | 1-in-100 month | worst month | P(3y DD>50%) | no-bad-debt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Disciplined `u=0.40` | 122% / 50% / 247% | 0.3% | 26.5% | −20.1% | −26.8% | 2.7% | ✓ |
| Fully-deployed `u=0.60` | 209% / 72% / 491% | 0.5% | 26.5% | −30.1% | −40.1% | 18.0% | ✓ |

The attractive gross CAGR sits on an **unsafe** single-pair risk profile — which
is precisely the motivation for the structural levers. **Verbatim tone
(mandatory):** _"You earn the volatility risk premium in calm markets and absorb
losses in crashes. In FULL the pool cannot become insolvent and cannot be run, but
YOUR CAPITAL IS NOT GUARANTEED."_ Two separate claims, never merged: (1) LPs are
always paid (no bad debt, FULL, I1); (2) depositors can lose principal.

## The structural levers (the proposed change)

| Lever | Effect (u=0.40, base loads) | Status |
| --- | --- | --- |
| **Utilization cap** (`util_skew`, knee 0.45) | the **drawdown** lever (not tail-feasibility): u=0.40 → P(DD>50%)=2.7% vs u=0.60 → 18% | launch |
| **Pool hedge** (deliverable 8), h≈0.60 | 1-in-100 → ~−10% (target), worst → ~−12%, P(DD>50%) → ~0%; CAGR barely moves. **Tail-tightening, NOT solvency** (basis risk; approximate gamma) | roadmap |
| **Senior/junior tranche** (deliverable 9), `sf=0.60` | **senior P(loss)=0, worst=0%**, CAGR ~197% — the marketable "convexity savings account". Junior is the explicit high-APY vol tranche (worst −67%). Holds **jointly with `u ≤ 1−sf`** | roadmap |

The honest answer to "is the depositor product safe?": **the unhedged pool is
not**; the **senior tranche** (with the utilization cap) is the safe product, and
the pool hedge brings the whole pool's tail into target.

## Adversarial self-audit — GO

A 6-agent verification workflow independently re-ran the engine and reviewed the
code (verdict **GO**, no blocking bugs):

- **No-bad-debt** confirmed structural (`max_payout_frac=1.0` on a widened grid;
  closed form ≡ il.py to 3.3e-9).
- **Infeasibility** robust under heavier tails / more & deeper crashes / higher
  vol — stress moves it the correct (worse) direction.
- **No optimistic rigging** — the measure split is correct (premium RN at σ_ref,
  payout real); the model is in fact **net-conservative** to depositors (the
  σ_ref floor 0.50 > calm vol 0.45 overcharges the 27% of calm months;
  all-months payout/premium = 0.654).
- Corrections **applied**: geometric CAGR (not the arithmetic 246% that overstates
  growth on a fat-left-tail process), F3 scoped to drawdown, senior-tranche `u≤1−sf`
  caveat, pool-hedge never-solvency caveat, EWMA warm-up trim, `max_il>0` guard.

### Residual risks (disclosed, not buried)

- **Net conservatism** (calm overcharge) must not be mistaken for a safety buffer
  against a tighter book.
- **Book mix** (`positions.py`) under-represents tight/JIT LPs, so tail payout may
  be **under**-stated — a residual upside risk in the risk numbers (not the price
  model). Re-fit against the empirical on-chain coverage histogram when live (P4).
