"""Property tests for the underlying price simulators (Task 14.2).

These are statistical — sample sizes are picked so the tolerances pass
reliably on CI in O(seconds). A failure usually indicates a real bug.
"""

import numpy as np
import pytest
from scipy import stats

from inflexion_quant.prices import (
    CommonFactor,
    KouParams,
    bootstrap_paths,
    common_factor_paths,
    gbm_paths,
    kou_jump_paths,
)


@pytest.fixture
def rng() -> np.random.Generator:
    return np.random.default_rng(seed=12345)


# ─── GBM ──────────────────────────────────────────────────────────────────────


def test_gbm_shape_and_anchor(rng):
    paths = gbm_paths(100.0, 0.0, 0.2, 1.0, n_steps=10, n_paths=7, rng=rng)
    assert paths.shape == (7, 11)
    assert (paths[:, 0] == 100.0).all()


def test_gbm_terminal_mean_matches_theory(rng):
    """E[S_T] = S0 · exp(μT) — should hold within ~2% with 50k paths."""
    S0, mu, sigma, T = 100.0, 0.05, 0.3, 1.0
    paths = gbm_paths(S0, mu, sigma, T, n_steps=252, n_paths=50_000, rng=rng)
    realised = paths[:, -1].mean()
    expected = S0 * np.exp(mu * T)
    assert abs(realised - expected) / expected < 0.02


def test_gbm_terminal_logvol_matches_theory(rng):
    """std(log S_T / S0) = σ·√T — within ~2%."""
    sigma, T = 0.5, 0.5
    paths = gbm_paths(100.0, 0.0, sigma, T, n_steps=126, n_paths=50_000, rng=rng)
    realised = np.log(paths[:, -1] / paths[:, 0]).std()
    expected = sigma * np.sqrt(T)
    assert abs(realised - expected) / expected < 0.02


# ─── Kou ──────────────────────────────────────────────────────────────────────


def test_kou_zero_lambda_matches_gbm_exactly():
    """λ=0 ⇒ no jumps drawn; output must equal GBM bit-for-bit (same RNG seed)."""
    rng_g = np.random.default_rng(seed=42)
    rng_k = np.random.default_rng(seed=42)
    kw = dict(S0=100.0, mu=0.05, sigma=0.2, T=1.0, n_steps=50, n_paths=100)
    g = gbm_paths(rng=rng_g, **kw)
    k = kou_jump_paths(kou=KouParams(lam=0.0), rng=rng_k, **kw)
    assert np.allclose(g, k)


def test_kou_has_heavier_tails_than_gbm():
    """The whole point of jumps: terminal-return excess kurtosis > GBM's."""
    common = dict(S0=100.0, mu=0.0, sigma=0.3, T=0.25, n_steps=63, n_paths=20_000)
    g = gbm_paths(rng=np.random.default_rng(seed=1), **common)
    k = kou_jump_paths(kou=KouParams(lam=80.0), rng=np.random.default_rng(seed=2), **common)
    r_g = np.log(g[:, -1] / g[:, 0])
    r_k = np.log(k[:, -1] / k[:, 0])
    # Threshold loose enough to survive Monte Carlo noise at n=20k — Kou DOES have
    # fatter tails, just not dramatically so when many small jumps average out.
    assert stats.kurtosis(r_k) > stats.kurtosis(r_g) + 0.1


def test_kou_negative_skew_when_down_tail_fatter(rng):
    """eta_down < eta_up + p_up < 0.5 ⇒ down jumps dominate ⇒ negative skew."""
    k = kou_jump_paths(
        100.0, 0.0, 0.2, 1.0, 252, 20_000,
        kou=KouParams(lam=100.0, p_up=0.3, eta_up=30, eta_down=10),
        rng=rng,
    )
    r = np.log(k[:, -1] / k[:, 0])
    assert stats.skew(r) < -0.1


# ─── Bootstrap ────────────────────────────────────────────────────────────────


def test_bootstrap_preserves_marginal_mean(rng):
    """E[bootstrapped daily return] ≈ mean of empirical."""
    emp = rng.normal(0.001, 0.03, size=1000)
    paths = bootstrap_paths(emp, S0=100.0, n_steps=100, n_paths=2_000, rng=rng)
    sampled = np.diff(np.log(paths), axis=1).ravel()
    assert abs(sampled.mean() - emp.mean()) < 0.001


def test_bootstrap_block_size_validated(rng):
    with pytest.raises(ValueError):
        bootstrap_paths(np.zeros(5), S0=100, n_steps=10, n_paths=1, rng=rng, block_size=10)


def test_bootstrap_iid_and_block_have_same_distribution_in_iid_data(rng):
    """When the empirical data is i.i.d. (no autocorrelation), block bootstrap
    should give the same mean/std as i.i.d. bootstrap — block preserves a
    structure that simply isn't there."""
    emp = rng.normal(0.0, 0.02, size=500)
    iid = bootstrap_paths(emp, 100, 100, 2_000, rng, block_size=1)
    blk = bootstrap_paths(emp, 100, 100, 2_000, rng, block_size=10)
    r_iid = np.log(iid[:, -1] / iid[:, 0])
    r_blk = np.log(blk[:, -1] / blk[:, 0])
    # Tolerance sized to the Monte Carlo SE on the difference of two means at
    # this sample size (~±0.012 95% CI); 0.02 / 0.05 leaves headroom.
    assert abs(r_iid.mean() - r_blk.mean()) < 0.02
    assert abs(r_iid.std() - r_blk.std()) < 0.05


# ─── Common factor ────────────────────────────────────────────────────────────


def test_common_factor_shape(rng):
    paths = common_factor_paths(
        S0=np.array([100.0, 200.0]),
        mu=np.zeros(2), sigma_idio=np.array([0.2, 0.2]),
        beta=np.array([1.0, 1.0]), cf=CommonFactor(),
        T=1.0, n_steps=10, n_paths=5, rng=rng,
    )
    assert paths.shape == (5, 2, 11)
    assert np.allclose(paths[:, 0, 0], 100.0)
    assert np.allclose(paths[:, 1, 0], 200.0)


def test_common_factor_correlation_from_shared_beta(rng):
    """Beta loadings on shared factor produce a predictable correlation:
    ρ ≈ β²σ_c² / (β²σ_c² + σ_idio²) for matched assets.
    With β=1, σ_c=0.4, σ_idio=0.2 ⇒ ρ ≈ 0.16/(0.16+0.04) = 0.80."""
    paths = common_factor_paths(
        S0=np.array([100.0, 100.0]),
        mu=np.zeros(2), sigma_idio=np.array([0.20, 0.20]),
        beta=np.array([1.0, 1.0]),
        cf=CommonFactor(sigma=0.40, crash_lam=0.0, crash_mu=0.0, crash_sigma=0.0),
        T=1.0, n_steps=252, n_paths=5_000, rng=rng,
    )
    r0 = np.log(paths[:, 0, -1] / paths[:, 0, 0])
    r1 = np.log(paths[:, 1, -1] / paths[:, 1, 0])
    corr = np.corrcoef(r0, r1)[0, 1]
    assert corr > 0.65, f"expected ~0.80, got {corr:.3f}"


def test_common_factor_crash_creates_co_movement(rng):
    """A frequent-crash common factor moves all assets together."""
    cf = CommonFactor(sigma=0.20, crash_lam=20.0, crash_mu=-0.10, crash_sigma=0.05)
    paths = common_factor_paths(
        S0=np.array([100.0, 100.0, 100.0]),
        mu=np.zeros(3), sigma_idio=np.array([0.10, 0.10, 0.10]),
        beta=np.array([1.0, 1.0, 1.0]), cf=cf,
        T=0.5, n_steps=126, n_paths=3_000, rng=rng,
    )
    r = np.log(paths[:, :, -1] / paths[:, :, 0])
    corr = np.corrcoef(r.T)
    off_diag_mean = (corr.sum() - 3) / 6
    assert off_diag_mean > 0.5, f"expected strongly co-moving, got mean off-diag {off_diag_mean:.3f}"


def test_common_factor_input_length_mismatch(rng):
    with pytest.raises(ValueError):
        common_factor_paths(
            S0=np.array([100.0, 100.0]), mu=np.array([0.0]),  # length mismatch
            sigma_idio=np.array([0.1, 0.1]), beta=np.array([1.0, 1.0]),
            cf=CommonFactor(), T=1.0, n_steps=10, n_paths=5, rng=rng,
        )
