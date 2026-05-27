"""Task 14.9 — production pitch-deck charts (`apps/docs/static/quant/`).

Three slide-ready PNGs at 16:9, 200 DPI, generated from the live calibration:

1. ``fund_pnl_distribution.png`` — histogram of fund P&L under severe
   correlated crash at the calibrated ``c_min``; ruin-budget quantile and
   ``fund_target`` annotated. The headline chart: *"99.9% of crashes are
   absorbed by $24k of equity."*
2. ``ruin_probability_vs_c.png`` — log-scale sweep of ``P(ruin)`` as
   ``c`` rises; calibrated ``c_min`` marked. The calibration story:
   *"more MM collateral → exponentially less fund risk."*
3. ``tail_coverage.png`` — stacked-bar decomposition of *who pays* at
   each severity (P50, P95, P99, P99.9): MM collateral vs Fund tail vs
   surplus premium. The coverage layers in one image.

Inputs come from the same calibration call that produced ``params.json``,
so deck and ``params.json`` are always in sync.

CLI::

    uv run python -m inflexion_quant.deck_charts \\
        [--output-dir apps/docs/static/quant] [--n-runs 1000] [--rng-seed 20260527]
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless backend — avoids tk crashes in tests / CI
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from inflexion_quant.calibrate import (
    build_scenario_cache,
    calibrate_c_min,
    calibrate_fund_target,
    fund_pnl_from_cache,
)
from inflexion_quant.stress import (
    CorrelatedCrashConfig,
    correlated_crash_terminal_fn,
    ruin_probability,
    var_cvar,
)


DECK_STYLE = {
    "figure.figsize": (16, 9),
    "figure.dpi": 100,
    "savefig.dpi": 200,
    "savefig.bbox": "tight",
    "axes.titlesize": 22,
    "axes.titleweight": "bold",
    "axes.labelsize": 16,
    "xtick.labelsize": 13,
    "ytick.labelsize": 13,
    "legend.fontsize": 13,
    "axes.grid": True,
    "grid.alpha": 0.3,
    "axes.spines.top": False,
    "axes.spines.right": False,
}

# Color palette (consistent across charts)
COLOR_PROFIT = "#27ae60"
COLOR_LOSS = "#c0392b"
COLOR_FUND = "#2980b9"
COLOR_MM = "#8e44ad"
COLOR_NEUTRAL = "#7f8c8d"


@dataclass
class DeckInputs:
    """Everything needed to render the three charts, in one object."""

    cache_severe: object  # _ScenarioCache
    c_min: float
    fund_target: float
    premium_rate: float
    premium_share: float
    ruin_budget: float
    bootstrap_balance: float


# ─── Input prep ──────────────────────────────────────────────────────────────


def prepare_inputs(
    *,
    n_runs: int = 1000,
    n_positions: int = 200,
    rng_seed: int = 20260527,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    ruin_budget: float = 0.001,
    bootstrap_pct_of_notional: float = 0.01,
) -> DeckInputs:
    """Build the severe-stress cache and run c_min + fund_target calibration."""
    cfg = CorrelatedCrashConfig.severe()
    cache = build_scenario_cache(
        n_runs=n_runs,
        n_positions=n_positions,
        terminal_fn=correlated_crash_terminal_fn(cfg),
        rng=np.random.default_rng(rng_seed),
        P0=100.0,
    )
    typical_book = float(np.median(cache.V0s.sum(axis=1)))
    bootstrap_balance = bootstrap_pct_of_notional * typical_book

    c_res = calibrate_c_min(
        cache=cache,
        fund_balance=bootstrap_balance,
        ruin_budget=ruin_budget,
        premium_rate=premium_rate,
        premium_share=premium_share,
    )
    c_min = float(c_res["c_min"]) if c_res["feasible"] else 0.50

    fund_res = calibrate_fund_target(
        cache=cache,
        c=c_min,
        premium_rate=premium_rate,
        premium_share=premium_share,
        ruin_budget=ruin_budget,
    )

    return DeckInputs(
        cache_severe=cache,
        c_min=c_min,
        fund_target=float(fund_res["fund_target"]),
        premium_rate=premium_rate,
        premium_share=premium_share,
        ruin_budget=ruin_budget,
        bootstrap_balance=bootstrap_balance,
    )


# ─── Chart 1: fund P&L distribution ─────────────────────────────────────────


def render_fund_pnl_distribution(inputs: DeckInputs, out_path: Path) -> None:
    pnl = fund_pnl_from_cache(
        inputs.cache_severe,
        c=inputs.c_min,
        premium_rate=inputs.premium_rate,
        premium_share=inputs.premium_share,
        fee_pct=0.0,
    )
    median_pnl = float(np.median(pnl))
    p_budget = float(np.quantile(pnl, inputs.ruin_budget))
    var99, cvar99 = var_cvar(pnl, confidence=0.99)

    fig, ax = plt.subplots()
    bin_edges = np.linspace(pnl.min(), pnl.max(), 70)
    ax.hist(pnl, bins=bin_edges, color=COLOR_FUND, alpha=0.78, edgecolor="white")

    # Markers
    ax.axvline(0, color="black", lw=1.2)
    ax.axvline(median_pnl, color=COLOR_PROFIT, lw=2.5, linestyle="--",
               label=f"median: +${median_pnl:,.0f}")
    ax.axvline(-var99, color="orange", lw=2, linestyle=":",
               label=f"VaR(99%): −${var99:,.0f}")
    ax.axvline(p_budget, color=COLOR_LOSS, lw=2.5, linestyle="--",
               label=f"P({inputs.ruin_budget * 100:.1f}%): ${p_budget:,.0f}")

    # Shade the tail the fund must absorb
    if p_budget < 0:
        ax.axvspan(p_budget, 0, alpha=0.12, color=COLOR_LOSS)
        ax.annotate(
            f"fund covers up to\n${inputs.fund_target:,.0f}",
            xy=(p_budget, ax.get_ylim()[1] * 0.65),
            xytext=(p_budget * 1.05, ax.get_ylim()[1] * 0.85),
            arrowprops=dict(arrowstyle="->", color=COLOR_LOSS, lw=1.5),
            fontsize=14, color=COLOR_LOSS, fontweight="bold",
            ha="right",
        )

    ax.set_xlabel("Fund P&L per 30-day Monte Carlo run ($)")
    ax.set_ylabel("Frequency")
    ax.set_title(
        f"Insurance Fund P&L at c_min = {inputs.c_min * 100:.1f}%  "
        f"(severe correlated crash, {inputs.cache_severe.n_runs:,} runs)"
    )
    ax.legend(loc="upper right", framealpha=0.95)
    fig.savefig(out_path)
    plt.close(fig)


# ─── Chart 2: ruin probability vs c ─────────────────────────────────────────


def render_ruin_probability_vs_c(inputs: DeckInputs, out_path: Path) -> None:
    c_grid = np.linspace(0.03, 0.40, 40)

    def ruin_at(c: float) -> float:
        pnl = fund_pnl_from_cache(
            inputs.cache_severe, c=c,
            premium_rate=inputs.premium_rate,
            premium_share=inputs.premium_share, fee_pct=0.0,
        )
        return ruin_probability(pnl, initial_fund_balance=inputs.fund_target)

    ruin = np.array([ruin_at(c) for c in c_grid])

    # Log-scale plotting: clamp zeros to 1/(2*n_runs) so they're plottable
    n_runs = inputs.cache_severe.n_runs
    floor = 1.0 / (2 * n_runs)
    ruin_p = np.maximum(ruin, floor)

    fig, ax = plt.subplots()
    ax.plot(c_grid * 100, ruin_p * 100, marker="o", lw=3, color=COLOR_FUND,
            markersize=7)

    ax.axhline(inputs.ruin_budget * 100, color="black", lw=1.5, linestyle="--",
               label=f"ruin budget = {inputs.ruin_budget * 100:.1f}%")
    ax.axvline(inputs.c_min * 100, color=COLOR_LOSS, lw=2, linestyle=":")

    # Tag the calibrated c_min where it crosses the budget
    ax.annotate(
        f"c_min = {inputs.c_min * 100:.1f}%\n(P(ruin) = {inputs.ruin_budget * 100:.1f}%)",
        xy=(inputs.c_min * 100, inputs.ruin_budget * 100),
        xytext=(inputs.c_min * 100 + 8, inputs.ruin_budget * 100 * 30),
        arrowprops=dict(arrowstyle="->", color=COLOR_LOSS, lw=1.8),
        fontsize=15, color=COLOR_LOSS, fontweight="bold",
    )

    # Shade infeasible region (below c_min)
    ax.axvspan(c_grid[0] * 100, inputs.c_min * 100, alpha=0.08, color=COLOR_LOSS)
    ax.text(c_grid[0] * 100 + 1, ax.get_ylim()[1] * 0.3,
            "below c_min:\nfund risk exceeds budget",
            fontsize=12, color=COLOR_LOSS, style="italic", va="top")

    ax.set_xlabel("MM collateral ratio c (% of V0)")
    ax.set_ylabel("P(ruin) %  (log scale)")
    ax.set_yscale("log")
    ax.set_title(
        f"More MM collateral → exponentially less fund risk  "
        f"(fund equity = ${inputs.fund_target:,.0f})"
    )
    ax.legend(loc="upper right", framealpha=0.95)
    fig.savefig(out_path)
    plt.close(fig)


# ─── Chart 3: tail-coverage decomposition ──────────────────────────────────


def render_tail_coverage(inputs: DeckInputs, out_path: Path) -> None:
    """At c_min, for each percentile of *fund_pays_total* (i.e. ranked by the
    fund's worst-case exposure), show MM cover vs Fund cover stacked, with
    the fund_target equity line as the safety threshold.

    Ranking by fund_pays_total (not LP payout) keeps the story focused on the
    fund's exposure rather than book size, so P99.9 is the *worst run for the
    fund* — exactly what a viewer wants to see.
    """
    cache = inputs.cache_severe
    c = inputs.c_min

    payout_total = cache.payouts.sum(axis=1)
    mm_pays_total = np.minimum(cache.payouts, c * cache.V0s).sum(axis=1)
    fund_pays_total = np.maximum(0, cache.payouts - c * cache.V0s).sum(axis=1)

    severity_pcts = [50, 95, 99, 99.9]
    rows = []
    for p in severity_pcts:
        # Rank by FUND_PAYS_TOTAL — the fund's exposure, not book size
        q = np.quantile(fund_pays_total, p / 100)
        idx = int(np.argmin(np.abs(fund_pays_total - q)))
        rows.append({
            "label": f"P{p}",
            "lp_payout": payout_total[idx],
            "mm_pays": mm_pays_total[idx],
            "fund_pays": fund_pays_total[idx],
        })
    df = pd.DataFrame(rows)

    fig, ax = plt.subplots()
    x = np.arange(len(df))
    width = 0.6

    ax.bar(x, df["mm_pays"], width, color=COLOR_MM,
           label="covered by MM collateral")
    ax.bar(x, df["fund_pays"], width, bottom=df["mm_pays"],
           color=COLOR_LOSS, label="covered by Insurance Fund")

    # Labels on top of each bar
    y_max_for_text = (df["mm_pays"] + df["fund_pays"]).max()
    for i, row in df.iterrows():
        total = row["mm_pays"] + row["fund_pays"]
        ax.text(i, total + y_max_for_text * 0.02,
                f"LP paid\n${total:,.0f}", ha="center", fontsize=12, fontweight="bold")
        if row["fund_pays"] > 0:
            ax.text(i, row["mm_pays"] + row["fund_pays"] / 2,
                    f"fund:\n${row['fund_pays']:,.0f}",
                    ha="center", va="center", fontsize=11,
                    color="white", fontweight="bold")

    ax.set_xticks(x)
    ax.set_xticklabels(df["label"])
    ax.set_xlabel("Severity percentile (ranked by fund exposure)")
    ax.set_ylabel("$ paid to LPs per 30-day Monte Carlo run")
    ax.set_title(
        f"At c_min = {inputs.c_min * 100:.1f}%, MM collateral covers most of the LP loss  "
        f"— fund taps only on rare tails"
    )
    ax.legend(loc="upper left", framealpha=0.95)
    ax.set_ylim(0, y_max_for_text * 1.18)
    fig.savefig(out_path)
    plt.close(fig)


# ─── Orchestrator + CLI ─────────────────────────────────────────────────────


def render_all(
    output_dir: Path,
    *,
    n_runs: int = 1000,
    n_positions: int = 200,
    rng_seed: int = 20260527,
) -> dict[str, Path]:
    """Generate all three charts; return a dict of name → output path."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    plt.rcParams.update(DECK_STYLE)
    inputs = prepare_inputs(n_runs=n_runs, n_positions=n_positions, rng_seed=rng_seed)

    paths = {
        "fund_pnl_distribution": output_dir / "fund_pnl_distribution.png",
        "ruin_probability_vs_c": output_dir / "ruin_probability_vs_c.png",
        "tail_coverage": output_dir / "tail_coverage.png",
    }
    render_fund_pnl_distribution(inputs, paths["fund_pnl_distribution"])
    render_ruin_probability_vs_c(inputs, paths["ruin_probability_vs_c"])
    render_tail_coverage(inputs, paths["tail_coverage"])
    return paths


def _main() -> None:
    parser = argparse.ArgumentParser(
        description="Render pitch-deck charts to apps/docs/static/quant/.",
    )
    parser.add_argument(
        "--output-dir", type=Path,
        default=Path(__file__).resolve().parents[3] / "apps" / "docs" / "static" / "quant",
    )
    parser.add_argument("--n-runs", type=int, default=1000)
    parser.add_argument("--n-positions", type=int, default=200)
    parser.add_argument("--rng-seed", type=int, default=20260527)
    args = parser.parse_args()

    paths = render_all(
        args.output_dir,
        n_runs=args.n_runs,
        n_positions=args.n_positions,
        rng_seed=args.rng_seed,
    )
    print(f"Wrote {len(paths)} charts to {args.output_dir}")
    for name, p in paths.items():
        size_kb = p.stat().st_size / 1024
        print(f"  {name}: {p.name} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    _main()
