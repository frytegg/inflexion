"""Tests for inflexion_quant.depositor — the single-asset depositor disclosure
(cvAMM deliverable 10)."""

from __future__ import annotations

import numpy as np
import pytest

from inflexion_quant import cvamm as cv
from inflexion_quant.depositor import (
    DISCLOSURE_TEXT,
    TWO_SEPARATE_CLAIMS,
    DepositorModel,
    disclosure,
    simulate_monthly_pnl,
)
from inflexion_quant.positions import PositionMix, sample_positions


def test_disclosure_shape_and_verbatim_tone():
    d = disclosure(n_months=2000, n_positions=60, rng_seed=1)
    for k in ("apy", "p_losing_month", "loss_1in100", "worst_month"):
        assert k in d
    # Verbatim mandatory tone — never "stable/modest APY".
    assert d["disclosure_text"] == DISCLOSURE_TEXT
    assert "CAPITAL IS NOT GUARANTEED" in d["disclosure_text"]
    assert "stable" not in d["disclosure_text"].lower()
    assert "modest" not in d["disclosure_text"].lower()
    assert tuple(d["two_separate_claims"]) == TWO_SEPARATE_CLAIMS
    assert "placeholder" in d["label"].lower()  # not mistaken for a calibrated number


def test_no_bad_debt_on_every_path():
    """FULL no-bad-debt (I1/I2) quant mirror: realised payout ≤ MaxIL on EVERY
    sampled position × path — zero exceptions."""
    rng = np.random.default_rng(5)
    for _ in range(50):
        pos = sample_positions(200, P0=3000.0, mix=PositionMix.crypto_majors(), rng=rng)
        P0 = pos["P0"].to_numpy(float)
        Pa = pos["Pa"].to_numpy(float)
        Pb = pos["Pb"].to_numpy(float)
        Lv = pos["L"].to_numpy(float)
        # wide range of terminal moves incl. deep crashes and melt-ups
        P_T = P0 * np.exp(rng.uniform(-2.0, 2.0, size=len(pos)))
        payout, max_il = cv.batch_payouts_and_maxils(P0, Pa, Pb, Lv, P_T)
        assert np.all(payout <= max_il + 1e-6)
        assert np.all(payout >= -1e-9)


def test_higher_utilization_raises_risk():
    """Worst month scales with utilization (more locked capital → more tail risk)."""
    low = disclosure(
        model=DepositorModel(utilization=0.3), n_months=3000, n_positions=60, rng_seed=2
    )
    high = disclosure(
        model=DepositorModel(utilization=0.9), n_months=3000, n_positions=60, rng_seed=2
    )
    assert high["worst_month"] >= low["worst_month"]


def test_calmer_realized_vol_improves_pnl():
    """If realized σ < σ_ref (the conservative margin), the pool is positive-EV."""
    calm = disclosure(
        model=DepositorModel(sigma_real=0.45, sigma_ref=0.80, base_load=0.20),
        n_months=3000,
        n_positions=60,
        rng_seed=3,
    )
    assert calm["mean_monthly_return"] > 0
