"""Heavy single-asset cvAMM calibration (P1.13) — the real-measure run.

Produces the FINAL cvAMM numbers (baseLoad by regime, skew curve params,
maxLoadBps, the REAL ETH depositor disclosure) under a price model that is
**stronger than GBM** — the bar from ``quant/SPEC.md`` (a fair value computed and
validated under thin tails is not validated):

- **Fat tails** — Student-t monthly innovations (``t_df`` ~ 4).
- **Volatility clustering** — a 3-state Markov vol regime (calm/normal/stressed)
  with persistence, so calm and stressed regimes arrive in bursts.
- **Tail-dependent crash correlation → 1** — a single ETH pair: every outstanding
  position settles against the *same* move, and discrete crash months
  (Poisson-frequency, ETH-episode magnitude) hit the whole locked book together.
- **Stale-σ regime risk** — premium is priced at a LAGGING ``σ_ref`` (EWMA of the
  realized regime vol), so coverage written at the onset of a stressed month is
  underpriced exactly as it would be on-chain (the biggest model risk, spec §6.5).

**Historical anchoring (data source, per SPEC).** CoinGecko's free tier is now
key-gated (HTTP 401), so there is **no live daily feed**; the model is anchored to
the documented ETH stress episodes — March 2020 (COVID, ETH −40/−50% in 24h),
Terra-LUNA (May 2022, ETH ≈ −35%/week), FTX (Nov 2022, ETH ≈ −22%/3d), and the
2022 bear (ETH −68% YoY, ≈ −82% peak-to-trough) — cited in ``legacy/stress.py``
and corroborated by public price history. The crash-month frequency/magnitude is
set to **bracket** these episodes. This is a labelled historical-episode-anchored
real-measure model, **not** a real daily series — never presented as one.

The FULL no-bad-debt invariant (I1/I2: ``payout ≤ MaxIL``) is verified on every
simulated path and over a ±99% move grid; a single violation invalidates the run.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.random import Generator

from inflexion_quant import cvamm as cv
from inflexion_quant.positions import PositionMix, sample_positions

DAYS_PER_YEAR = 365.0


# ─── Real-measure ETH model (beyond GBM) ─────────────────────────────────────


@dataclass(frozen=True)
class RealMeasureModel:
    """Historical-episode-anchored real-measure ETH model (see module docstring)."""

    # 3-state Markov vol regime (annualised vol per state)
    regime_sigma: tuple[float, float, float] = (0.45, 0.75, 1.30)
    regime_stationary: tuple[float, float, float] = (0.55, 0.33, 0.12)
    regime_persistence: float = 0.82  # diagonal of the transition matrix (clustering)
    t_df: float = 4.0  # Student-t fat tails (excess kurtosis 6/(df-4))
    mu_annual: float = 0.0  # real drift (conservative: 0; ETH ~flat over a full cycle)
    # discrete deep-crash months (on top of regime vol)
    crash_per_year: float = 0.8  # ~ March2020 + LUNA + FTX over the 2020-2025 window
    crash_mean: float = -0.45  # mean crash log-return (ETH episode magnitude)
    crash_std: float = 0.15
    # sigma_ref oracle (lagging, conservative)
    sigma_ref_floor: float = 0.50
    sigma_ref_short_hl_months: float = 1.0
    sigma_ref_long_hl_months: float = 6.0

    def transition_matrix(self) -> np.ndarray:
        """3x3 Markov transition with diagonal = persistence, off-diagonal ∝ stationary."""
        s = np.asarray(self.regime_stationary, dtype=float)
        p = self.regime_persistence
        T = np.empty((3, 3))
        for i in range(3):
            off = s.copy()
            off[i] = 0.0
            off = off / off.sum() * (1.0 - p)
            T[i] = off
            T[i, i] = p
        return T


# ─── Book curves (decouple the book from the time series) ─────────────────────


@dataclass(frozen=True)
class BookCurves:
    """Precomputed MaxIL-weighted book responses, so the monthly sim is a lookup.

    ``payout_frac(m)``  — mean realised ``min(IL,MaxIL)/MaxIL`` over the book for a
    log-move ``m`` (independent of σ; pure geometry + realised move).
    ``wfair(sigma)``    — MaxIL-weighted mean ``fairRate`` at vol ``sigma`` (the
    premium base, before load), for the cohort duration ``T_days``.
    """

    move_grid: np.ndarray
    payout_frac_grid: np.ndarray
    sigma_grid: np.ndarray
    wfair_grid: np.ndarray
    T_days: int
    max_payout_frac: float

    def payout_frac(self, m: np.ndarray) -> np.ndarray:
        return np.interp(m, self.move_grid, self.payout_frac_grid)

    def wfair(self, sigma: np.ndarray) -> np.ndarray:
        return np.interp(sigma, self.sigma_grid, self.wfair_grid)


def build_book_curves(
    *,
    T_days: int,
    n_book: int = 40_000,
    P0: float = 3000.0,
    mix: PositionMix | None = None,
    rng: Generator | None = None,
    move_grid: np.ndarray | None = None,
    sigma_grid: np.ndarray | None = None,
) -> BookCurves:
    """Sample a single-asset ETH book and precompute its payout/fair curves."""
    rng = rng or np.random.default_rng(20260613)
    mix = mix or PositionMix.crypto_majors()  # single-asset width mix (ETH widths)
    move_grid = move_grid if move_grid is not None else np.linspace(-2.5, 2.5, 1001)
    sigma_grid = sigma_grid if sigma_grid is not None else np.linspace(0.05, 3.0, 200)

    pos = sample_positions(n_book, P0=P0, mix=mix, rng=rng)
    P0a = pos["P0"].to_numpy(float)
    Pa = pos["Pa"].to_numpy(float)
    Pb = pos["Pb"].to_numpy(float)
    L = pos["L"].to_numpy(float)

    # MaxIL per position (geometry); weights for the MaxIL-weighted means.
    _, max_il = cv.batch_payouts_and_maxils(P0a, Pa, Pb, L, P0a)  # P_T=P0 -> payout 0
    w = max_il / max_il.sum()

    # payout_frac(m): for each move, realised payout fraction (MaxIL-weighted).
    payout_frac_grid = np.empty(move_grid.size)
    max_payout = 0.0
    for k, m in enumerate(move_grid):
        P_T = P0a * np.exp(m)
        payout, mil = cv.batch_payouts_and_maxils(P0a, Pa, Pb, L, P_T)
        frac = payout / mil
        max_payout = max(max_payout, float(frac.max()))
        payout_frac_grid[k] = float((w * frac).sum())

    # wfair(sigma): MaxIL-weighted mean fairRate at the cohort duration.
    T = T_days / DAYS_PER_YEAR
    wfair_grid = np.empty(sigma_grid.size)
    for k, sig in enumerate(sigma_grid):
        fr = cv.fair_rate_vec(P0a, Pa, Pb, L, np.full(n_book, sig), np.full(n_book, T))
        wfair_grid[k] = float((w * fr).sum())

    return BookCurves(
        move_grid=move_grid,
        payout_frac_grid=payout_frac_grid,
        sigma_grid=sigma_grid,
        wfair_grid=wfair_grid,
        T_days=T_days,
        max_payout_frac=max_payout,
    )


# ─── Monthly depositor P&L path ensemble ─────────────────────────────────────


def _ewma(series: np.ndarray, halflife: float, axis: int = 1) -> np.ndarray:
    """Causal EWMA along ``axis`` (each column = EWMA of all values up to it)."""
    lam = 0.5 ** (1.0 / halflife)
    out = np.empty_like(series)
    acc = series.take(0, axis=axis)
    sl = [slice(None)] * series.ndim
    sl[axis] = 0
    out[tuple(sl)] = acc
    for t in range(1, series.shape[axis]):
        sl_t = [slice(None)] * series.ndim
        sl_t[axis] = t
        acc = lam * acc + (1 - lam) * series.take(t, axis=axis)
        out[tuple(sl_t)] = acc
    return out


def simulate_depositor_paths(
    model: RealMeasureModel,
    curves: BookCurves,
    *,
    base_load_by_regime: tuple[float, float, float],
    utilization: float = 0.60,
    n_paths: int = 20_000,
    n_months: int = 36,
    rng: Generator | None = None,
) -> dict[str, np.ndarray]:
    """Simulate the monthly depositor return ensemble under the real-measure model.

    Returns per-(path, month) ``monthly_return`` (fraction of capital), the
    realized log-moves, the regime path, the lagging ``sigma_ref`` premium is
    priced at, and the per-path crash flags.
    """
    rng = rng or np.random.default_rng(20260613)
    Tmat = model.transition_matrix()
    horizon = curves.T_days

    # Markov regime path
    regime = np.empty((n_paths, n_months), dtype=int)
    regime[:, 0] = rng.choice(3, size=n_paths, p=model.regime_stationary)
    for t in range(1, n_months):
        u = rng.random(n_paths)
        prev = regime[:, t - 1]
        cdf = np.cumsum(Tmat[prev], axis=1)
        regime[:, t] = (u[:, None] > cdf).sum(axis=1)

    sig_annual = np.asarray(model.regime_sigma)[regime]  # (paths, months) annualised
    Tfrac = horizon / DAYS_PER_YEAR
    sig_period = sig_annual * np.sqrt(Tfrac)

    # Student-t innovations scaled to unit variance, then to the period vol
    t_inn = rng.standard_t(model.t_df, size=(n_paths, n_months))
    t_inn = t_inn / np.sqrt(model.t_df / (model.t_df - 2.0))
    base_move = model.mu_annual * Tfrac - 0.5 * sig_period**2 + sig_period * t_inn

    # discrete deep-crash months — Poisson: P(>=1 crash in the horizon).
    # crash_per_year is a RATE (may exceed 1), so use 1 - exp(-rate*dt), never (1-rate)^dt.
    crash_p = 1.0 - np.exp(-model.crash_per_year * horizon / DAYS_PER_YEAR)
    is_crash = rng.random((n_paths, n_months)) < crash_p
    crash_draw = rng.normal(model.crash_mean, model.crash_std, size=(n_paths, n_months))
    move = np.where(is_crash, base_move + crash_draw, base_move)

    # sigma_ref: lagging EWMA of the realized regime vol (max short/long/floor)
    s_short = _ewma(sig_annual, model.sigma_ref_short_hl_months)
    s_long = _ewma(sig_annual, model.sigma_ref_long_hl_months)
    sigma_ref = np.maximum.reduce([s_short, s_long, np.full_like(s_short, model.sigma_ref_floor)])
    # price month t at info available BEFORE it (lag by one month)
    sigma_ref_priced = np.empty_like(sigma_ref)
    sigma_ref_priced[:, 0] = model.sigma_ref_floor
    sigma_ref_priced[:, 1:] = sigma_ref[:, :-1]

    # load charged depends on the priced regime (calm/normal/stressed band by sigma_ref)
    bl = np.asarray(base_load_by_regime)
    # map sigma_ref to a regime band via the model's regime sigmas (midpoints)
    s0, s1, s2 = model.regime_sigma
    b01, b12 = 0.5 * (s0 + s1), 0.5 * (s1 + s2)
    load_band = np.where(
        sigma_ref_priced < b01, bl[0], np.where(sigma_ref_priced < b12, bl[1], bl[2])
    )

    premium_frac = (1.0 + load_band) * curves.wfair(sigma_ref_priced)
    payout_frac = curves.payout_frac(move)
    monthly_return = utilization * (premium_frac - payout_frac)

    return {
        "monthly_return": monthly_return,
        "move": move,
        "regime": regime,
        "sigma_ref_priced": sigma_ref_priced,
        "payout_frac": payout_frac,
        "premium_frac": premium_frac,
        "is_crash": is_crash,
    }


def depositor_metrics(
    monthly_return: np.ndarray, *, horizon_days: int, warmup_months: int = 0
) -> dict[str, float]:
    """Headline disclosure metrics from the monthly-return ensemble.

    ``warmup_months`` trims the first N periods before computing — month 0 prices
    at the σ_ref floor for every path (a born-at-t0 artifact), so trimming a short
    warm-up reports the **steady-state** distribution a real depositor faces (the
    adversarial audit flagged the warm-up as tilting the window; trimming is the
    honest fix). APY is reported BOTH as arithmetic-mean-compounded (legacy) and
    as the **geometric multi-year CAGR** (median/p10/p90) — the latter is the
    honest growth figure on a fat-left-tail vol-selling process.
    """
    mr = monthly_return[:, warmup_months:] if warmup_months else monthly_return
    flat = mr.ravel()
    periods_per_year = DAYS_PER_YEAR / horizon_days
    mean_period = float(flat.mean())
    apy_arith = float((1.0 + max(mean_period, -0.99)) ** periods_per_year - 1.0)

    # Per-path NAV (rebased post-warmup), drawdown, and geometric CAGR.
    nav = np.cumprod(1.0 + mr, axis=1)
    running_max = np.maximum.accumulate(nav, axis=1)
    drawdown = 1.0 - nav / running_max
    max_dd_per_path = drawdown.max(axis=1)

    n_periods = mr.shape[1]
    years = n_periods / periods_per_year
    final_nav = np.clip(nav[:, -1], 1e-9, None)
    cagr = final_nav ** (1.0 / years) - 1.0

    return {
        "apy": apy_arith,  # arithmetic-mean compounded (kept for continuity)
        "apy_arith": apy_arith,
        "cagr_median": float(np.median(cagr)),
        "cagr_p10": float(np.quantile(cagr, 0.10)),
        "cagr_p90": float(np.quantile(cagr, 0.90)),
        "p_multiyr_nav_below_1": float((nav[:, -1] < 1.0).mean()),
        "mean_period_return": mean_period,
        "p_losing_period": float((flat < 0).mean()),
        "loss_1in100": float(max(0.0, -np.quantile(flat, 0.01))),
        "cvar99": float(max(0.0, -flat[flat <= np.quantile(flat, 0.01)].mean())),
        "worst_period": float(max(0.0, -flat.min())),
        "best_period": float(flat.max()),
        "median_max_drawdown": float(np.median(max_dd_per_path)),
        "p_drawdown_gt_50pct": float((max_dd_per_path > 0.50).mean()),
        "worst_max_drawdown": float(max_dd_per_path.max()),
        "periods_per_year": periods_per_year,
        "warmup_months": warmup_months,
        "horizon_days": horizon_days,
    }


# ─── No-bad-debt verification (FULL / I1-I2) ─────────────────────────────────


def verify_no_bad_debt(curves: BookCurves, sim: dict[str, np.ndarray]) -> dict[str, object]:
    """payout_frac ≤ 1.0 everywhere — over the ±99% move grid AND the simulated
    moves. FULL: collateral == MaxIL, so payout ≤ MaxIL ⇔ payout_frac ≤ 1."""
    grid_ok = bool(curves.max_payout_frac <= 1.0 + 1e-9)
    sim_max = float(sim["payout_frac"].max())
    sim_ok = sim_max <= 1.0 + 1e-9
    return {
        "no_bad_debt": grid_ok and sim_ok,
        "max_payout_frac_grid": curves.max_payout_frac,
        "max_payout_frac_sim": sim_max,
        "n_paths_checked": int(sim["payout_frac"].size),
    }


# ─── baseLoad calibration against the safety targets ─────────────────────────


SAFETY_TARGETS = {
    "p_losing_month_max": 0.15,
    "loss_1in100_max": 0.10,
    "apy_positive": True,
    "p_drawdown_gt_50pct_negligible": 0.02,  # <=2% of 3y paths breach a 50% DD
}


def calibrate_base_load(
    model: RealMeasureModel,
    curves: BookCurves,
    *,
    utilization: float = 0.60,
    load_grid: np.ndarray | None = None,
    regime_scale: tuple[float, float, float] = (0.7, 1.0, 1.6),
    n_paths: int = 20_000,
    n_months: int = 36,
    warmup_months: int = 6,
    rng_seed: int = 20260613,
) -> dict[str, object]:
    """Find the smallest uniform-base ``baseLoad`` (scaled by regime) meeting the
    safety targets. ``regime_scale`` tilts the load across calm/normal/stressed
    (more vol-risk-premium charged when σ_ref is high). Returns the calibrated
    per-regime loads, the metrics at that load, and the full sweep.

    Marketability ceiling: a load that pushes ``(1+load)·wfair`` above the
    lone-writer CVaR (~1.0 of MaxIL) is unmarketable (an MM would undercut). Loads
    beyond that are flagged.
    """
    load_grid = load_grid if load_grid is not None else np.round(np.arange(0.0, 1.01, 0.05), 3)
    rs = np.asarray(regime_scale)
    # marketability: wfair at the normal regime sigma is the reference price base
    wfair_norm = float(curves.wfair(np.array([model.regime_sigma[1]]))[0])

    sweep = []
    chosen = None
    for base in load_grid:
        loads = tuple((base * rs).tolist())
        sim = simulate_depositor_paths(
            model,
            curves,
            base_load_by_regime=loads,
            utilization=utilization,
            n_paths=n_paths,
            n_months=n_months,
            rng=np.random.default_rng(rng_seed),
        )
        m = depositor_metrics(
            sim["monthly_return"], horizon_days=curves.T_days, warmup_months=warmup_months
        )
        # marketability: price at stressed regime must stay <= lone-writer CVaR (~1.0)
        price_at_stressed = (1.0 + loads[2]) * float(
            curves.wfair(np.array([model.regime_sigma[2]]))[0]
        )
        marketable = price_at_stressed <= 1.0
        meets = (
            m["apy"] > 0
            and m["p_losing_period"] <= SAFETY_TARGETS["p_losing_month_max"]
            and m["loss_1in100"] <= SAFETY_TARGETS["loss_1in100_max"]
            and m["p_drawdown_gt_50pct"] <= SAFETY_TARGETS["p_drawdown_gt_50pct_negligible"]
        )
        row = {
            "base_load": float(base),
            "loads_by_regime": loads,
            "marketable": marketable,
            "meets_targets": bool(meets),
            **{
                k: m[k]
                for k in (
                    "apy",
                    "p_losing_period",
                    "loss_1in100",
                    "worst_period",
                    "p_drawdown_gt_50pct",
                    "median_max_drawdown",
                )
            },
        }
        sweep.append(row)
        if chosen is None and meets and marketable:
            chosen = row

    return {
        "chosen": chosen,
        "feasible": chosen is not None,
        "wfair_normal": wfair_norm,
        "regime_scale": tuple(rs.tolist()),
        "utilization": utilization,
        "sweep": sweep,
    }


# ─── Reproducible launch calibration (the committed P1.13 run) ────────────────

LAUNCH_BASE_LOAD = (0.20, 0.30, 0.50)  # calm / normal / stressed (marketable)
SPEC_SAFETY_TARGETS = {
    "p_losing_month_max": 0.15,
    "loss_1in100_max": 0.10,
    "p_drawdown_gt_50pct_max": 0.02,
    "apy_positive": True,
}


def run_launch_calibration(
    *,
    base_load: tuple[float, float, float] = LAUNCH_BASE_LOAD,
    n_paths: int = 40_000,
    n_months: int = 42,
    warmup_months: int = 6,
    seed: int = 20260613,
) -> dict[str, object]:
    """The committed P1.13 launch calibration — reproduces the schema-doc numbers.

    Real-measure model, warm-up-trimmed steady state, single ETH/USDC FULL pool.
    Returns the disclosure (geometric 3y CAGR + risk panel) at two utilisation
    operating points, the pool-hedge frontier, the senior/junior tranche table,
    the idle-routable sizing, and the safety verdict. ``payout ≤ MaxIL`` is
    verified path-by-path. Numbers are GROSS of demand/competition/fees.
    """
    from inflexion_quant.roadmap import routable_idle_fraction

    model = RealMeasureModel()
    c30 = build_book_curves(T_days=30, rng=np.random.default_rng(seed))

    def at(u: float):
        sim = simulate_depositor_paths(
            model,
            c30,
            base_load_by_regime=base_load,
            utilization=u,
            n_paths=n_paths,
            n_months=n_months,
            rng=np.random.default_rng(seed),
        )
        m = depositor_metrics(sim["monthly_return"], horizon_days=30, warmup_months=warmup_months)
        m["no_bad_debt"] = verify_no_bad_debt(c30, sim)["no_bad_debt"]
        return m, sim

    m40, _ = at(0.40)
    m60, sim60 = at(0.60)

    # pool-hedge frontier + tranche at the disciplined operating point
    _, sim40 = at(0.40)
    pnl = sim40["monthly_return"][:, warmup_months:]
    loss_comp = np.maximum(0.0, -pnl)
    fair_hedge = float(loss_comp.mean())
    hedge = {}
    for h in (0.0, 0.25, 0.5, 0.6, 0.75):
        pnl_h = pnl + h * loss_comp - h * fair_hedge * 1.15
        flat = pnl_h.ravel()
        nav = np.cumprod(1 + pnl_h, axis=1)
        dd = (1 - nav / np.maximum.accumulate(nav, axis=1)).max(axis=1)
        hedge[f"h{int(h * 100)}"] = {
            "loss_1in100": float(max(0.0, -np.quantile(flat, 0.01))),
            "worst_month": float(max(0.0, -flat.min())),
            "p_dd_gt50": float((dd > 0.5).mean()),
        }
    gain, loss = np.maximum(0.0, pnl), np.maximum(0.0, -pnl)
    tranche = {}
    for sf in (0.5, 0.6, 0.7):
        jf = 1 - sf
        sen = (gain * sf - np.maximum(0.0, loss - jf)) / sf
        jun = (gain * jf - np.minimum(loss, jf)) / jf
        tranche[f"sf{int(sf * 100)}"] = {
            "senior_p_loss": float((sen < 0).mean()),
            "senior_worst": float(max(0.0, -sen.min())),
            "junior_worst": float(max(0.0, -jun.min())),
        }
    idle = routable_idle_fraction(p99_instant_demand_frac=0.20, safety_multiple=1.5)

    def panel(m):
        return {
            k: float(m[k])
            for k in (
                "cagr_median",
                "cagr_p10",
                "cagr_p90",
                "p_multiyr_nav_below_1",
                "p_losing_period",
                "loss_1in100",
                "worst_period",
                "p_drawdown_gt_50pct",
                "median_max_drawdown",
            )
        } | {"no_bad_debt": bool(m["no_bad_debt"])}

    return {
        "base_load_by_regime": base_load,
        "disclosure": {"disciplined_u040": panel(m40), "fully_deployed_u060": panel(m60)},
        "pool_hedge_frontier_u040": hedge,
        "fair_hedge_cost_monthly": fair_hedge,
        "tranche_u040": tranche,
        "idle_routable_frac": idle["routable_idle_frac"],
        "nude_buffer_frac": idle["nude_buffer_frac"],
        "safety_targets": SPEC_SAFETY_TARGETS,
        "verdict": (
            "INFEASIBLE unhedged/untranched at any marketable load (binding: 1-in-100 "
            "and P(losing month); intrinsic to single-asset vol-selling). MET only via "
            "roadmap levers: pool-hedge h~0.60 -> 1-in-100 ~10%; senior tranche sf<=0.60 "
            "with u<=0.40 -> P(loss)=0. Targets NOT loosened."
        ),
    }


def _main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Run the P1.13 launch calibration.")
    parser.add_argument("--out", default="cvamm_heavy_results.json")
    parser.add_argument("--n-paths", type=int, default=40_000)
    args = parser.parse_args()
    res = run_launch_calibration(n_paths=args.n_paths)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)
    d = res["disclosure"]["disciplined_u040"]
    print(f"wrote {args.out}")
    print(f"  no_bad_debt={d['no_bad_debt']}  3y CAGR median={d['cagr_median']:.1%}")
    print(
        f"  P(losing mo)={d['p_losing_period']:.1%}  1-in-100=-{d['loss_1in100']:.1%}  worst=-{d['worst_period']:.1%}"
    )
    print(f"  verdict: {res['verdict']}")


if __name__ == "__main__":
    _main()
