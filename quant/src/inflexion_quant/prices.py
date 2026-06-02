"""Underlying price simulators for Inflexion's quant model (Task 14.2).

Four models, each returning shape ``(n_paths, n_steps + 1)`` price paths
(or ``(n_paths, n_assets, n_steps + 1)`` for the common-factor model):

1. :func:`gbm_paths`           — geometric Brownian motion (baseline)
2. :func:`kou_jump_paths`      — Kou (2002) double-exponential jump-diffusion
3. :func:`bootstrap_paths`     — empirical (i.i.d. or moving-block) bootstrap
4. :func:`common_factor_paths` — multi-asset, common Gaussian + crash factor
                                 (the workhorse for Phase 14.6 stress)

All functions take a ``numpy.random.Generator`` for reproducibility. They are
vectorised over paths; per-path Python loops would not scale to the millions
of paths Phase 14.5–14.7 will throw at them.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.random import Generator


# ─── GBM ─────────────────────────────────────────────────────────────────────


def gbm_paths(
    S0: float,
    mu: float,
    sigma: float,
    T: float,
    n_steps: int,
    n_paths: int,
    rng: Generator,
) -> np.ndarray:
    """Geometric Brownian motion paths: ``dS = μ·S·dt + σ·S·dW``.

    Returns ``(n_paths, n_steps + 1)``; index ``[:, 0]`` is ``S0``.
    """
    dt = T / n_steps
    z = rng.standard_normal((n_paths, n_steps))
    log_inc = (mu - 0.5 * sigma**2) * dt + sigma * np.sqrt(dt) * z
    log_path = np.cumsum(log_inc, axis=1)
    out = np.empty((n_paths, n_steps + 1))
    out[:, 0] = S0
    out[:, 1:] = S0 * np.exp(log_path)
    return out


# ─── Kou jump-diffusion ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class KouParams:
    """Kou (2002) double-exponential jump parameters.

    Jump size ``Y`` has density::

        p_up · η_up · exp(−η_up · y)        for y > 0
        (1−p_up) · η_down · exp(η_down · y) for y < 0

    Default values reflect crypto-typical asymmetry: ``η_down < η_up`` makes
    the *down* exponential have a fatter tail than the up one.
    """

    lam: float = 50.0  # jumps per year (Poisson intensity)
    p_up: float = 0.4  # P(jump is up | jump occurs)
    eta_up: float = 25.0  # rate of positive jumps  (1/eta_up = mean up size)
    eta_down: float = 15.0  # rate of negative jumps  (fatter tail by default)


def kou_jump_paths(
    S0: float,
    mu: float,
    sigma: float,
    T: float,
    n_steps: int,
    n_paths: int,
    kou: KouParams,
    rng: Generator,
) -> np.ndarray:
    """Kou double-exponential jump-diffusion paths.

    Log-return increment per step::

        dlogS = (μ − ½σ²)·dt + σ·√dt·Z + Σ_{k=1}^{N_t} Y_k

    where ``N_t ~ Poisson(λ·dt)`` and each ``Y_k`` is Kou-distributed.

    With ``KouParams.lam == 0`` this is numerically identical to :func:`gbm_paths`
    given the same RNG (tested).
    """
    dt = T / n_steps
    sqrt_dt = np.sqrt(dt)

    # Diffusion part — exactly the same draws GBM would make
    z = rng.standard_normal((n_paths, n_steps))
    diff = (mu - 0.5 * sigma**2) * dt + sigma * sqrt_dt * z

    # Jump counts per cell
    n_jumps = rng.poisson(kou.lam * dt, size=(n_paths, n_steps))
    total_jumps = int(n_jumps.sum())
    jump_inc = np.zeros_like(diff)

    if total_jumps > 0:
        # Sample ALL jumps in one shot, then aggregate per cell via bincount
        up_or_down = rng.uniform(size=total_jumps) < kou.p_up
        u = rng.uniform(size=total_jumps)
        # Inverse-CDF Exp(rate): both branches give correctly-signed sizes
        sizes = np.where(
            up_or_down,
            -np.log1p(-u) / kou.eta_up,  # positive
            np.log1p(-u) / kou.eta_down,  # negative
        )
        flat_counts = n_jumps.ravel()
        cell_of_jump = np.repeat(np.arange(flat_counts.size), flat_counts)
        cell_sums = np.bincount(cell_of_jump, weights=sizes, minlength=flat_counts.size)
        jump_inc = cell_sums.reshape(n_paths, n_steps)

    log_inc = diff + jump_inc
    log_path = np.cumsum(log_inc, axis=1)
    out = np.empty((n_paths, n_steps + 1))
    out[:, 0] = S0
    out[:, 1:] = S0 * np.exp(log_path)
    return out


# ─── Bootstrap ───────────────────────────────────────────────────────────────


def bootstrap_paths(
    log_returns: np.ndarray,
    S0: float,
    n_steps: int,
    n_paths: int,
    rng: Generator,
    block_size: int = 1,
) -> np.ndarray:
    """Empirical bootstrap of returns into forward paths.

    ``block_size = 1`` → i.i.d. bootstrap (standard).
    ``block_size > 1`` → moving-block bootstrap, which preserves short-range
    serial correlation. Useful for crypto's mild momentum + vol clustering
    that a pure i.i.d. resample would destroy.
    """
    log_returns = np.asarray(log_returns, dtype=float).ravel()
    n = len(log_returns)
    if n < 2:
        raise ValueError(f"log_returns must have ≥ 2 entries (got {n})")

    if block_size <= 1:
        idx = rng.integers(0, n, size=(n_paths, n_steps))
        sampled = log_returns[idx]
    else:
        if block_size > n:
            raise ValueError(f"block_size ({block_size}) > len(log_returns) ({n})")
        n_blocks = (n_steps + block_size - 1) // block_size
        max_start = n - block_size
        starts = rng.integers(0, max_start + 1, size=(n_paths, n_blocks))
        offsets = np.arange(block_size)
        idx = starts[:, :, None] + offsets[None, None, :]
        sampled = log_returns[idx].reshape(n_paths, -1)[:, :n_steps]

    log_path = np.cumsum(sampled, axis=1)
    out = np.empty((n_paths, n_steps + 1))
    out[:, 0] = S0
    out[:, 1:] = S0 * np.exp(log_path)
    return out


# ─── Common-factor multi-asset ───────────────────────────────────────────────


@dataclass(frozen=True)
class CommonFactor:
    """Multi-asset common driver: Gaussian diffusion + jump crashes.

    The *workhorse* for Phase 14.6 stress: ratchet ``crash_lam`` up and
    ``crash_mu`` deep negative to fire correlated crashes that hit every asset
    simultaneously — exactly the scenario where the insurance fund needs to
    survive.
    """

    sigma: float = 0.40  # annualised vol of the common factor
    crash_lam: float = 2.0  # crashes per year (Poisson intensity)
    crash_mu: float = -0.10  # mean log-jump (negative ⇒ crash)
    crash_sigma: float = 0.05  # std of log-jump size


def common_factor_paths(
    S0: np.ndarray,  # (n_assets,)
    mu: np.ndarray,  # (n_assets,)
    sigma_idio: np.ndarray,  # (n_assets,) — idiosyncratic vol
    beta: np.ndarray,  # (n_assets,) — loading on common factor
    cf: CommonFactor,
    T: float,
    n_steps: int,
    n_paths: int,
    rng: Generator,
) -> np.ndarray:
    """Multi-asset paths driven by an idiosyncratic component and a shared
    (jumpy) common factor.

    For each asset ``i``::

        dlog S_i = μ_i·dt + β_i · dF(t) + σ_idio_i · √dt · Z_i(t)
              dF = σ_c·√dt·Z_c + Σ_k J_k · 1{jump in (t, t+dt]}

    where ``J_k ~ N(crash_mu, crash_sigma²)`` and ``N_t ~ Poisson(crash_lam·dt)``.

    Returns ``(n_paths, n_assets, n_steps + 1)``.
    """
    S0 = np.asarray(S0, dtype=float)
    mu = np.asarray(mu, dtype=float)
    sigma_idio = np.asarray(sigma_idio, dtype=float)
    beta = np.asarray(beta, dtype=float)
    if not (len(S0) == len(mu) == len(sigma_idio) == len(beta)):
        raise ValueError("S0, mu, sigma_idio, beta must share length")
    n_assets = len(S0)

    dt = T / n_steps
    sqrt_dt = np.sqrt(dt)

    # Common-factor diffusion
    z_c = rng.standard_normal((n_paths, n_steps))
    common = cf.sigma * sqrt_dt * z_c

    # Common-factor crashes: Poisson count then sum-of-normals per cell
    n_jumps = rng.poisson(cf.crash_lam * dt, size=(n_paths, n_steps))
    mask = n_jumps > 0
    if mask.any():
        # Sum of k iid N(μ, σ²) is N(k·μ, k·σ²); sample directly per masked cell
        common[mask] += rng.normal(
            n_jumps[mask] * cf.crash_mu,
            np.sqrt(n_jumps[mask]) * cf.crash_sigma,
        )

    # Idiosyncratic noise (independent across paths × assets × steps)
    z_i = rng.standard_normal((n_paths, n_assets, n_steps))
    idio = sigma_idio[None, :, None] * sqrt_dt * z_i

    # Drift correction — approximate (treats crash mean as absorbed in mu)
    drift = (mu - 0.5 * (beta**2 * cf.sigma**2 + sigma_idio**2))[None, :, None] * dt

    log_inc = drift + beta[None, :, None] * common[:, None, :] + idio
    log_path = np.cumsum(log_inc, axis=2)

    out = np.empty((n_paths, n_assets, n_steps + 1))
    out[:, :, 0] = S0[None, :]
    out[:, :, 1:] = S0[None, :, None] * np.exp(log_path)
    return out


# ─── σ_ref — conservative EWMA realized vol (cvAMM deliverable 2) ─────────────
#
# The on-chain VolOracle's reference vol, consumed by the FairValueOracle. The
# Python helper mirrors the on-chain σ-EWMA estimator (which works on Chainlink
# tick timestamps in *seconds*; here we work on a return series with an explicit
# samples-per-year so the two stay equivalent). See ``quant/SPEC.md`` deliverable
# 2 and spec §6.5.


def ewma_volatility(
    log_returns: np.ndarray,
    halflife_samples: float,
    samples_per_year: float = 365.0,
    *,
    demean: bool = False,
) -> float:
    """Annualised EWMA realized volatility of a log-return series.

    Exponentially-weighted variance with weights ``λ^(age)``, ``λ = 0.5^(1/H)``
    (weight halves every ``halflife_samples`` steps), normalised over the window,
    then annualised by ``√samples_per_year``::

        var = Σ_i w_i · (r_i − r̄)² / Σ_i w_i        # r̄ = 0 unless demean
        σ   = √(var · samples_per_year)

    The most recent return carries the largest weight. ``demean`` defaults to
    ``False`` (RiskMetrics convention: short-horizon log-return mean ≈ 0; raw r²
    is the risk estimate).
    """
    r = np.asarray(log_returns, dtype=float).ravel()
    n = r.size
    if n == 0:
        raise ValueError("log_returns must be non-empty")
    if halflife_samples <= 0:
        raise ValueError("halflife_samples must be > 0")
    lam = 0.5 ** (1.0 / halflife_samples)
    # age 0 = most recent sample (largest weight)
    age = np.arange(n - 1, -1, -1, dtype=float)
    w = lam**age
    w_sum = w.sum()
    if demean:
        mean = float((w * r).sum() / w_sum)
        r = r - mean
    var = float((w * r * r).sum() / w_sum)
    return float(np.sqrt(max(var, 0.0) * samples_per_year))


def sigma_ref(
    log_returns: np.ndarray,
    *,
    short_halflife_samples: float,
    long_halflife_samples: float,
    floor: float,
    samples_per_year: float = 365.0,
    demean: bool = False,
) -> dict[str, float]:
    """``σ_ref = max(σ_short, σ_long, floor)`` — the conservative reference vol.

    **MANDATORY CAVEAT — never price off raw realized σ.** A single fast EWMA
    *understates* risk right before a regime change (realized vol lags the jump),
    so a writer pricing off it would be badly underpriced exactly when it matters
    most. Taking the ``max`` of a short and a long window *and* a hard ``floor``
    is the conservative guardrail. It is **load-bearing for the I10 cap and
    depositor solvency** — but **not** for the FULL no-bad-debt invariant (I1),
    which is structural and oracle-independent (spec §6.5, ``quant/SPEC.md`` §2).

    Returns ``{sigma_ref, sigma_short, sigma_long, floor, binding}`` where
    ``binding`` names which term won (audit-grade provenance for the disclosure).
    """
    s_short = ewma_volatility(log_returns, short_halflife_samples, samples_per_year, demean=demean)
    s_long = ewma_volatility(log_returns, long_halflife_samples, samples_per_year, demean=demean)
    terms = {"sigma_short": s_short, "sigma_long": s_long, "floor": float(floor)}
    binding = max(terms, key=terms.get)
    return {"sigma_ref": float(terms[binding]), "binding": binding, **terms}
