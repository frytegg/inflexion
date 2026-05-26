"""Property tests for position-structure sampling (Task 14.3)."""

import numpy as np
import pytest

from inflexion_quant.positions import PositionMix, sample_positions


@pytest.fixture
def rng() -> np.random.Generator:
    return np.random.default_rng(seed=20260526)


def test_bucket_frequencies_match_weights(rng):
    """Sampled bucket frequencies converge to ``mix.weights`` within sampling error."""
    mix = PositionMix.crypto_majors()
    df = sample_positions(50_000, P0=3000, mix=mix, rng=rng)
    freq = df["bucket"].value_counts(normalize=True).sort_index().values
    expected = np.asarray(mix.weights) / sum(mix.weights)
    assert np.max(np.abs(freq - expected)) < 0.01


def test_P0_always_within_range(rng):
    """``Pa ≤ P0 ≤ Pb`` for every sampled position (create-time invariant)."""
    df = sample_positions(5_000, P0=3000, mix=PositionMix.crypto_majors(), rng=rng)
    assert (df["Pa"] <= df["P0"]).all()
    assert (df["P0"] <= df["Pb"]).all()


def test_derived_L_roundtrips_to_V0(rng):
    """L derived from V0 must reconstruct V0 exactly (this is the closed-form)."""
    df = sample_positions(2_000, P0=3000, mix=PositionMix.crypto_majors(), rng=rng)
    sqrt_P0 = np.sqrt(df["P0"])
    sqrt_Pa = np.sqrt(df["Pa"])
    sqrt_Pb = np.sqrt(df["Pb"])
    amount0 = df["L"] * (1 / sqrt_P0 - 1 / sqrt_Pb)
    amount1 = df["L"] * (sqrt_P0 - sqrt_Pa)
    reconstructed_V0 = amount0 * df["P0"] + amount1
    assert np.allclose(reconstructed_V0, df["V0"], rtol=1e-10)


def test_V0_is_lognormal(rng):
    """log V0 ≈ N(log median_V0, log_V0_sigma) within ±0.05."""
    median_V0 = 5_000.0
    sigma = 1.5
    df = sample_positions(
        10_000, P0=3000, mix=PositionMix.crypto_majors(), rng=rng,
        median_V0=median_V0, log_V0_sigma=sigma,
    )
    log_V0 = np.log(df["V0"])
    assert abs(log_V0.mean() - np.log(median_V0)) < 0.05
    assert abs(log_V0.std() - sigma) < 0.05


def test_offset_within_bound(rng):
    """``|offset_fraction| ≤ max_offset_fraction``."""
    max_off = 0.30
    df = sample_positions(
        2_000, P0=3000, mix=PositionMix.crypto_majors(), rng=rng,
        max_offset_fraction=max_off,
    )
    assert df["offset_fraction"].abs().max() <= max_off + 1e-12


def test_PositionMix_validates_input():
    with pytest.raises(ValueError):
        PositionMix(weights=[0.5, 0.5], half_widths=[0.1])  # length mismatch
    with pytest.raises(ValueError):
        PositionMix(weights=[-0.1, 0.5], half_widths=[0.1, 0.2])  # negative weight
    with pytest.raises(ValueError):
        PositionMix(weights=[0.5, 0.5], half_widths=[0.0, 0.2])  # zero half-width
