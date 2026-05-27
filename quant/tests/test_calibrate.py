"""Tests for inflexion_quant.calibrate — Task 14.7."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from inflexion_quant.calibrate import (
    CalibrationResult,
    _ScenarioCache,
    _vectorised_payouts_and_maxils,
    build_scenario_cache,
    calibrate_all,
    calibrate_c_min,
    calibrate_exposure_caps,
    calibrate_fee_curve,
    calibrate_fund_target,
    fund_pnl_from_cache,
    heuristic_circuit_breakers,
    heuristic_first_loss_fraction,
    heuristic_withdrawal_delay_seconds,
)
from inflexion_quant.il import compute_max_il, compute_payout
from inflexion_quant.portfolio import WaterfallConfig, aggregate, waterfall
from inflexion_quant.positions import PositionMix, sample_positions
from inflexion_quant.stress import (
    CorrelatedCrashConfig,
    correlated_crash_terminal_fn,
)


# ─── CORRECTNESS: vectorised math must match the loop-based il.py ───────────


def test_vectorised_matches_il_module_per_position():
    """Vectorised (payout, max_il) must agree with il.compute_payout/max_il
    swap-by-swap. This is the load-bearing correctness check for everything
    downstream in calibrate.py."""
    rng = np.random.default_rng(1)
    positions = sample_positions(80, P0=100.0, mix=PositionMix.crypto_majors(), rng=rng)
    P_T = positions["P0"].to_numpy(dtype=float) * np.exp(rng.normal(0, 0.3, 80))

    payout_vec, max_il_vec = _vectorised_payouts_and_maxils(
        positions["P0"].to_numpy(dtype=float),
        positions["Pa"].to_numpy(dtype=float),
        positions["Pb"].to_numpy(dtype=float),
        positions["L"].to_numpy(dtype=float),
        P_T,
    )

    for i in range(len(positions)):
        P0_i = float(positions["P0"].iloc[i])
        Pa_i = float(positions["Pa"].iloc[i])
        Pb_i = float(positions["Pb"].iloc[i])
        L_i = float(positions["L"].iloc[i])
        expected_payout = float(compute_payout(P_T[i], P0_i, Pa_i, Pb_i, L_i))
        expected_max_il = compute_max_il(P0_i, Pa_i, Pb_i, L_i)
        assert payout_vec[i] == pytest.approx(expected_payout, rel=1e-9, abs=1e-9)
        assert max_il_vec[i] == pytest.approx(expected_max_il, rel=1e-9, abs=1e-9)


def test_vectorised_in_below_above_regimes():
    """Cover all three lp_value regimes explicitly: P_T<Pa, in-range, P_T>Pb."""
    rng = np.random.default_rng(2)
    positions = sample_positions(30, P0=100.0, mix=PositionMix.crypto_majors(), rng=rng)
    Pa = positions["Pa"].to_numpy(dtype=float)
    Pb = positions["Pb"].to_numpy(dtype=float)

    # Force one P_T per regime per swap
    for label, P_T in [
        ("below", 0.5 * Pa),
        ("inside", 0.5 * (Pa + Pb)),
        ("above", 1.5 * Pb),
    ]:
        payout_vec, _ = _vectorised_payouts_and_maxils(
            positions["P0"].to_numpy(dtype=float), Pa, Pb,
            positions["L"].to_numpy(dtype=float), P_T,
        )
        for i in range(len(positions)):
            expected = float(compute_payout(
                P_T[i],
                float(positions["P0"].iloc[i]),
                float(positions["Pa"].iloc[i]),
                float(positions["Pb"].iloc[i]),
                float(positions["L"].iloc[i]),
            ))
            assert payout_vec[i] == pytest.approx(expected, rel=1e-9, abs=1e-9), (
                f"regime {label}, swap {i}"
            )


# ─── Scenario cache ─────────────────────────────────────────────────────────


def _build_test_cache(n_runs=20, n_positions=40, seed=42):
    cfg = CorrelatedCrashConfig.moderate()
    return build_scenario_cache(
        n_runs=n_runs,
        n_positions=n_positions,
        terminal_fn=correlated_crash_terminal_fn(cfg),
        rng=np.random.default_rng(seed),
        P0=100.0,
        mix=PositionMix.crypto_majors(),
    )


def test_scenario_cache_shape():
    cache = _build_test_cache(n_runs=15, n_positions=25)
    assert cache.payouts.shape == (15, 25)
    assert cache.max_ils.shape == (15, 25)
    assert cache.V0s.shape == (15, 25)
    assert cache.n_runs == 15 and cache.n_positions == 25


def test_scenario_cache_reproducible():
    a = _build_test_cache(seed=7)
    b = _build_test_cache(seed=7)
    np.testing.assert_array_equal(a.payouts, b.payouts)
    np.testing.assert_array_equal(a.max_ils, b.max_ils)
    np.testing.assert_array_equal(a.V0s, b.V0s)


def test_fund_pnl_from_cache_matches_waterfall_aggregate():
    """The whole point of the cache: same fund_pnl as the slow waterfall path.

    Re-run waterfall on the SAME positions + P_T that built the cache and
    confirm the aggregate fund_pnl_total matches what fund_pnl_from_cache
    returns. This locks together the calibrator and the validated 14.5 code.
    """
    # Hand-build a controlled single-run cache by injecting known positions
    rng = np.random.default_rng(11)
    positions = sample_positions(60, P0=100.0, mix=PositionMix.crypto_majors(), rng=rng)
    P_T = positions["P0"].to_numpy(dtype=float) * np.exp(rng.normal(-0.3, 0.4, 60))

    p, m = _vectorised_payouts_and_maxils(
        positions["P0"].to_numpy(dtype=float),
        positions["Pa"].to_numpy(dtype=float),
        positions["Pb"].to_numpy(dtype=float),
        positions["L"].to_numpy(dtype=float),
        P_T,
    )
    cache = _ScenarioCache(
        payouts=p.reshape(1, -1),
        max_ils=m.reshape(1, -1),
        V0s=positions["V0"].to_numpy(dtype=float).reshape(1, -1),
    )

    c = 0.10
    premium_rate = 0.75
    pnl_fast = fund_pnl_from_cache(cache, c=c, premium_rate=premium_rate)

    cfg = WaterfallConfig(c=c, premium_rate_of_maxil=premium_rate)
    per_swap = waterfall(positions, P_T, cfg)
    pnl_slow = aggregate(per_swap)["fund_pnl_total"]

    assert pnl_fast[0] == pytest.approx(pnl_slow, rel=1e-9, abs=1e-6)


# ─── calibrate_c_min ────────────────────────────────────────────────────────


def test_c_min_monotone_in_fund_balance():
    """Bigger fund balance → smaller required c_min (more equity absorbs tail)."""
    cache = _build_test_cache(n_runs=300, n_positions=50)
    small = calibrate_c_min(cache=cache, fund_balance=1_000.0, ruin_budget=0.02)
    big = calibrate_c_min(cache=cache, fund_balance=100_000.0, ruin_budget=0.02)
    assert small["feasible"] and big["feasible"]
    assert big["c_min"] <= small["c_min"]


def test_c_min_infeasible_when_search_too_narrow():
    """If even max c can't hit the budget, return infeasible."""
    cache = _build_test_cache(n_runs=200, n_positions=80)
    # Set fund_balance well below worst-case loss; impossible to satisfy
    out = calibrate_c_min(
        cache=cache,
        fund_balance=-1e12,  # huge negative pseudo-equity
        ruin_budget=0.001,
        c_search=(0.05, 0.20),
    )
    assert out["feasible"] is False
    assert out["c_min"] == float("inf")


# ─── calibrate_fund_target ─────────────────────────────────────────────────


def test_fund_target_recovers_quantile_on_handcrafted_dist():
    """fund_target = -quantile(fund_pnl, ruin_budget); verify against a
    handcrafted scenario cache whose fund_pnl is computable in closed form."""
    # Single-position swaps where payout > c*V0 by a known amount
    n_runs = 1000
    cache = _ScenarioCache(
        payouts=np.full((n_runs, 1), 100.0),
        max_ils=np.full((n_runs, 1), 100.0),
        V0s=np.full((n_runs, 1), 100.0),
    )
    # fund_pnl = premium * (0.20 + fee(0.10)) - max(0, 100 - 0.10*100)
    #          = 75 * (0.20 + default_fee(0.10)) - 90
    # constant across runs → 0.1-quantile == the value → fund_target = -value
    result = calibrate_fund_target(cache=cache, c=0.10, ruin_budget=0.10)
    expected_pnl = fund_pnl_from_cache(cache, c=0.10, premium_rate=0.75)[0]
    expected_target = max(0.0, -expected_pnl)
    assert result["fund_target"] == pytest.approx(expected_target, abs=1e-6)


def test_fund_target_zero_when_pnl_positive():
    """If fund_pnl is always positive, fund_target = 0 (no equity needed)."""
    n_runs = 200
    cache = _ScenarioCache(
        payouts=np.zeros((n_runs, 1)),
        max_ils=np.full((n_runs, 1), 100.0),
        V0s=np.full((n_runs, 1), 100.0),
    )
    result = calibrate_fund_target(cache=cache, c=0.10, ruin_budget=0.01)
    assert result["fund_target"] == 0.0
    assert result["median_pnl"] > 0


# ─── calibrate_fee_curve ────────────────────────────────────────────────────


def test_fee_curve_refit_drives_median_to_zero():
    """Deterministic cache → closed-form expected fee → bisection must hit it.

    Setup: every run has payout=50, max_il=50, V0=100. At c=10%:
      mm_coll = 10, fund_pays = 40
      premium = 50·0.75 = 37.5
      pnl(fee) = 37.5·(0.20 + fee) − 40
    Solve pnl=0: fee* = 40/37.5 − 0.20 ≈ 0.8667.
    Bisection (tol=1e-5) drives pnl within ~4e-4 — constant across runs so
    median ≈ exact value.
    """
    n_runs = 100
    cache = _ScenarioCache(
        payouts=np.full((n_runs, 1), 50.0),
        max_ils=np.full((n_runs, 1), 50.0),
        V0s=np.full((n_runs, 1), 100.0),
    )
    c = 0.10
    fit = calibrate_fee_curve(cache=cache, c=c, premium_rate=0.75, premium_share=0.20)
    # Closed-form fee
    expected_fee = 40.0 / 37.5 - 0.20
    assert fit["fee_pct_at_c"] == pytest.approx(expected_fee, abs=1e-4)
    pnl_at_refit = fund_pnl_from_cache(
        cache, c=c, premium_rate=0.75,
        premium_share=0.20, fee_pct=fit["fee_pct_at_c"],
    )
    assert abs(float(np.median(pnl_at_refit))) < 1e-2


def test_fee_curve_recommendation_at_least_zero():
    """Refit can't recommend a negative fee even if the distribution is calm."""
    n_runs = 200
    cache = _ScenarioCache(
        payouts=np.zeros((n_runs, 1)),
        max_ils=np.full((n_runs, 1), 100.0),
        V0s=np.full((n_runs, 1), 100.0),
    )
    fit = calibrate_fee_curve(cache=cache, c=0.10)
    assert fit["fee_ref_recommended"] >= 0
    assert fit["fee_pct_at_c"] >= 0


# ─── calibrate_exposure_caps ───────────────────────────────────────────────


def test_exposure_caps_returns_sweep_and_caps():
    out = calibrate_exposure_caps(
        fund_balance=1e6,
        c=0.20,
        n_positions_grid=np.array([20, 50, 100]),
        n_runs=80,
        cfg=CorrelatedCrashConfig.moderate(),
        rng_seed=42,
    )
    assert "per_market_cap" in out
    assert "per_mm_cap" in out
    assert len(out["sweep"]) == 3
    assert all("ruin_p" in row for row in out["sweep"])
    # Per-MM is per-market divided by n_mms
    assert out["per_mm_cap"] == out["per_market_cap"] // 5


# ─── Heuristics ────────────────────────────────────────────────────────────


def test_breakers_strictly_decreasing():
    b = heuristic_circuit_breakers()
    assert b["L0"] > b["L1"] > b["L2"] > b["L3"]
    assert 0.0 <= b["L3"] < b["L0"] <= 1.0


def test_withdrawal_delay_positive_seconds():
    d = heuristic_withdrawal_delay_seconds()
    assert d > 0
    assert d == 7 * 86_400


def test_first_loss_fraction_in_range():
    fl = heuristic_first_loss_fraction()
    assert 0.0 < fl < 1.0


# ─── calibrate_all end-to-end ───────────────────────────────────────────────


def test_calibrate_all_returns_full_result():
    out = calibrate_all(
        n_runs=200,
        n_positions=60,
        cfg=CorrelatedCrashConfig.moderate(),
        exposure_grid=np.array([30, 60, 120]),
        rng_seed=99,
    )
    assert isinstance(out, CalibrationResult)
    assert 0.0 < out.c_min <= 0.50
    assert out.fund_target >= 0.0
    assert "L0" in out.breakers
    assert out.withdrawal_delay_seconds > 0
    assert 0.0 < out.first_loss_fraction < 1.0
    assert "fee_ref_recommended" in out.fee_curve
    assert "per_market_cap" in out.exposure_caps


def test_calibrate_all_to_dict_serialisable():
    """The dataclass dict must contain primitive types only (ready for JSON)."""
    import json

    out = calibrate_all(
        n_runs=100,
        n_positions=40,
        cfg=CorrelatedCrashConfig.moderate(),
        exposure_grid=np.array([20, 40, 80]),
        rng_seed=1,
    )
    d = out.to_dict()
    # Round-trip through JSON: every value must be JSON-native
    json.dumps(d)
    assert "c_min" in d
    assert "fund_target" in d
    assert "fee_curve" in d
    assert "exposure_caps" in d
