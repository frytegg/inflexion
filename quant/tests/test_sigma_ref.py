"""Tests for the σ_ref EWMA helper (cvAMM deliverable 2) in prices.py."""

from __future__ import annotations

import numpy as np
import pytest

from inflexion_quant.prices import ewma_volatility, gbm_paths, sigma_ref


def test_ewma_recovers_constant_vol():
    """EWMA of a GBM log-return series recovers its annualised σ within MC noise."""
    rng = np.random.default_rng(1)
    sigma_true = 0.60
    path = gbm_paths(3000.0, 0.0, sigma_true, T=4.0, n_steps=4 * 365, n_paths=1, rng=rng)[0]
    r = np.diff(np.log(path))
    est = ewma_volatility(r, halflife_samples=180, samples_per_year=365.0)
    assert est == pytest.approx(sigma_true, rel=0.25)


def test_sigma_ref_takes_the_max_and_floor():
    rng = np.random.default_rng(2)
    # calm recent returns: realized vol low → the floor must bind (conservative).
    r = 0.001 * rng.standard_normal(400)
    res = sigma_ref(
        r,
        short_halflife_samples=15,
        long_halflife_samples=120,
        floor=0.50,
        samples_per_year=365.0,
    )
    assert res["sigma_ref"] == pytest.approx(0.50)
    assert res["binding"] == "floor"
    assert res["sigma_ref"] >= res["sigma_short"]
    assert res["sigma_ref"] >= res["sigma_long"]


def test_sigma_ref_short_window_reacts_faster():
    """After a vol jump, the short EWMA exceeds the long EWMA — the max(...) guards
    against a stale long window under-pricing a regime change."""
    rng = np.random.default_rng(3)
    calm = 0.02 * rng.standard_normal(300)
    burst = 0.10 * rng.standard_normal(30)
    r = np.concatenate([calm, burst])
    res = sigma_ref(
        r,
        short_halflife_samples=10,
        long_halflife_samples=200,
        floor=0.0,
        samples_per_year=365.0,
    )
    assert res["sigma_short"] > res["sigma_long"]
    assert res["sigma_ref"] == pytest.approx(res["sigma_short"])


def test_ewma_rejects_bad_input():
    with pytest.raises(ValueError):
        ewma_volatility(np.array([]), halflife_samples=10)
    with pytest.raises(ValueError):
        ewma_volatility(np.array([0.01, 0.02]), halflife_samples=0)
