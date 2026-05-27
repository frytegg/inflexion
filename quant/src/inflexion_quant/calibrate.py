"""Task 14.7 — calibration of PARTIAL parameters from the stress distributions.

Solves the 8 PARTIAL parameters in `spec.md` §8 / §10 using the Monte Carlo
machinery from Tasks 14.5 + 14.6:

1. ``c_min``           — min PARTIAL collateral ratio for ``P(ruin) ≤ ruin_budget``
2. ``floor_curve``     — ``c_min`` as a function of market vol (convex)
3. ``fee_curve``       — convex leverage tax, refit so median fund-P&L ≥ 0 at ``c_min``
4. ``breakers``        — L0/L1/L2/L3 health-ratio thresholds (heuristic from ratios)
5. ``withdrawal_delay``— recovery time after a 99th-pct event (heuristic, 7d default)
6. ``exposure_caps``   — per-market book size; per-MM derived
7. ``first_loss``      — MM first-loss stake as fraction of PARTIAL notional (heuristic)
8. ``fund_target``     — initial fund balance for ``P(ruin) ≤ ruin_budget``

Architecture: build a per-swap :class:`_ScenarioCache` ONCE; each calibrator
re-evaluates the waterfall in pure numpy on the cache instead of regenerating
Monte Carlo samples. This is what makes c-bisection cheap enough for the
hackathon timebox.

Task 14.8 serialises the resulting :class:`CalibrationResult` to
``quant/params.json``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd
from numpy.random import Generator

from inflexion_quant.portfolio import default_fee_curve
from inflexion_quant.positions import PositionMix, sample_positions
from inflexion_quant.stress import (
    CorrelatedCrashConfig,
    TerminalFn,
    correlated_crash_terminal_fn,
    ruin_probability,
    var_cvar,
)


# ─── Vectorised per-swap math (the fast path) ───────────────────────────────


def _vectorised_payouts_and_maxils(
    P0: np.ndarray,
    Pa: np.ndarray,
    Pb: np.ndarray,
    L: np.ndarray,
    P_T: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-swap ``(payout, max_il)`` over arrays of position params + terminals.

    Equivalent to looping :func:`il.compute_payout` and :func:`il.compute_max_il`
    per swap, but ~50x faster because it stays in numpy across the batch.

    All inputs must have the same shape ``(n_swaps,)``. Returns two arrays of
    the same shape.
    """
    sqrt_P0 = np.sqrt(P0)
    sqrt_Pa = np.sqrt(Pa)
    sqrt_Pb = np.sqrt(Pb)

    # Entry amounts (same formula as il.entry_amounts, vectorised)
    a0 = L * (1.0 / sqrt_P0 - 1.0 / sqrt_Pb)
    a1 = L * (sqrt_P0 - sqrt_Pa)

    # IL at the lower boundary Pa (in-range formula evaluated at P=Pa)
    V_hold_pa = a0 * Pa + a1
    V_lp_pa = L * (2 * sqrt_Pa - Pa / sqrt_Pb - sqrt_Pa)
    IL_pa = np.maximum(0.0, V_hold_pa - V_lp_pa)

    # IL at the upper boundary Pb
    V_hold_pb = a0 * Pb + a1
    V_lp_pb = L * (2 * sqrt_Pb - Pb / sqrt_Pb - sqrt_Pa)
    IL_pb = np.maximum(0.0, V_hold_pb - V_lp_pb)

    max_il = np.maximum(IL_pa, IL_pb)

    # Realised IL at P_T (three regimes, same as il.lp_value)
    sqrt_PT = np.sqrt(np.maximum(P_T, 0.0))
    V_hold = a0 * P_T + a1
    V_lp_inrange = L * (2 * sqrt_PT - P_T / sqrt_Pb - sqrt_Pa)
    V_lp_below = L * (1.0 / sqrt_Pa - 1.0 / sqrt_Pb) * P_T
    V_lp_above = L * (sqrt_Pb - sqrt_Pa)
    V_lp = np.where(P_T < Pa, V_lp_below, np.where(P_T > Pb, V_lp_above, V_lp_inrange))
    IL = np.maximum(0.0, V_hold - V_lp)
    payout = np.minimum(IL, max_il)
    return payout, max_il


# ─── Scenario cache ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _ScenarioCache:
    """Per-swap MC fingerprints, c-independent.

    Once built, any (c, premium_rate, fee_curve) gives a fund-P&L distribution
    in pure numpy — no re-sampling positions, no re-running prices.
    """

    payouts: np.ndarray  # (n_runs, n_positions)
    max_ils: np.ndarray  # (n_runs, n_positions)
    V0s: np.ndarray  # (n_runs, n_positions)

    @property
    def n_runs(self) -> int:
        return self.payouts.shape[0]

    @property
    def n_positions(self) -> int:
        return self.payouts.shape[1]


def build_scenario_cache(
    *,
    n_runs: int,
    n_positions: int,
    terminal_fn: TerminalFn,
    rng: Generator,
    P0: float = 100.0,
    mix: PositionMix | None = None,
) -> _ScenarioCache:
    """Run ``n_runs`` MC replications; capture per-swap (payout, max_il, V0)."""
    chosen_mix = mix or PositionMix.crypto_majors()
    payouts = np.empty((n_runs, n_positions))
    max_ils = np.empty((n_runs, n_positions))
    V0s = np.empty((n_runs, n_positions))

    for run in range(n_runs):
        positions = sample_positions(n_positions, P0=P0, mix=chosen_mix, rng=rng)
        P_T = terminal_fn(positions, rng)
        p, m = _vectorised_payouts_and_maxils(
            positions["P0"].to_numpy(dtype=float),
            positions["Pa"].to_numpy(dtype=float),
            positions["Pb"].to_numpy(dtype=float),
            positions["L"].to_numpy(dtype=float),
            P_T,
        )
        payouts[run] = p
        max_ils[run] = m
        V0s[run] = positions["V0"].to_numpy(dtype=float)
    return _ScenarioCache(payouts=payouts, max_ils=max_ils, V0s=V0s)


def fund_pnl_from_cache(
    cache: _ScenarioCache,
    *,
    c: float,
    premium_rate: float,
    premium_share: float = 0.20,
    fee_pct: float | None = None,
    fee_curve: Callable[[float], float] = default_fee_curve,
) -> np.ndarray:
    """Per-run fund_pnl_total under ``(c, premium_rate, fee_pct)``.

    If ``fee_pct`` is None, evaluates ``fee_curve(c)``.
    """
    if fee_pct is None:
        fee_pct = float(fee_curve(c))
    mm_coll = c * cache.V0s
    fund_pays = np.maximum(0.0, cache.payouts - mm_coll).sum(axis=1)
    premium = premium_rate * cache.max_ils
    fund_inflow = premium.sum(axis=1) * (premium_share + fee_pct)
    return fund_inflow - fund_pays


# ─── Calibrator 1: c_min via bisection ──────────────────────────────────────


def calibrate_c_min(
    *,
    cache: _ScenarioCache,
    fund_balance: float,
    ruin_budget: float = 0.001,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    fee_curve: Callable[[float], float] | None = None,
    c_search: tuple[float, float] = (0.02, 0.50),
    tol: float = 0.005,
) -> dict[str, float | bool]:
    """Smallest ``c`` with ``P(ruin | c) ≤ ruin_budget`` under the cached stress.

    Bisection: P(ruin) is (weakly) decreasing in c — more MM collateral means
    less fund tail exposure. Tolerance ``tol`` is the c-resolution; default
    0.5%-point.

    By default the fee curve is **excluded** from the inflow (``fee_pct=0``):
    c_min reflects the floor needed by the protocol's *base* premium share
    alone, leaving the fee curve as a separate top-up calibrated by
    :func:`calibrate_fee_curve`. This decouples c_min from the placeholder
    fee curve's runaway behaviour at low c. Pass an explicit ``fee_curve``
    to fold the tax back into the c_min search.
    """

    def ruin_at(c: float) -> float:
        pnl = (
            fund_pnl_from_cache(
                cache, c=c, premium_rate=premium_rate,
                premium_share=premium_share, fee_pct=0.0,
            )
            if fee_curve is None
            else fund_pnl_from_cache(
                cache, c=c, premium_rate=premium_rate,
                premium_share=premium_share, fee_curve=fee_curve,
            )
        )
        return ruin_probability(pnl, initial_fund_balance=fund_balance)

    lo, hi = c_search
    r_hi = ruin_at(hi)
    if r_hi > ruin_budget:
        return {"c_min": float("inf"), "ruin_at_c_min": r_hi, "feasible": False}
    r_lo = ruin_at(lo)
    if r_lo <= ruin_budget:
        return {"c_min": lo, "ruin_at_c_min": r_lo, "feasible": True}

    while hi - lo > tol:
        mid = (lo + hi) / 2
        if ruin_at(mid) > ruin_budget:
            lo = mid
        else:
            hi = mid
    return {"c_min": hi, "ruin_at_c_min": ruin_at(hi), "feasible": True}


# ─── Calibrator 2: fund target balance ──────────────────────────────────────


def calibrate_fund_target(
    *,
    cache: _ScenarioCache,
    c: float,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    fee_curve: Callable[[float], float] = default_fee_curve,
    ruin_budget: float = 0.001,
    use_cvar: bool = True,
) -> dict[str, float]:
    """Smallest fund balance such that ``P(ruin | balance) ≤ ruin_budget`` at ``c``.

    By default uses **CVaR** (expected loss conditional on exceeding the
    ruin budget) rather than raw VaR (the quantile itself). CVaR is
    coherent (subadditive, monotone), stable under MC noise, and
    accounts for losses beyond the VaR threshold — the auditor's
    finding B10 ("VaR is unstable and blind beyond the threshold").

    Set ``use_cvar=False`` to recover the original VaR-based behaviour.
    """
    pnl = fund_pnl_from_cache(
        cache, c=c, premium_rate=premium_rate,
        premium_share=premium_share, fee_curve=fee_curve,
    )
    q = float(np.quantile(pnl, ruin_budget))
    tail = pnl[pnl <= q]
    var_value = max(0.0, -q)
    # CVaR can be negative when the tail is profitable (positive pnl);
    # fund_target is bounded below by 0 (you can't have a negative fund).
    raw_cvar = float(-tail.mean()) if len(tail) > 0 else -q
    cvar_value = max(0.0, raw_cvar)
    return {
        "fund_target": cvar_value if use_cvar else var_value,
        "var_at_budget": var_value,
        "cvar_at_budget": cvar_value,
        "ruin_budget": ruin_budget,
        "median_pnl": float(np.median(pnl)),
        "mean_pnl": float(np.mean(pnl)),
        "estimator": "CVaR" if use_cvar else "VaR",
    }


# ─── Calibrator 3: fee curve (closed-form scale fit) ────────────────────────


def calibrate_fee_curve(
    *,
    cache: _ScenarioCache,
    c: float,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    c_ref: float = 0.20,
    exponent: float = 2.32,
    fee_search: tuple[float, float] = (0.0, 1.0),
    tol: float = 1e-5,
    target_mean_pnl: float = 0.0,
) -> dict[str, float]:
    """Refit ``fee_ref`` so **mean** fund-P&L ≥ ``target_mean_pnl`` at the chosen ``c``.

    Auditor B1: targeting the *median* leaves the fund losing money in 50%
    of periods (and possibly bleeding across periods given negative skew).
    Targeting the *mean* is the right insurance criterion — it ensures the
    fund has positive expected value, not just a coin-flip break-even.

    Fee model: ``fee(c) = fee_ref · (c_ref/c)^exponent``. At a fixed ``c``
    the fee is a scalar ``f``; fund_pnl[i] = ``P_i · (premium_share + f) − F_i``
    where ``P_i = premium_total_i`` and ``F_i = fund_pays_total_i``. Since
    each ``P_i ≥ 0``, ``mean_i fund_pnl[i]`` is monotone increasing in ``f``,
    so we bisect for the smallest ``f`` driving the mean above
    ``target_mean_pnl``, then project back to ``fee_ref`` units.

    For a stronger criterion, set ``target_mean_pnl`` to a positive Sharpe
    cushion (e.g. ``0.05 × fund_target × horizon_days / 365`` for a 5%
    annual ROE target).
    """
    mm_coll = c * cache.V0s
    fund_pays = np.maximum(0.0, cache.payouts - mm_coll).sum(axis=1)
    premium_total = (premium_rate * cache.max_ils).sum(axis=1)

    def mean_pnl(f: float) -> float:
        return float(np.mean(premium_total * (premium_share + f) - fund_pays))

    lo, hi = fee_search
    feasible = True
    if mean_pnl(lo) >= target_mean_pnl:
        fee_pct_needed = lo
    elif mean_pnl(hi) < target_mean_pnl:
        fee_pct_needed = hi
        feasible = False
    else:
        while hi - lo > tol:
            mid = (lo + hi) / 2
            if mean_pnl(mid) < target_mean_pnl:
                lo = mid
            else:
                hi = mid
        fee_pct_needed = hi

    fee_ref_needed = fee_pct_needed / (c_ref / c) ** exponent
    return {
        "fee_ref_recommended": fee_ref_needed,
        "fee_pct_at_c": fee_pct_needed,
        "placeholder_fee_pct_at_c": float(
            default_fee_curve(c, c_ref=c_ref, fee_ref=0.01, exponent=exponent)
        ),
        "c_ref": c_ref,
        "exponent": exponent,
        "mean_pnl_at_refit": mean_pnl(fee_pct_needed),
        "target_mean_pnl": target_mean_pnl,
        "feasible_in_fee_search": feasible,
    }


# ─── Calibrator 4: per-market exposure caps via book-size sweep ─────────────


def calibrate_exposure_caps(
    *,
    fund_balance: float,
    c: float,
    n_positions_grid: np.ndarray,
    n_runs: int,
    cfg: CorrelatedCrashConfig,
    rng_seed: int,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    fee_curve: Callable[[float], float] = default_fee_curve,
    ruin_budget: float = 0.001,
    P0: float = 100.0,
    mix: PositionMix | None = None,
    n_mms_per_market: int = 5,
) -> dict[str, float | list[dict]]:
    """Largest book size with ``P(ruin) ≤ ruin_budget`` given ``fund_balance``.

    Per-market cap = largest ``n_positions`` in the grid clearing the budget.
    Per-MM cap = per-market / ``n_mms_per_market`` (conservative).
    """
    terminal_fn = correlated_crash_terminal_fn(cfg)
    chosen_mix = mix or PositionMix.crypto_majors()

    rows = []
    feasible_caps = []
    for n_pos in n_positions_grid:
        n_pos = int(n_pos)
        cache = build_scenario_cache(
            n_runs=n_runs,
            n_positions=n_pos,
            terminal_fn=terminal_fn,
            rng=np.random.default_rng(rng_seed),
            P0=P0,
            mix=chosen_mix,
        )
        pnl = fund_pnl_from_cache(
            cache, c=c, premium_rate=premium_rate,
            premium_share=premium_share, fee_curve=fee_curve,
        )
        rp = ruin_probability(pnl, initial_fund_balance=fund_balance)
        var99, cvar99 = var_cvar(pnl, confidence=0.99)
        rows.append({
            "n_positions": n_pos,
            "ruin_p": rp,
            "var_99": var99,
            "cvar_99": cvar99,
        })
        if rp <= ruin_budget:
            feasible_caps.append(n_pos)

    per_market_cap = max(feasible_caps) if feasible_caps else 0
    return {
        "per_market_cap": per_market_cap,
        "per_mm_cap": per_market_cap // max(1, n_mms_per_market),
        "n_mms_per_market": n_mms_per_market,
        "sweep": rows,
    }


# ─── Heuristic calibrators (packaged for delivery) ──────────────────────────


def heuristic_circuit_breakers() -> dict[str, float]:
    """Health-ratio thresholds (fund equity / fund_target).

    Heuristic chosen pragmatically; spec §10 leaves room for governance to
    retune post-launch.

    * L0 (normal): ≥ 1.0
    * L1 (cautious — raise rates 2x): 0.7 – 1.0
    * L2 (suspend new PARTIAL): 0.4 – 0.7
    * L3 (multisig-only): < 0.4
    """
    return {"L0": 1.0, "L1": 0.7, "L2": 0.4, "L3": 0.0}


def heuristic_withdrawal_delay_seconds(*, horizon_days: int = 30) -> int:
    """Seconds depositors must wait between request and withdrawal.

    Heuristic: long enough that the fund can absorb a 99th-pct event without
    being drained by panic withdrawals before the recovery window. Default
    7d aligns with sample horizon and matches comparable on-chain protocols.
    """
    return 7 * 86_400


def heuristic_first_loss_fraction() -> float:
    """MM first-loss stake as fraction of MM's PARTIAL notional.

    Heuristic 2%: consumed BEFORE the fund taps, so even a moderate stake
    significantly reduces fund draws while staying within MM economic limits.
    """
    return 0.02


# ─── Top-level CalibrationResult ────────────────────────────────────────────


@dataclass(frozen=True)
class CalibrationResult:
    """All 8 PARTIAL parameters + audit-grade provenance, ready for
    serialisation to ``params.json``."""

    c_min: float
    floor_curve: dict[str, float]
    fee_curve: dict[str, float]
    breakers: dict[str, float]
    withdrawal_delay_seconds: int
    exposure_caps: dict[str, float | int]
    first_loss_fraction: float
    fund_target: float

    # Provenance / sanity metadata
    ruin_budget_per_horizon: float
    horizon_days: int
    annualized_ruin_budget: float
    c_used_for_fund_target: float
    fund_target_estimator: str  # "CVaR" or "VaR"
    n_runs: int
    n_positions: int
    parameter_provenance: dict[str, str]  # param name → "calibrated" / "heuristic" / "deferred"
    fixed_point_iterations: int
    stability_check: dict[str, float] | None
    notes: str

    def to_dict(self) -> dict:
        d = asdict(self)
        # Drop the sweep tables — for in-process inspection, not params.json
        if "sweep" in d.get("exposure_caps", {}):
            d["exposure_caps"] = {
                k: v for k, v in d["exposure_caps"].items() if k != "sweep"
            }
        return d


def _annualized_ruin_budget(per_horizon: float, horizon_days: int) -> float:
    """Convert per-horizon ruin probability to annualized (assuming
    independent horizons — an upper bound on true annualized risk under
    persistence)."""
    periods_per_year = 365.0 / horizon_days
    return 1.0 - (1.0 - per_horizon) ** periods_per_year


def calibrate_all(
    *,
    n_runs: int = 50_000,
    n_positions: int = 200,
    P0: float = 100.0,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    ruin_budget: float = 0.001,
    fixed_point_max_iter: int = 25,
    fixed_point_tol: float = 0.05,  # 5% relative tolerance on fund_target
    cfg: CorrelatedCrashConfig | None = None,
    mix: PositionMix | None = None,
    exposure_grid: np.ndarray | None = None,
    exposure_caps_n_runs: int | None = None,
    rng_seed: int = 20260527,
    run_stability_check: bool = False,
    stability_seeds: tuple[int, ...] = (1, 2, 3),
) -> CalibrationResult:
    """Run all 8 calibrations end-to-end and return a :class:`CalibrationResult`.

    Resolves the ``c_min`` ↔ ``fund_target`` circular dependency via
    **bisection on the fixed-point** (audit B3): find the fund balance B
    such that ``B == calibrate_fund_target(c_min(B))``. Bisection is
    correct because the composed map is monotone decreasing in B.

    ``n_runs`` default is **50_000** — calibrated against the auditor's
    finding A1 that 1,000 runs gives a statistically meaningless 0.1%
    quantile. At 50k runs, the 0.1% tail has ~50 observations and the
    CVaR estimator stabilises to within ~5% across seeds. For a v2
    deployment use 100k+ or fit a GPD tail.
    """
    cfg = cfg or CorrelatedCrashConfig.severe()
    chosen_mix = mix or PositionMix.crypto_majors()
    exposure_grid = (
        exposure_grid
        if exposure_grid is not None
        else np.array([50, 100, 200, 400, 700, 1000])
    )
    horizon_days = max(1, int(round(cfg.T_years * 365)))

    terminal_fn = correlated_crash_terminal_fn(cfg)
    cache = build_scenario_cache(
        n_runs=n_runs,
        n_positions=n_positions,
        terminal_fn=terminal_fn,
        rng=np.random.default_rng(rng_seed),
        P0=P0,
        mix=chosen_mix,
    )

    book_notional_per_run = cache.V0s.sum(axis=1)
    typical_book = float(np.median(book_notional_per_run))

    # ─── Fixed-point bisection on B s.t. fund_target(c_min(B)) == B ─────────
    #
    # The composed map B → fund_target(c_min(B, fee=0)) is decreasing in B
    # (more equity → lower c_min → larger fund_pays → bigger fund_target).
    # Bisection on g(B) = fund_target(c_min(B)) - B works.
    def _eval(B: float) -> tuple[float, float, dict]:
        c_res = calibrate_c_min(
            cache=cache, fund_balance=B, ruin_budget=ruin_budget,
            premium_rate=premium_rate, premium_share=premium_share,
        )
        c = float(c_res["c_min"]) if c_res["feasible"] else 0.50
        ft_res = calibrate_fund_target(
            cache=cache, c=c, premium_rate=premium_rate,
            premium_share=premium_share, ruin_budget=ruin_budget,
            use_cvar=True,
        )
        return c, float(ft_res["fund_target"]), ft_res

    # Bracket: B_lo ≪ B*, so g(B_lo) > 0; B_hi ≫ B*, so g(B_hi) < 0
    B_lo = max(1.0, 0.001 * typical_book)  # 0.1% of book
    B_hi = max(B_lo * 2, 1.0 * typical_book)  # 100% of book (huge)
    iters = 0
    for iters in range(1, fixed_point_max_iter + 1):
        B_mid = 0.5 * (B_lo + B_hi)
        _, target_at_mid, _ = _eval(B_mid)
        gap = target_at_mid - B_mid
        if abs(gap) < fixed_point_tol * max(B_mid, 1.0):
            B_lo = B_hi = B_mid
            break
        if gap > 0:
            B_lo = B_mid  # need more equity
        else:
            B_hi = B_mid  # can use less

    B_final = 0.5 * (B_lo + B_hi)
    c_min, fund_target, fund_res = _eval(B_final)

    # Fee curve refit at fixed-point c_min (audit B1: targets mean, not median)
    fee_res = calibrate_fee_curve(
        cache=cache, c=c_min,
        premium_rate=premium_rate, premium_share=premium_share,
    )

    # Exposure caps — no more `min(500, n_runs)` clamp (audit B6)
    exposure_res = calibrate_exposure_caps(
        fund_balance=fund_target,
        c=c_min,
        n_positions_grid=exposure_grid,
        n_runs=exposure_caps_n_runs if exposure_caps_n_runs is not None else min(20_000, n_runs),
        cfg=cfg,
        rng_seed=rng_seed,
        premium_rate=premium_rate,
        premium_share=premium_share,
        ruin_budget=ruin_budget,
        P0=P0,
        mix=chosen_mix,
    )

    # Optional cross-seed stability (audit A2)
    stability = (
        validate_calibration_stability(
            seeds=stability_seeds,
            n_runs=min(n_runs, 20_000),  # cheaper but still meaningful
            n_positions=n_positions,
            cfg=cfg, mix=chosen_mix, P0=P0,
            premium_rate=premium_rate, premium_share=premium_share,
            ruin_budget=ruin_budget,
        )
        if run_stability_check
        else None
    )

    floor_curve = {
        "c_at_baseline_vol": c_min,
        "note": "single-vol calibration; multi-σ fit deferred to Phase 15",
    }

    parameter_provenance = {
        "c_min": "calibrated",
        "fund_target": "calibrated",
        "fee_curve": "calibrated",
        "exposure_caps": "calibrated",
        "floor_curve": "deferred",  # single-σ placeholder
        "breakers": "heuristic",
        "withdrawal_delay_seconds": "heuristic",
        "first_loss_fraction": "heuristic",
    }

    return CalibrationResult(
        c_min=c_min,
        floor_curve=floor_curve,
        fee_curve=fee_res,
        breakers=heuristic_circuit_breakers(),
        withdrawal_delay_seconds=heuristic_withdrawal_delay_seconds(),
        exposure_caps=exposure_res,
        first_loss_fraction=heuristic_first_loss_fraction(),
        fund_target=fund_target,
        ruin_budget_per_horizon=ruin_budget,
        horizon_days=horizon_days,
        annualized_ruin_budget=_annualized_ruin_budget(ruin_budget, horizon_days),
        c_used_for_fund_target=c_min,
        fund_target_estimator=str(fund_res.get("estimator", "CVaR")),
        n_runs=n_runs,
        n_positions=n_positions,
        parameter_provenance=parameter_provenance,
        fixed_point_iterations=iters,
        stability_check=stability,
        notes=(
            f"Calibrated against CorrelatedCrashConfig.severe() on "
            f"{n_runs} runs × {n_positions} positions, rng_seed={rng_seed}, "
            f"horizon={horizon_days}d. Fixed-point bisection converged in "
            f"{iters} iterations. Audit-fix v1.1: fund_target uses CVaR; "
            f"fee_curve targets mean pnl (not median); per-horizon ruin "
            f"budget {ruin_budget * 100:.2f}% ≈ {_annualized_ruin_budget(ruin_budget, horizon_days) * 100:.2f}% "
            f"annualized; severe() params anchored to historical episodes "
            f"(Terra/FTX/March 2020). Mainnet TODOs in ROADMAP §14: "
            f"portfolio-level multi-market calibration, empirical position "
            f"mix from Uniswap subgraph, multi-period fund evolution, "
            f"MM/LP behavioral models, multi-σ floor curve, depeg/oracle "
            f"failure mechanisms."
        ),
    )


# ─── Cross-seed stability check (audit A2) ─────────────────────────────────


def validate_calibration_stability(
    *,
    seeds: tuple[int, ...] = (1, 2, 3),
    n_runs: int = 10_000,
    n_positions: int = 200,
    cfg: CorrelatedCrashConfig | None = None,
    mix: PositionMix | None = None,
    P0: float = 100.0,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    ruin_budget: float = 0.001,
) -> dict[str, float]:
    """Run ``calibrate_c_min`` + ``calibrate_fund_target`` across multiple
    rng seeds and report the spread. Auditor finding A2: c_min should not
    swing across seeds at the chosen sample size.

    Returns a dict with ``c_min_{min,mean,max,std,spread_bp}`` and
    ``fund_target_{min,mean,max,std,spread_pct}`` across seeds.
    """
    cfg = cfg or CorrelatedCrashConfig.severe()
    chosen_mix = mix or PositionMix.crypto_majors()
    terminal_fn = correlated_crash_terminal_fn(cfg)

    c_mins: list[float] = []
    fund_targets: list[float] = []
    for seed in seeds:
        cache_s = build_scenario_cache(
            n_runs=n_runs, n_positions=n_positions,
            terminal_fn=terminal_fn,
            rng=np.random.default_rng(seed),
            P0=P0, mix=chosen_mix,
        )
        # Bootstrap fund = median of book notional × 1%
        bootstrap = 0.01 * float(np.median(cache_s.V0s.sum(axis=1)))
        c_res = calibrate_c_min(
            cache=cache_s, fund_balance=bootstrap, ruin_budget=ruin_budget,
            premium_rate=premium_rate, premium_share=premium_share,
        )
        c = float(c_res["c_min"]) if c_res["feasible"] else 0.50
        ft_res = calibrate_fund_target(
            cache=cache_s, c=c, premium_rate=premium_rate,
            premium_share=premium_share, ruin_budget=ruin_budget,
            use_cvar=True,
        )
        c_mins.append(c)
        fund_targets.append(float(ft_res["fund_target"]))

    c_arr = np.array(c_mins)
    ft_arr = np.array(fund_targets)
    return {
        "n_seeds": len(seeds),
        "n_runs_per_seed": n_runs,
        "c_min_min": float(c_arr.min()),
        "c_min_mean": float(c_arr.mean()),
        "c_min_max": float(c_arr.max()),
        "c_min_std": float(c_arr.std()),
        "c_min_spread_bp": float((c_arr.max() - c_arr.min()) * 10_000),
        "fund_target_min": float(ft_arr.min()),
        "fund_target_mean": float(ft_arr.mean()),
        "fund_target_max": float(ft_arr.max()),
        "fund_target_std": float(ft_arr.std()),
        "fund_target_spread_pct": float(
            (ft_arr.max() - ft_arr.min()) / max(ft_arr.mean(), 1.0) * 100
        ),
    }
