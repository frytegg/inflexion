"""Single-asset cvAMM depositor loss distribution (cvAMM deliverable 10).

The ConvexityVault depositor is a **volatility seller**: they collect the premium
(priced under the risk-neutral measure at the conservative ``σ_ref``) and pay
realised ``min(IL, MaxIL)`` claims (incurred under the **real** measure — actual
ETH dynamics with drift, fat tails and crash correlation). In calm markets the
vol-risk-premium (``baseLoad``) is earned; in a crash the locked book pays out
together and the depositor absorbs the loss.

This module produces the headline disclosure figures — long-run mean APY,
P(losing month), 1-in-100-month loss, worst-month drawdown — from a Monte-Carlo
of the monthly depositor P&L. The generic tail-risk helpers ``var_cvar`` /
``ruin_probability`` are re-imported from the legacy stress harness.

**Verbatim disclosure tone (mandatory, never "stable/modest APY"):**

    "You earn the volatility risk premium in calm markets and absorb losses in
     crashes. In FULL the pool cannot become insolvent and cannot be run, but
     YOUR CAPITAL IS NOT GUARANTEED."

**Two separate claims, never merged:** (1) LPs are always paid — no bad debt,
FULL, code-enforced (I1); (2) depositors can lose principal in a crash — capital
NOT guaranteed.

The model here is the **machinery** (clean, parameterised, real-measure GBM by
default). The P1.13 heavy run swaps in jump-diffusion / GARCH / crash-correlation
and the 2020–2025 backtest to produce the FINAL numbers; the figures this module
emits under GBM are labelled accordingly and are **placeholders** until then.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.random import Generator

from inflexion_quant import cvamm as cv
from inflexion_quant.legacy.stress import ruin_probability, var_cvar
from inflexion_quant.positions import PositionMix, sample_positions

DAYS_PER_YEAR = 365.0

DISCLOSURE_TEXT = (
    "You earn the volatility risk premium in calm markets and absorb losses in "
    "crashes. In FULL the pool cannot become insolvent and cannot be run, but "
    "YOUR CAPITAL IS NOT GUARANTEED."
)

TWO_SEPARATE_CLAIMS = (
    "(1) LPs are always paid — no bad debt, FULL, code-enforced (I1).",
    "(2) Depositors can lose principal in a crash — capital NOT guaranteed.",
)


@dataclass(frozen=True)
class DepositorModel:
    """Real-measure assumptions for the depositor P&L Monte Carlo.

    ``sigma_real`` is the realised ETH vol the book actually faces; ``sigma_ref``
    is the conservative oracle vol the premium is priced at (``σ_ref ≥
    realised`` is the whole point — it is the writer's margin). ``base_load`` is
    the structural load over fair; ``utilization`` is the fraction of depositor
    capital locked as MaxIL collateral at any time. ``horizon_days`` is the
    duration cohort whose monthly turnover defines the disclosure period.
    """

    sigma_real: float = 0.70
    sigma_ref: float = 0.80
    base_load: float = 0.20
    utilization: float = 0.60
    horizon_days: int = 30
    mu_real: float = 0.0
    mix: PositionMix = field(default_factory=PositionMix.crypto_majors)
    P0: float = 3000.0


def _book_premium_and_payout_fracs(
    positions, *, sigma_ref: float, base_load: float, P_T: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-position (premium_frac, payout_frac, max_il), all as fractions of MaxIL
    except max_il (USDC). ``premium_frac = fairRate(σ_ref)·(1+baseLoad)`` is the
    income; ``payout_frac = min(IL,MaxIL)/MaxIL`` is the realised claim."""
    P0 = positions["P0"].to_numpy(dtype=float)
    Pa = positions["Pa"].to_numpy(dtype=float)
    Pb = positions["Pb"].to_numpy(dtype=float)
    L = positions["L"].to_numpy(dtype=float)
    payout, max_il = cv.batch_payouts_and_maxils(P0, Pa, Pb, L, P_T)
    payout_frac = np.where(max_il > 0, payout / max_il, 0.0)
    return payout, max_il, payout_frac


def simulate_monthly_pnl(
    model: DepositorModel,
    *,
    n_months: int = 50_000,
    n_positions: int = 200,
    rng: Generator | None = None,
    terminal_fn=None,
) -> np.ndarray:
    """Monthly depositor P&L as a **fraction of capital**.

    Each trial: resample a book of ``n_positions`` single-asset positions; draw
    one real-measure ETH path over ``horizon_days`` (every position settles
    against the *same* path — the honest single-pair synchronisation, so a crash
    hits the whole book together); the depositor earns
    ``premium = fairRate(σ_ref)·(1+baseLoad)·MaxIL`` and pays ``min(IL,MaxIL)``::

        monthly_return = utilization · Σ(premium_i − payout_i) / Σ MaxIL_i

    (capital ≈ ΣMaxIL/utilization). Pass ``terminal_fn(positions, rng) -> P_T``
    to substitute jump-diffusion / GARCH / crash-correlation paths (P1.13).
    """
    rng = rng or np.random.default_rng(20260601)
    fair_premium_frac = 1.0 + model.base_load  # times fairRate, per position
    T = model.horizon_days / DAYS_PER_YEAR
    drift = (model.mu_real - 0.5 * model.sigma_real**2) * T
    vol = model.sigma_real * np.sqrt(T)

    out = np.empty(n_months)
    for m in range(n_months):
        positions = sample_positions(n_positions, P0=model.P0, mix=model.mix, rng=rng)
        if terminal_fn is not None:
            P_T = terminal_fn(positions, rng)
        else:
            # One shared ETH terminal for the whole book (synchronised single pair)
            z = rng.standard_normal()
            P_T = np.full(n_positions, model.P0 * np.exp(drift + vol * z))
        P0 = positions["P0"].to_numpy(dtype=float)
        Pa = positions["Pa"].to_numpy(dtype=float)
        Pb = positions["Pb"].to_numpy(dtype=float)
        L = positions["L"].to_numpy(dtype=float)
        payout, max_il = cv.batch_payouts_and_maxils(P0, Pa, Pb, L, P_T)
        # premium per position priced at sigma_ref (risk-neutral closed form, vectorised)
        fair = cv.fair_rate_vec(P0, Pa, Pb, L, model.sigma_ref, T)
        premium = fair * fair_premium_frac * max_il
        total_maxil = max_il.sum()
        if total_maxil <= 0:
            out[m] = 0.0
            continue
        out[m] = model.utilization * (premium.sum() - payout.sum()) / total_maxil
    return out


def disclosure(
    model: DepositorModel | None = None,
    *,
    n_months: int = 50_000,
    n_positions: int = 200,
    rng_seed: int = 20260601,
    label: str = "GBM real-measure (machinery placeholder — see P1.13 heavy run)",
    terminal_fn=None,
) -> dict[str, object]:
    """Headline single-asset depositor disclosure figures.

    Returns ``apy`` (annualised, compounded over monthly turnover),
    ``p_losing_month``, ``loss_1in100`` (1st-percentile monthly loss as a
    fraction of capital), ``worst_month``, plus the verbatim disclosure text and
    the two-separate-claims statement. ``label`` records the price model so a
    placeholder is never mistaken for a calibrated number.
    """
    model = model or DepositorModel()
    rng = np.random.default_rng(rng_seed)
    pnl = simulate_monthly_pnl(
        model, n_months=n_months, n_positions=n_positions, rng=rng, terminal_fn=terminal_fn
    )

    periods_per_year = DAYS_PER_YEAR / model.horizon_days
    mean_monthly = float(pnl.mean())
    # Compounded APY over the natural turnover (clip the base to avoid blow-ups
    # from a single catastrophic month in the compounding identity).
    apy = float((1.0 + max(mean_monthly, -0.99)) ** periods_per_year - 1.0)
    var99, cvar99 = var_cvar(pnl, confidence=0.99)
    return {
        "label": label,
        "model": {
            "sigma_real": model.sigma_real,
            "sigma_ref": model.sigma_ref,
            "base_load": model.base_load,
            "utilization": model.utilization,
            "horizon_days": model.horizon_days,
            "mu_real": model.mu_real,
        },
        "apy": apy,
        "mean_monthly_return": mean_monthly,
        "p_losing_month": ruin_probability(pnl, threshold=0.0),
        "loss_1in100": float(max(0.0, -np.quantile(pnl, 0.01))),
        "cvar99_monthly": float(cvar99),
        "worst_month": float(max(0.0, -pnl.min())),
        "best_month": float(pnl.max()),
        "n_months": int(n_months),
        "disclosure_text": DISCLOSURE_TEXT,
        "two_separate_claims": list(TWO_SEPARATE_CLAIMS),
        "safety_targets": {
            "p_losing_month_max": 0.15,
            "loss_1in100_max": 0.10,
            "apy_positive": True,
        },
        "_pnl_summary": {
            "p5": float(np.quantile(pnl, 0.05)),
            "p50": float(np.quantile(pnl, 0.50)),
            "p95": float(np.quantile(pnl, 0.95)),
        },
    }
