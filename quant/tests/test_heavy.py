"""Tests for inflexion_quant.heavy — the P1.13 real-measure calibration engine.

Small MC sizes so CI stays fast; asserts the load-bearing properties (no-bad-debt
path-by-path, the structural-lever directions, the warm-up/CAGR metrics) rather
than exact figures (which the committed run_launch_calibration reproduces).
"""

from __future__ import annotations

import numpy as np

from inflexion_quant import heavy as H


def _curves():
    return H.build_book_curves(T_days=30, n_book=8_000, rng=np.random.default_rng(1))


def test_no_bad_debt_on_grid_and_paths():
    """payout_frac <= 1.0 (== MaxIL) on the move grid AND the simulated paths (I1/I2)."""
    c = _curves()
    assert c.max_payout_frac <= 1.0 + 1e-9
    sim = H.simulate_depositor_paths(
        H.RealMeasureModel(),
        c,
        base_load_by_regime=(0.2, 0.3, 0.5),
        utilization=0.6,
        n_paths=3000,
        n_months=24,
        rng=np.random.default_rng(2),
    )
    nbd = H.verify_no_bad_debt(c, sim)
    assert nbd["no_bad_debt"] is True
    assert nbd["max_payout_frac_sim"] <= 1.0 + 1e-9


def test_sigma_ref_is_lagging_and_floored():
    """sigma_ref priced is lagged (month 0 == floor) and never below the floor."""
    c = _curves()
    m = H.RealMeasureModel(sigma_ref_floor=0.50)
    sim = H.simulate_depositor_paths(
        m,
        c,
        base_load_by_regime=(0.2, 0.3, 0.5),
        utilization=0.5,
        n_paths=2000,
        n_months=12,
        rng=np.random.default_rng(3),
    )
    srp = sim["sigma_ref_priced"]
    assert np.allclose(srp[:, 0], 0.50)  # month 0 priced at the floor (lag artifact)
    assert srp.min() >= 0.50 - 1e-9  # never below the floor


def test_metrics_warmup_trim_and_cagr_keys():
    c = _curves()
    sim = H.simulate_depositor_paths(
        H.RealMeasureModel(),
        c,
        base_load_by_regime=(0.2, 0.3, 0.5),
        utilization=0.4,
        n_paths=3000,
        n_months=18,
        rng=np.random.default_rng(4),
    )
    m = H.depositor_metrics(sim["monthly_return"], horizon_days=30, warmup_months=6)
    for k in (
        "cagr_median",
        "cagr_p10",
        "cagr_p90",
        "p_losing_period",
        "loss_1in100",
        "worst_period",
        "p_drawdown_gt_50pct",
    ):
        assert k in m
    assert m["cagr_p10"] <= m["cagr_median"] <= m["cagr_p90"]


def test_higher_utilization_raises_drawdown():
    """Utilization is the drawdown lever (audit F3 scoping)."""
    c = _curves()
    mdl = H.RealMeasureModel()

    def dd(u):
        sim = H.simulate_depositor_paths(
            mdl,
            c,
            base_load_by_regime=(0.2, 0.3, 0.5),
            utilization=u,
            n_paths=4000,
            n_months=36,
            rng=np.random.default_rng(5),
        )
        return H.depositor_metrics(sim["monthly_return"], horizon_days=30, warmup_months=6)[
            "p_drawdown_gt_50pct"
        ]

    assert dd(0.6) >= dd(0.3)


def test_run_launch_calibration_smoke():
    """The committed run returns the disclosure/levers and confirms no-bad-debt +
    the infeasible-unhedged verdict."""
    res = H.run_launch_calibration(n_paths=3000, n_months=24, seed=20260613)
    assert res["disclosure"]["disciplined_u040"]["no_bad_debt"] is True
    # pool hedge reduces the 1-in-100 tail (h=0.75 << h=0.0)
    hf = res["pool_hedge_frontier_u040"]
    assert hf["h75"]["loss_1in100"] < hf["h0"]["loss_1in100"]
    # senior tranche is far safer than its junior counterpart
    t = res["tranche_u040"]["sf60"]
    assert t["senior_worst"] <= t["junior_worst"]
    assert "INFEASIBLE" in res["verdict"]
    assert 0.0 <= res["idle_routable_frac"] < 1.0
