"""Tests for inflexion_quant.roadmap — the ROADMAP-tagged sizing methods
(deliverables 7/8/9). Shape + invariant checks only (these are not launch-blocking)."""

from __future__ import annotations

from inflexion_quant.roadmap import (
    BLOCKED_VENUES,
    COMPLIANT_VENUES,
    pool_hedge_frontier,
    routable_idle_fraction,
    tranche_cut,
)


def test_routable_idle_never_100pct_and_blocks_aave():
    r = routable_idle_fraction(p99_instant_demand_frac=0.20, safety_multiple=1.5)
    assert 0.0 <= r["routable_idle_frac"] < 1.0  # NEVER 100%
    assert r["routable_idle_frac"] + r["nude_buffer_frac"] == 1.0 or r["nude_buffer_frac"] == 1.0
    assert "Aave" in BLOCKED_VENUES[0]
    assert "sDAI" in COMPLIANT_VENUES
    assert "locked" in r["applies_to"]


def test_pool_hedge_frontier_reduces_worst_month():
    fr = pool_hedge_frontier(n_months=3000, rng_seed=1)["frontier"]
    by_h = {row["hedge_fraction"]: row for row in fr}
    # hedging more reduces the worst month (changes the nature of the risk)
    assert by_h[0.5]["worst_month"] <= by_h[0.0]["worst_month"] + 1e-9
    assert fr[0]["hedge_fraction"] == 0.0


def test_tranche_cut_senior_safer_than_junior():
    res = tranche_cut(n_months=3000, rng_seed=1)
    for row in res["sweep"]:
        # senior tail must be no worse than junior's worst month
        assert row["senior_cvar99"] <= row["junior_worst_month"] + 1e-6
    assert res["junior_first_loss"] is True
