"""Tests for inflexion_quant.portfolio — the PARTIAL waterfall (Task 14.5)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from inflexion_quant.portfolio import (
    WaterfallConfig,
    aggregate,
    default_fee_curve,
    waterfall,
)
from inflexion_quant.positions import PositionMix, sample_positions


# ─── helpers ─────────────────────────────────────────────────────────────────


def _sample(n: int = 200, P0: float = 100.0, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return sample_positions(n, P0=P0, mix=PositionMix.crypto_majors(), rng=rng)


def _calm_terminals(positions: pd.DataFrame) -> np.ndarray:
    """Terminal prices ≈ P0 (calm market — almost no IL)."""
    return positions["P0"].to_numpy(dtype=float) * 1.001


def _crash_terminals(positions: pd.DataFrame, factor: float = 0.4) -> np.ndarray:
    """All terminal prices crash to ``factor · P0`` (everyone in tail)."""
    return positions["P0"].to_numpy(dtype=float) * factor


# ─── fee-curve properties ────────────────────────────────────────────────────


def test_default_fee_curve_anchor_20pct():
    assert default_fee_curve(0.20) == pytest.approx(0.01, rel=1e-3)


def test_default_fee_curve_monotone_decreasing_in_c():
    cs = np.array([0.05, 0.07, 0.10, 0.15, 0.20, 0.30, 0.50])
    fees = np.array([default_fee_curve(c) for c in cs])
    assert np.all(np.diff(fees) < 0), "fee must strictly decrease as collateral rises"


def test_default_fee_curve_convex():
    # 2nd finite difference > 0 → convex
    cs = np.linspace(0.05, 0.30, 7)
    fees = np.array([default_fee_curve(c) for c in cs])
    second_diff = np.diff(fees, n=2)
    assert np.all(second_diff > 0), f"expected convex, got 2nd diffs {second_diff}"


def test_default_fee_curve_anchor_10pct_approx_5pct():
    # Power-law fit pivot; should hit ~5% at c=10%
    assert default_fee_curve(0.10) == pytest.approx(0.05, rel=0.05)


# ─── config validation ──────────────────────────────────────────────────────


@pytest.mark.parametrize("c", [-0.01, 0.0, 1.5])
def test_config_rejects_bad_c(c):
    with pytest.raises(ValueError, match="c must be"):
        WaterfallConfig(c=c, premium_rate_of_maxil=0.5)


@pytest.mark.parametrize("rate", [-0.1, 1.5])
def test_config_rejects_bad_premium_rate(rate):
    with pytest.raises(ValueError, match="premium_rate_of_maxil"):
        WaterfallConfig(c=0.1, premium_rate_of_maxil=rate)


@pytest.mark.parametrize("share", [-0.1, 1.5])
def test_config_rejects_bad_premium_share(share):
    with pytest.raises(ValueError, match="premium_share_to_fund"):
        WaterfallConfig(c=0.1, premium_rate_of_maxil=0.5, premium_share_to_fund=share)


# ─── core waterfall invariants ──────────────────────────────────────────────


def test_conservation_mm_plus_fund_equals_payout():
    """Per-swap: mm_pays + fund_pays == payout (always, regardless of c)."""
    positions = _sample()
    for c in [0.05, 0.10, 0.20, 0.50]:
        cfg = WaterfallConfig(c=c, premium_rate_of_maxil=0.5)
        result = waterfall(positions, _crash_terminals(positions), cfg)
        np.testing.assert_allclose(
            result["mm_pays"] + result["fund_pays"],
            result["payout"],
            atol=1e-9,
            err_msg=f"conservation failed at c={c}",
        )


def test_mm_pays_capped_at_collateral():
    """mm_pays ≤ c · V0 always (the MM cannot pay more than they posted)."""
    positions = _sample()
    cfg = WaterfallConfig(c=0.10, premium_rate_of_maxil=0.5)
    result = waterfall(positions, _crash_terminals(positions, factor=0.2), cfg)
    assert (result["mm_pays"] <= result["mm_collateral"] + 1e-9).all()


def test_fund_pays_nonneg():
    positions = _sample()
    cfg = WaterfallConfig(c=0.05, premium_rate_of_maxil=0.5)
    result = waterfall(positions, _crash_terminals(positions), cfg)
    assert (result["fund_pays"] >= 0.0).all()


def test_full_recovery_when_c_large():
    """If c · V0 ≥ MaxIL for every swap, fund pays nothing (FULL invariant I1)."""
    positions = _sample()
    # First, find the maximum MaxIL / V0 ratio in the batch; set c above it
    cfg_probe = WaterfallConfig(c=1.0, premium_rate_of_maxil=0.5)
    probe = waterfall(positions, _crash_terminals(positions), cfg_probe)
    max_ratio = (probe["max_il"] / probe["V0"]).max()
    assert max_ratio < 1.0, "test setup: expected MaxIL/V0 < 1 for sampled mix"

    cfg = WaterfallConfig(c=float(max_ratio) + 0.01, premium_rate_of_maxil=0.5)
    result = waterfall(positions, _crash_terminals(positions), cfg)
    assert (result["fund_pays"] == 0.0).all(), "fund must pay 0 when c ≥ MaxIL/V0"
    np.testing.assert_allclose(result["mm_pays"], result["payout"], atol=1e-9)


def test_calm_market_zero_payouts():
    """If P_T ≈ P0 the LP has no IL → payout=0 → fund pays nothing, keeps premium."""
    positions = _sample()
    cfg = WaterfallConfig(c=0.10, premium_rate_of_maxil=0.5)
    result = waterfall(positions, _calm_terminals(positions), cfg)
    assert (result["payout"] < 1e-3 * result["V0"]).all()
    assert (result["fund_pays"] == 0.0).all()
    # Fund made positive carry on every swap
    assert (result["fund_pnl"] >= 0.0).all()


def test_extreme_crash_fund_takes_losses():
    """Deep crash with low c → fund pays > inflow on the high-MaxIL positions."""
    positions = _sample()
    cfg = WaterfallConfig(c=0.05, premium_rate_of_maxil=0.5)
    result = waterfall(positions, _crash_terminals(positions, factor=0.1), cfg)
    # At least some swaps must trigger the tail
    assert (result["fund_pays"] > 0).sum() > 0
    # And the aggregate fund P&L must be deeply negative
    assert result["fund_pnl"].sum() < 0


# ─── premium economics ──────────────────────────────────────────────────────


def test_premium_proportional_to_maxil():
    positions = _sample(n=50)
    cfg = WaterfallConfig(c=0.10, premium_rate_of_maxil=0.75)
    result = waterfall(positions, _calm_terminals(positions), cfg)
    np.testing.assert_allclose(
        result["premium"], 0.75 * result["max_il"], atol=1e-9
    )


def test_fund_inflow_breakdown():
    positions = _sample(n=50)
    cfg = WaterfallConfig(
        c=0.10,
        premium_rate_of_maxil=0.50,
        premium_share_to_fund=0.20,
    )
    result = waterfall(positions, _calm_terminals(positions), cfg)
    fee_pct = default_fee_curve(0.10)
    np.testing.assert_allclose(
        result["fund_premium_share"], result["premium"] * 0.20, atol=1e-9
    )
    np.testing.assert_allclose(
        result["fund_fee_tax"], result["premium"] * fee_pct, atol=1e-9
    )
    np.testing.assert_allclose(
        result["fund_inflow"],
        result["fund_premium_share"] + result["fund_fee_tax"],
        atol=1e-9,
    )


# ─── input validation ──────────────────────────────────────────────────────


def test_waterfall_rejects_missing_columns():
    bad = pd.DataFrame({"P0": [100], "Pa": [90], "Pb": [110]})  # missing L, V0
    with pytest.raises(ValueError, match="missing columns"):
        waterfall(bad, np.array([100.0]), WaterfallConfig(c=0.1, premium_rate_of_maxil=0.5))


def test_waterfall_rejects_p_t_shape_mismatch():
    positions = _sample(n=10)
    with pytest.raises(ValueError, match="P_T shape"):
        waterfall(
            positions,
            np.zeros(5),  # wrong length
            WaterfallConfig(c=0.1, premium_rate_of_maxil=0.5),
        )


# ─── aggregate ──────────────────────────────────────────────────────────────


def test_aggregate_matches_per_swap_sums():
    positions = _sample(n=100)
    cfg = WaterfallConfig(c=0.10, premium_rate_of_maxil=0.5)
    per = waterfall(positions, _crash_terminals(positions), cfg)
    agg = aggregate(per)
    assert agg["n_swaps"] == len(per)
    assert agg["lp_payout_total"] == pytest.approx(per["payout"].sum())
    assert agg["mm_pays_total"] == pytest.approx(per["mm_pays"].sum())
    assert agg["fund_pays_total"] == pytest.approx(per["fund_pays"].sum())
    assert agg["fund_inflow_total"] == pytest.approx(per["fund_inflow"].sum())
    assert agg["fund_pnl_total"] == pytest.approx(per["fund_pnl"].sum())
    assert agg["n_fund_tail_hits"] == int((per["fund_pays"] > 0).sum())


def test_aggregate_calm_market_positive():
    positions = _sample(n=100)
    cfg = WaterfallConfig(c=0.10, premium_rate_of_maxil=0.75)
    per = waterfall(positions, _calm_terminals(positions), cfg)
    agg = aggregate(per)
    assert agg["fund_pnl_total"] > 0
    assert agg["fund_pays_total"] == 0
    assert agg["n_fund_tail_hits"] == 0
