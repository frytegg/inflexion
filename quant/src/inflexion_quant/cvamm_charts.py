"""cvAMM pitch-deck charts (cvAMM deliverable / ROADMAP P1.11).

Three slide-ready 16:9 PNGs, mirroring the legacy ``DECK_STYLE`` / palette:

1. ``fairpremium_scurve.png`` — ``fairRate`` as the S-curve in ``σ²·T``: three
   prices for the same position (7/30/90d) over a fixed MaxIL. *"One position,
   three prices, same collateral."*
2. ``overcharge_gap.png`` — the lone-writer CVaR95 (≈100% of MaxIL) collapsing
   to the diversified-pool CVaR as the book grows, with ``fairRate`` as the
   floor. The shaded gap is *why the pool exists* and the room ``baseLoad`` lives
   in. *"Diversification turns a 100%-of-MaxIL reserve into ~79%."*
3. ``depositor_loss_distribution.png`` — the monthly depositor P&L histogram with
   P(losing month), the 1-in-100 loss and the worst month annotated, under the
   verbatim **CAPITAL NOT GUARANTEED** framing.

CLI::

    uv run python -m inflexion_quant.cvamm_charts [--output-dir DIR] [--rng-seed S]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless — avoids tk crashes in tests / CI
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from inflexion_quant import cvamm as cv  # noqa: E402
from inflexion_quant.depositor import DepositorModel, simulate_monthly_pnl  # noqa: E402
from inflexion_quant.il import compute_max_il, position_V0  # noqa: E402

# Copied from legacy.deck_charts (the README's "copy DECK_STYLE/palette").
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
COLOR_PROFIT = "#27ae60"
COLOR_LOSS = "#c0392b"
COLOR_FUND = "#2980b9"
COLOR_MM = "#8e44ad"
COLOR_NEUTRAL = "#7f8c8d"

P0, L = 3000.0, 1.0
DAYS = (7, 30, 90)
WIDTHS = (0.05, 0.10, 0.20)


# ─── Chart 1: FairPremium S-curve in σ²·T ────────────────────────────────────


def render_fairpremium_scurve(out_path: Path, *, sigma: float = 0.60) -> None:
    fig, ax = plt.subplots()
    colors = [COLOR_FUND, COLOR_MM, COLOR_PROFIT]
    for w, c in zip(WIDTHS, colors, strict=True):
        Pa, Pb = cv.make_range(P0, w)
        x = [sigma * sigma * (d / 365.0) for d in DAYS]
        y = [cv.fair_rate(P0, Pa, Pb, L, sigma, d / 365.0) * 100 for d in DAYS]
        ax.plot(x, y, marker="o", lw=3, markersize=9, color=c, label=f"±{int(w * 100)}% range")
        for xi, yi, d in zip(x, y, DAYS, strict=True):
            ax.annotate(
                f"{d}d", (xi, yi), textcoords="offset points", xytext=(6, 6), fontsize=11, color=c
            )
    ax.set_xlabel("σ²·T  (variance × time — the single S-curve axis)")
    ax.set_ylabel("fairRate  (% of MaxIL)")
    ax.set_ylim(0, 100)
    ax.set_title(f"One position, three prices, one MaxIL — fairRate S-curve (σ={sigma:.0%})")
    ax.legend(loc="lower right", framealpha=0.95)
    fig.savefig(out_path)
    plt.close(fig)


# ─── Chart 2: overcharge gap / diversification collapse ──────────────────────


def render_overcharge_gap(out_path: Path, *, sigma: float = 0.60, n_runs: int = 30_000) -> None:
    dc = cv.diversification_collapse(
        half_width=0.10,
        sigma=sigma,
        T_days=30,
        n_grid=(1, 2, 5, 10, 25, 50, 100),
        correlation=0.0,
        n_runs=n_runs,
    )
    n_grid = dc["n_grid"]
    cvar = np.array(dc["per_contract_cvar"]) * 100
    fair = dc["fair"] * 100

    fig, ax = plt.subplots()
    ax.plot(
        n_grid,
        cvar,
        marker="o",
        lw=3,
        markersize=8,
        color=COLOR_LOSS,
        label="per-contract CVaR95 (capital a prudent writer reserves)",
    )
    ax.axhline(
        fair, color=COLOR_PROFIT, lw=2.5, linestyle="--", label=f"fairRate = {fair:.0f}% of MaxIL"
    )
    ax.fill_between(n_grid, fair, cvar, alpha=0.12, color=COLOR_FUND)
    ax.annotate(
        f"lone writer: {cvar[0]:.0f}%\n→ pooled (N=100): {cvar[-1]:.0f}%",
        xy=(n_grid[-1], cvar[-1]),
        xytext=(n_grid[-1] * 0.4, cvar[0] - 6),
        arrowprops=dict(arrowstyle="->", color=COLOR_LOSS, lw=1.6),
        fontsize=14,
        color=COLOR_LOSS,
        fontweight="bold",
    )
    ax.set_xscale("log")
    ax.set_xlabel("book size N (contracts, log scale)")
    ax.set_ylabel("% of MaxIL")
    ax.set_ylim(0, 105)
    ax.set_title("Why the pool exists: diversification collapses the lone-writer reserve")
    ax.legend(loc="upper right", framealpha=0.95)
    fig.savefig(out_path)
    plt.close(fig)


# ─── Chart 3: depositor loss distribution ────────────────────────────────────


def render_depositor_loss(
    out_path: Path,
    *,
    model: DepositorModel | None = None,
    n_months: int = 20_000,
    rng_seed: int = 20260601,
) -> None:
    model = model or DepositorModel()
    rng = np.random.default_rng(rng_seed)
    pnl = simulate_monthly_pnl(model, n_months=n_months, n_positions=150, rng=rng) * 100
    p_loss = float((pnl < 0).mean())
    loss_1in100 = float(-np.quantile(pnl, 0.01))
    worst = float(-pnl.min())
    median = float(np.median(pnl))

    fig, ax = plt.subplots()
    bins = np.linspace(pnl.min(), pnl.max(), 70)
    ax.hist(pnl, bins=bins, color=COLOR_FUND, alpha=0.78, edgecolor="white")
    ax.axvline(0, color="black", lw=1.2)
    ax.axvline(
        median, color=COLOR_PROFIT, lw=2.5, linestyle="--", label=f"median: {median:+.2f}%/mo"
    )
    ax.axvline(
        -loss_1in100,
        color="orange",
        lw=2,
        linestyle=":",
        label=f"1-in-100 month: −{loss_1in100:.1f}%",
    )
    ax.axvline(
        -worst, color=COLOR_LOSS, lw=2.5, linestyle="--", label=f"worst month: −{worst:.1f}%"
    )
    ax.set_xlabel("Monthly depositor return (% of capital)")
    ax.set_ylabel("Frequency")
    ax.set_title(
        f"Depositors sell volatility — CAPITAL NOT GUARANTEED  (P(losing month) = {p_loss:.0%})"
    )
    ax.legend(loc="upper left", framealpha=0.95)
    fig.savefig(out_path)
    plt.close(fig)


# ─── Orchestrator + CLI ──────────────────────────────────────────────────────


def render_all(
    output_dir: Path, *, rng_seed: int = 20260601, fast: bool = False
) -> dict[str, Path]:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update(DECK_STYLE)
    n_runs = 3_000 if fast else 30_000
    n_months = 3_000 if fast else 20_000
    paths = {
        "fairpremium_scurve": output_dir / "fairpremium_scurve.png",
        "overcharge_gap": output_dir / "overcharge_gap.png",
        "depositor_loss_distribution": output_dir / "depositor_loss_distribution.png",
    }
    render_fairpremium_scurve(paths["fairpremium_scurve"])
    render_overcharge_gap(paths["overcharge_gap"], n_runs=n_runs)
    render_depositor_loss(
        paths["depositor_loss_distribution"], n_months=n_months, rng_seed=rng_seed
    )
    return paths


def _main() -> None:
    parser = argparse.ArgumentParser(description="Render cvAMM deck charts.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[3]
        / "apps"
        / "docs"
        / "static"
        / "quant"
        / "cvamm",
    )
    parser.add_argument("--rng-seed", type=int, default=20260601)
    parser.add_argument("--fast", action="store_true", help="small MC for a quick preview")
    args = parser.parse_args()
    paths = render_all(args.output_dir, rng_seed=args.rng_seed, fast=args.fast)
    print(f"Wrote {len(paths)} cvAMM charts to {args.output_dir}")
    for name, p in paths.items():
        print(f"  {name}: {p.name} ({p.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    _main()
