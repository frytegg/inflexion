# Inflexion Quant Model

> **Gates PARTIAL mode.** Derives every parameter in `params.json` from
> fat-tailed, correlated Monte Carlo stress tests (`../spec.md` §9). Runs in
> parallel with the contracts build — outputs feed
> `packages/contracts/script/Deploy.s.sol` once Phase 15 lands.
>
> Also a flagship pitch artifact: _"we did not guess our risk parameters —
> we derived them under correlated-crash stress."_

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
├── pyproject.toml          # project + dependency declaration (uv-managed)
├── README.md               # this file
├── .python-version         # pinned: 3.12+
├── notebooks/              # numbered notebooks — run in order
│   └── 01_underlying.ipynb
├── src/inflexion_quant/    # importable helpers (IL math, simulators, etc.)
│   ├── __init__.py
│   └── il.py               # Python mirror of the Stylus ILMath contract
└── data/                   # cached price data (gitignored)
```

## Roadmap (Phase 14 from `../ROADMAP.md`)

|          | Task                                                                                                                                                                            | Status     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **14.1** | Scaffold (this file + notebook 01 + project setup)                                                                                                                              | ✅ this PR |
| **14.2** | Underlying price model — GBM → jump-diffusion → historical bootstrap → common-factor stress                                                                                     |            |
| **14.3** | Position-structure distribution (range widths × moneyness)                                                                                                                      |            |
| **14.4** | Path → IL — Python reimplementation of spec §3.1; cross-check vs Stylus output                                                                                                  |            |
| **14.5** | Portfolio waterfall — `min(IL, c)` from MM + `(IL − c)⁺` from fund                                                                                                              |            |
| **14.6** | Stress scenarios — correlated crash (common factor +6σ), vol regime shift, utilization spike                                                                                    |            |
| **14.7** | Derive parameters — `c_min`, convex `floor_curve(c)`, convex `fee(c)`, circuit-breaker thresholds, withdrawal-delay length, per-market/per-MM exposure caps, MM first-loss size |            |
| **14.8** | Emit versioned `params.json` (Pydantic-validated schema; consumed by Phase 15 deploy)                                                                                           |            |
| **14.9** | Charts for the deck — fund P&L distribution, ruin prob vs `c`, drawdown under 99.9th-pct crash                                                                                  |            |

## Methodology (what every notebook converges on)

The question: **given partial collateral `c`, what is the probability and
magnitude of the fund covering excess IL across realistic paths, and what
`fee(c)` / floor / caps make the fund a solvent reinsurer with bounded ruin
probability?**

The answer comes from a portfolio simulation:

1. Simulate `N` correlated price paths (fat-tailed + common crash factor).
2. For each path × position-structure pair, compute terminal IL via the spec §3.1
   formulas.
3. Apply the waterfall: LP receives `min(IL, c)` from MM; fund covers `(IL − c)⁺`.
4. Fund inflows: premium share + `fee(c)`. Outflows: excess IL.
5. Aggregate over many concurrent swaps → fund P&L distribution.
6. Stress: ratchet the common factor → measure ruin probability and 99.9th-pct
   drawdown.
7. Solve for parameters such that ruin probability < target (e.g. <0.1%) AND
   expected fund P&L > 0.

These are **the** numbers. Any PARTIAL constant in the contracts that is not
derived here is a bug.
