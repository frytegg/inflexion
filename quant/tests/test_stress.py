"""Tests for inflexion_quant.stress — Task 14.6 stress scenarios."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from inflexion_quant.portfolio import WaterfallConfig
from inflexion_quant.stress import (
    CorrelatedCrashConfig,
    VolRegimeShiftConfig,
    correlated_crash,
    ruin_probability,
    run_scenario,
    summarise,
    utilization_spike,
    var_cvar,
    vol_regime_shift,
)


# ─── helpers ─────────────────────────────────────────────────────────────────


WATERFALL_CFG = WaterfallConfig(c=0.10, premium_rate_of_maxil=0.75)

EXPECTED_COLS = {
    "run_id",
    "n_swaps",
    "lp_payout_total",
    "mm_pays_total",
    "fund_pays_total",
    "fund_inflow_total",
    "fund_pnl_total",
    "n_fund_tail_hits",
    "max_single_fund_pays",
}


# ─── run_scenario validation ────────────────────────────────────────────────


def test_run_scenario_rejects_zero_runs():
    rng = np.random.default_rng(0)
    with pytest.raises(ValueError, match="n_runs"):
        run_scenario(
            n_runs=0,
            n_positions=10,
            waterfall_cfg=WATERFALL_CFG,
            terminal_price_fn=lambda pos, r: np.full(len(pos), 100.0),
            rng=rng,
        )


def test_run_scenario_rejects_zero_positions():
    rng = np.random.default_rng(0)
    with pytest.raises(ValueError, match="n_positions"):
        run_scenario(
            n_runs=1,
            n_positions=0,
            waterfall_cfg=WATERFALL_CFG,
            terminal_price_fn=lambda pos, r: np.full(len(pos), 100.0),
            rng=rng,
        )


# ─── Scenario 1: correlated crash ──────────────────────────────────────────


def test_correlated_crash_shape_and_columns():
    rng = np.random.default_rng(42)
    out = correlated_crash(
        n_runs=20,
        n_positions=50,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng,
    )
    assert len(out) == 20
    assert EXPECTED_COLS.issubset(out.columns)
    assert (out["n_swaps"] == 50).all()


def test_correlated_crash_severe_worse_than_moderate():
    """severe() ratchets crash_lam + |crash_mu| — fund should pay materially more."""
    rng_m = np.random.default_rng(1234)
    rng_s = np.random.default_rng(1234)

    moderate = correlated_crash(
        n_runs=80,
        n_positions=80,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng_m,
        cfg=CorrelatedCrashConfig.moderate(),
    )
    severe = correlated_crash(
        n_runs=80,
        n_positions=80,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng_s,
        cfg=CorrelatedCrashConfig.severe(),
    )
    assert severe["fund_pays_total"].mean() > moderate["fund_pays_total"].mean() * 1.5
    assert severe["fund_pnl_total"].mean() < moderate["fund_pnl_total"].mean()


def test_correlated_crash_reproducible():
    out1 = correlated_crash(
        n_runs=5,
        n_positions=30,
        waterfall_cfg=WATERFALL_CFG,
        rng=np.random.default_rng(7),
    )
    out2 = correlated_crash(
        n_runs=5,
        n_positions=30,
        waterfall_cfg=WATERFALL_CFG,
        rng=np.random.default_rng(7),
    )
    pd.testing.assert_frame_equal(out1, out2)


# ─── Scenario 2: vol regime shift ──────────────────────────────────────────


def test_vol_regime_shift_shape():
    rng = np.random.default_rng(99)
    out = vol_regime_shift(
        n_runs=15,
        n_positions=40,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng,
    )
    assert len(out) == 15
    assert EXPECTED_COLS.issubset(out.columns)


def test_vol_regime_shift_bigger_shock_more_fund_pays():
    """Bigger post-shock sigma → more price dispersion → fund pays more.

    fund_pnl_total is dominated by fund_inflow (premium-driven, same per pair
    of seeded calls) until tail events fire; fund_pays_total isolates the
    price-driven component cleanly.
    """
    rng_mild = np.random.default_rng(2024)
    rng_harsh = np.random.default_rng(2024)
    mild = vol_regime_shift(
        n_runs=200,
        n_positions=80,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng_mild,
        cfg=VolRegimeShiftConfig(sigma_baseline=0.30, sigma_shock=0.40),
    )
    harsh = vol_regime_shift(
        n_runs=200,
        n_positions=80,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng_harsh,
        cfg=VolRegimeShiftConfig(sigma_baseline=0.30, sigma_shock=3.00),
    )
    assert harsh["fund_pays_total"].mean() > mild["fund_pays_total"].mean() * 2.0
    assert harsh["fund_pays_total"].max() > mild["fund_pays_total"].max() * 1.5


def test_vol_regime_shift_rejects_bad_shock_step():
    with pytest.raises(ValueError, match="shock_at_step"):
        VolRegimeShiftConfig(shock_at_step=999, n_steps=30)


def test_vol_regime_shift_rejects_negative_sigma():
    with pytest.raises(ValueError, match="sigmas"):
        VolRegimeShiftConfig(sigma_baseline=-0.1)


# ─── Scenario 3: utilization spike ──────────────────────────────────────────


def test_utilization_spike_scales_book_size():
    rng = np.random.default_rng(55)
    out = utilization_spike(
        n_runs=5,
        n_positions_base=50,
        spike_multiplier=4.0,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng,
    )
    assert (out["n_swaps"] == 200).all()


def test_utilization_spike_pays_scale_with_book():
    """Bigger book → larger absolute fund_pays_total (roughly linear in expectation)."""
    base = utilization_spike(
        n_runs=40,
        n_positions_base=60,
        spike_multiplier=1.0,
        waterfall_cfg=WATERFALL_CFG,
        rng=np.random.default_rng(3),
        cfg=CorrelatedCrashConfig.severe(),
    )
    spiked = utilization_spike(
        n_runs=40,
        n_positions_base=60,
        spike_multiplier=5.0,
        waterfall_cfg=WATERFALL_CFG,
        rng=np.random.default_rng(3),
        cfg=CorrelatedCrashConfig.severe(),
    )
    # 5x book should be at least 3x the absolute fund_pays_total (allowing MC noise)
    assert spiked["fund_pays_total"].mean() > 3.0 * base["fund_pays_total"].mean()


def test_utilization_spike_rejects_bad_multiplier():
    with pytest.raises(ValueError, match="spike_multiplier"):
        utilization_spike(
            n_runs=1,
            n_positions_base=10,
            spike_multiplier=0.0,
            waterfall_cfg=WATERFALL_CFG,
            rng=np.random.default_rng(0),
        )


# ─── Tail-risk helpers ──────────────────────────────────────────────────────


def test_ruin_probability_basic():
    pnl = np.array([-10.0, -5.0, 0.0, 5.0, 10.0])
    # Defaults: P(pnl < 0)
    assert ruin_probability(pnl) == pytest.approx(2 / 5)
    # With +6 equity: P(pnl + 6 < 0) → only -10 + 6 = -4 < 0
    assert ruin_probability(pnl, initial_fund_balance=6.0) == pytest.approx(1 / 5)
    # With high equity: no ruin
    assert ruin_probability(pnl, initial_fund_balance=100.0) == 0.0


def test_var_cvar_handcrafted():
    # Symmetric known distribution: -100, -90, ..., 100 (21 elements)
    pnl = np.arange(-100, 101, 10, dtype=float)
    var95, cvar95 = var_cvar(pnl, confidence=0.95)
    # 5th percentile of pnl = -90 (linear interp at 5% of 21 ≈ index 1)
    assert var95 == pytest.approx(90, abs=2)
    # CVaR95 = -mean(pnl ≤ -90) = -mean(-100, -90) = 95
    assert cvar95 == pytest.approx(95, abs=2)


def test_var_monotone_in_confidence():
    rng = np.random.default_rng(42)
    pnl = rng.normal(0, 1, size=10_000)
    var_90, _ = var_cvar(pnl, confidence=0.90)
    var_95, _ = var_cvar(pnl, confidence=0.95)
    var_99, _ = var_cvar(pnl, confidence=0.99)
    assert var_90 < var_95 < var_99


def test_cvar_at_least_var():
    """CVaR(α) ≥ VaR(α) — CVaR is the average of the worst tail."""
    rng = np.random.default_rng(123)
    pnl = rng.normal(0, 1, size=5_000)
    for alpha in [0.90, 0.95, 0.99]:
        v, cv = var_cvar(pnl, confidence=alpha)
        assert cv >= v - 1e-9


def test_var_cvar_rejects_bad_confidence():
    pnl = np.array([1.0, 2.0, 3.0])
    for bad in [0.0, 1.0, -0.5, 1.5]:
        with pytest.raises(ValueError, match="confidence"):
            var_cvar(pnl, confidence=bad)


def test_summarise_returns_expected_keys():
    rng = np.random.default_rng(0)
    out = correlated_crash(
        n_runs=30,
        n_positions=30,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng,
    )
    s = summarise(out)
    expected = {
        "n_runs", "mean", "std", "min",
        "p1", "p5", "p50", "p95", "p99", "max",
        "ruin_p", "var_99", "cvar_99",
    }
    assert set(s.keys()) == expected
    assert s["n_runs"] == 30


def test_summarise_calm_baseline_low_ruin():
    """With moderate stress + healthy initial fund balance, ruin_p should be 0."""
    rng = np.random.default_rng(11)
    out = correlated_crash(
        n_runs=50,
        n_positions=50,
        waterfall_cfg=WATERFALL_CFG,
        rng=rng,
        cfg=CorrelatedCrashConfig.moderate(),
    )
    # Huge initial balance: ruin must be impossible
    s = summarise(out, initial_fund_balance=1e9)
    assert s["ruin_p"] == 0.0
