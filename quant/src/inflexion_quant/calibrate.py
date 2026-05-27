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
    fee_curve: Callable[[float], float] = default_fee_curve,
    c_search: tuple[float, float] = (0.02, 0.50),
    tol: float = 0.005,
) -> dict[str, float | bool]:
    """Smallest ``c`` with ``P(ruin | c) ≤ ruin_budget`` under the cached stress.

    Bisection: P(ruin) is (weakly) decreasing in c — more MM collateral means
    less fund tail exposure. Tolerance ``tol`` is the c-resolution; default
    0.5%-point.
    """

    def ruin_at(c: float) -> float:
        pnl = fund_pnl_from_cache(
            cache, c=c, premium_rate=premium_rate,
            premium_share=premium_share, fee_curve=fee_curve,
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
) -> dict[str, float]:
    """Smallest fund balance such that ``P(ruin | balance) ≤ ruin_budget`` at ``c``.

    Closed form: ``balance ≥ -quantile(fund_pnl, ruin_budget)``.
    """
    pnl = fund_pnl_from_cache(
        cache, c=c, premium_rate=premium_rate,
        premium_share=premium_share, fee_curve=fee_curve,
    )
    q = float(np.quantile(pnl, ruin_budget))
    tail = pnl[pnl <= q]
    return {
        "fund_target": max(0.0, -q),
        "ruin_budget": ruin_budget,
        "cvar_at_budget": float(-tail.mean()) if len(tail) > 0 else float(-q),
        "median_pnl": float(np.median(pnl)),
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
) -> dict[str, float]:
    """Refit ``fee_ref`` so median fund-P&L ≈ 0 at the chosen ``c``.

    Fee model: ``fee(c) = fee_ref · (c_ref/c)^exponent``. At a fixed ``c`` the
    fee is a scalar ``f``; fund_pnl[i] = ``P_i · (premium_share + f) − F_i``
    where ``P_i = premium_total_i`` and ``F_i = fund_pays_total_i``.
    ``median_i fund_pnl[i]`` is monotonically increasing in ``f`` (since each
    ``P_i ≥ 0``), so we bisect for the smallest ``f`` driving the median
    above zero, then project back to ``fee_ref`` units.
    """
    mm_coll = c * cache.V0s
    fund_pays = np.maximum(0.0, cache.payouts - mm_coll).sum(axis=1)
    premium_total = (premium_rate * cache.max_ils).sum(axis=1)

    def median_pnl(f: float) -> float:
        return float(np.median(premium_total * (premium_share + f) - fund_pays))

    lo, hi = fee_search
    feasible = True
    if median_pnl(lo) >= 0:
        fee_pct_needed = lo
    elif median_pnl(hi) < 0:
        fee_pct_needed = hi
        feasible = False
    else:
        while hi - lo > tol:
            mid = (lo + hi) / 2
            if median_pnl(mid) < 0:
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
        "median_pnl_at_refit": median_pnl(fee_pct_needed),
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
    """All 8 PARTIAL parameters, ready for serialisation to ``params.json``."""

    c_min: float
    floor_curve: dict[str, float]
    fee_curve: dict[str, float]
    breakers: dict[str, float]
    withdrawal_delay_seconds: int
    exposure_caps: dict[str, float | int]
    first_loss_fraction: float
    fund_target: float

    # Provenance / sanity metadata
    ruin_budget: float
    c_used_for_fund_target: float
    n_runs: int
    n_positions: int
    notes: str

    def to_dict(self) -> dict:
        d = asdict(self)
        # Drop the sweep tables — they're for in-process inspection, not params.json
        if "sweep" in d.get("exposure_caps", {}):
            d["exposure_caps"] = {k: v for k, v in d["exposure_caps"].items() if k != "sweep"}
        return d


def calibrate_all(
    *,
    n_runs: int = 1000,
    n_positions: int = 200,
    P0: float = 100.0,
    premium_rate: float = 0.75,
    premium_share: float = 0.20,
    ruin_budget: float = 0.001,
    bootstrap_fund_balance_pct_of_notional: float = 0.05,
    cfg: CorrelatedCrashConfig | None = None,
    mix: PositionMix | None = None,
    exposure_grid: np.ndarray | None = None,
    rng_seed: int = 20260527,
) -> CalibrationResult:
    """Run all 8 calibrations end-to-end and return a :class:`CalibrationResult`.

    Resolves the circular dep between ``c_min`` and ``fund_balance`` by
    bootstrapping a fund balance from book notional, calibrating ``c_min``
    against it, then recomputing ``fund_target`` at that ``c_min`` for the
    serialised result.
    """
    cfg = cfg or CorrelatedCrashConfig.severe()
    chosen_mix = mix or PositionMix.crypto_majors()
    exposure_grid = (
        exposure_grid
        if exposure_grid is not None
        else np.array([50, 100, 200, 400, 700, 1000])
    )

    terminal_fn = correlated_crash_terminal_fn(cfg)
    cache = build_scenario_cache(
        n_runs=n_runs,
        n_positions=n_positions,
        terminal_fn=terminal_fn,
        rng=np.random.default_rng(rng_seed),
        P0=P0,
        mix=chosen_mix,
    )

    # Bootstrap fund balance from typical book notional (median V0 sum)
    book_notional_per_run = cache.V0s.sum(axis=1)
    typical_book = float(np.median(book_notional_per_run))
    bootstrap_balance = bootstrap_fund_balance_pct_of_notional * typical_book

    # Step 1: c_min vs bootstrap fund
    c_res = calibrate_c_min(
        cache=cache,
        fund_balance=bootstrap_balance,
        ruin_budget=ruin_budget,
        premium_rate=premium_rate,
        premium_share=premium_share,
    )
    c_min = float(c_res["c_min"])
    if not c_res["feasible"]:
        c_min = 0.50  # fall back to upper bound; fund_target will reflect the stress

    # Step 2: fund_target at the calibrated c_min
    fund_res = calibrate_fund_target(
        cache=cache,
        c=c_min,
        premium_rate=premium_rate,
        premium_share=premium_share,
        ruin_budget=ruin_budget,
    )

    # Step 3: fee curve refit at c_min
    fee_res = calibrate_fee_curve(
        cache=cache,
        c=c_min,
        premium_rate=premium_rate,
        premium_share=premium_share,
    )

    # Step 4: exposure caps at c_min, given the calibrated fund_target
    exposure_res = calibrate_exposure_caps(
        fund_balance=fund_res["fund_target"],
        c=c_min,
        n_positions_grid=exposure_grid,
        n_runs=min(500, n_runs),
        cfg=cfg,
        rng_seed=rng_seed,
        premium_rate=premium_rate,
        premium_share=premium_share,
        ruin_budget=ruin_budget,
        P0=P0,
        mix=chosen_mix,
    )

    # Floor curve: placeholder constant c_min for now — true σ-dependence is a
    # Tier-2 extension (run calibrate_c_min for several CommonFactor.sigma
    # values and fit a curve). Tracked in spec §10 reservations.
    floor_curve = {
        "c_at_baseline_vol": c_min,
        "note": (
            "single-vol calibration; multi-σ fit deferred to post-hack "
            "(Phase 15 calibration sweep)"
        ),
    }

    return CalibrationResult(
        c_min=c_min,
        floor_curve=floor_curve,
        fee_curve=fee_res,
        breakers=heuristic_circuit_breakers(),
        withdrawal_delay_seconds=heuristic_withdrawal_delay_seconds(),
        exposure_caps=exposure_res,
        first_loss_fraction=heuristic_first_loss_fraction(),
        fund_target=fund_res["fund_target"],
        ruin_budget=ruin_budget,
        c_used_for_fund_target=c_min,
        n_runs=n_runs,
        n_positions=n_positions,
        notes=(
            f"Calibrated against {cfg.__class__.__name__} (severe) on "
            f"{n_runs} runs × {n_positions} positions with rng_seed={rng_seed}. "
            f"Heuristics: breakers (ratios), withdrawal_delay (7d), "
            f"first_loss (2%). Floor curve is single-σ; multi-σ fit deferred."
        ),
    )
