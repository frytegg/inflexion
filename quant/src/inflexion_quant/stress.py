"""Task 14.6 — stress scenarios for the Insurance Fund P&L distribution.

Builds three named stresses on top of the simulators in :mod:`prices` and the
waterfall in :mod:`portfolio`:

1. :func:`correlated_crash` — multi-asset, common-factor shocks that hit the
   whole book simultaneously (Gaussian diffusion + Poisson-Normal crash jumps
   via :func:`prices.common_factor_paths`). Diversification breaks down.
2. :func:`vol_regime_shift` — a single shared GBM path whose annualised
   volatility jumps mid-horizon (e.g. 60% → 150%). Premiums quoted at the
   baseline regime under-price realised IL after the shift.
3. :func:`utilization_spike` — the correlated-crash mechanism with the book
   scaled up. Fund_pays_total scales with book size while the fund's equity
   does not — drives the per-market exposure cap calibrated in 14.7.

Each scenario emits a per-run DataFrame; tail-risk helpers
(:func:`ruin_probability`, :func:`var_cvar`, :func:`summarise`) collapse that
into the numbers Task 14.7 calibrates against (``c_min``, fee curve, fund
balance target for ``P(ruin) ≤ 0.1%``).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from numpy.random import Generator

from inflexion_quant.portfolio import WaterfallConfig, aggregate, waterfall
from inflexion_quant.positions import PositionMix, sample_positions
from inflexion_quant.prices import CommonFactor, common_factor_paths


# A function that produces terminal prices for the batch given (positions, rng).
TerminalFn = Callable[[pd.DataFrame, Generator], np.ndarray]


# ─── Generic MC runner ───────────────────────────────────────────────────────


def run_scenario(
    *,
    n_runs: int,
    n_positions: int,
    waterfall_cfg: WaterfallConfig,
    terminal_price_fn: TerminalFn,
    rng: Generator,
    P0: float = 100.0,
    mix: PositionMix | None = None,
    resample_positions: bool = True,
) -> pd.DataFrame:
    """Run ``n_runs`` Monte Carlo replications and collect per-run fund metrics.

    Per replication: optionally resample a fresh book, draw terminal prices
    via ``terminal_price_fn(positions, rng)``, run the waterfall, aggregate.

    Returns a DataFrame with one row per run: ``run_id`` plus every key
    emitted by :func:`portfolio.aggregate`.
    """
    if n_runs < 1:
        raise ValueError(f"n_runs must be >= 1, got {n_runs}")
    if n_positions < 1:
        raise ValueError(f"n_positions must be >= 1, got {n_positions}")

    chosen_mix = mix or PositionMix.crypto_majors()
    fixed_book = (
        None
        if resample_positions
        else sample_positions(n_positions, P0=P0, mix=chosen_mix, rng=rng)
    )

    rows = []
    for run in range(n_runs):
        positions = (
            sample_positions(n_positions, P0=P0, mix=chosen_mix, rng=rng)
            if resample_positions
            else fixed_book
        )
        P_T = terminal_price_fn(positions, rng)
        per_swap = waterfall(positions, P_T, waterfall_cfg)
        rows.append({"run_id": run, **aggregate(per_swap)})
    return pd.DataFrame(rows)


# ─── Scenario 1: correlated common-factor crash ─────────────────────────────


@dataclass(frozen=True)
class CorrelatedCrashConfig:
    """Multi-asset correlated crash via :func:`prices.common_factor_paths`.

    Each Monte Carlo run draws ONE multi-asset shock realisation and assigns
    each position uniformly to one of the assets. All assets share the same
    common (jumpy) factor — diversification across assets is partial.

    Defaults are tuned for the 30-day horizon used in notebook 04:

    * ``moderate()`` — ~1 crash per ~6 months, mean -15% per crash. Background.
    * ``severe()`` — ~1 crash per month, mean -35% per crash, fat-tailed.
    """

    n_assets: int = 4
    mu: float = 0.0
    sigma_idio: float = 0.30
    beta: float = 1.0
    common: CommonFactor = field(
        default_factory=lambda: CommonFactor(
            sigma=0.40, crash_lam=2.0, crash_mu=-0.15, crash_sigma=0.05
        )
    )
    T_years: float = 30 / 365
    n_steps: int = 30

    @classmethod
    def moderate(cls) -> "CorrelatedCrashConfig":
        return cls()

    @classmethod
    def severe(cls) -> "CorrelatedCrashConfig":
        """Empirical 99th-percentile correlated stress, anchored to real
        crypto crash episodes — NOT reverse-engineered to a target c_min.

        Reference episodes (intraday → multi-day correlated downside):

        * **March 12 2020 (COVID)**: ETH/BTC −40 to −50% in 24 h, all majors
          drawn down together; cross-asset corr ≈ 1.0.
        * **May 2021 leverage flush**: BTC −30%, ETH −45% in a week.
        * **Terra-LUNA collapse (May 2022)**: ETH −35% over 7 days driven by
          a common factor (DeFi unwind), USDT briefly depegged.
        * **FTX (Nov 2022)**: BTC −25%, ETH −22% in 3 days; correlations
          spiked from ~0.6 → ~0.95.

        Calibration choices (jump-diffusion fit, not tuned to a c_min target):

        * ``crash_lam = 6`` per year → ~0.5 crashes per 30-day horizon
          (matches frequency of "20%+ in a week" market-wide events,
          ~1 per ~2 months across 2020-2025).
        * ``crash_mu = -0.40`` (log-scale) → ~33% mean drop conditional on a
          crash. Anchored to the Terra/FTX-week magnitude.
        * ``crash_sigma = 0.15`` → 1σ spread on jump size; covers the
          difference between FTX-week (−25%) and COVID-day (−50%) draws.
        * ``sigma = 0.60`` (common-factor annual diffusion vol) ≈ realized
          BTC/ETH 30d vol during 2022 bear; ``sigma_idio = 0.45`` ≈ typical
          excess vol per asset above the market factor.

        The resulting 30-day horizon 99th-percentile drawdown is roughly
        −45 to −65% — bracketing the empirical worst case for crypto majors.

        Auditor note: the May 2026 audit (GPT-5 + Gemini 2.5) flagged the
        prior parameterisation (``crash_lam=24``) as detached from empirical
        crash frequency. Re-anchored here.
        """
        return cls(
            sigma_idio=0.45,
            common=CommonFactor(
                sigma=0.60, crash_lam=6.0, crash_mu=-0.40, crash_sigma=0.15
            ),
        )


def correlated_crash_terminal_fn(cfg: CorrelatedCrashConfig) -> TerminalFn:
    """Build a :data:`TerminalFn` that draws one correlated multi-asset path
    per call and maps positions to assets uniformly."""

    def fn(positions: pd.DataFrame, rng: Generator) -> np.ndarray:
        n = len(positions)
        P0 = float(positions["P0"].iloc[0])
        S0 = np.full(cfg.n_assets, P0)
        mu = np.full(cfg.n_assets, cfg.mu)
        sigma_idio = np.full(cfg.n_assets, cfg.sigma_idio)
        beta = np.full(cfg.n_assets, cfg.beta)

        paths = common_factor_paths(
            S0=S0,
            mu=mu,
            sigma_idio=sigma_idio,
            beta=beta,
            cf=cfg.common,
            T=cfg.T_years,
            n_steps=cfg.n_steps,
            n_paths=1,
            rng=rng,
        )  # (1, n_assets, n_steps+1)
        P_T_per_asset = paths[0, :, -1]
        asset_id = rng.integers(0, cfg.n_assets, size=n)
        return P_T_per_asset[asset_id]

    return fn


def correlated_crash(
    *,
    n_runs: int,
    n_positions: int,
    waterfall_cfg: WaterfallConfig,
    rng: Generator,
    cfg: CorrelatedCrashConfig | None = None,
    P0: float = 100.0,
    mix: PositionMix | None = None,
) -> pd.DataFrame:
    """Scenario 1 driver. See :class:`CorrelatedCrashConfig` for stress dials."""
    return run_scenario(
        n_runs=n_runs,
        n_positions=n_positions,
        waterfall_cfg=waterfall_cfg,
        terminal_price_fn=correlated_crash_terminal_fn(cfg or CorrelatedCrashConfig()),
        rng=rng,
        P0=P0,
        mix=mix,
        resample_positions=True,
    )


# ─── Scenario 2: vol regime shift ───────────────────────────────────────────


@dataclass(frozen=True)
class VolRegimeShiftConfig:
    """Single shared GBM path with piecewise-constant σ jumping mid-horizon.

    All positions see the SAME terminal price — this is the "the market
    realised more vol than I priced" stress: premiums quoted at
    ``sigma_baseline`` while the path is actually driven by
    ``sigma_shock`` from step ``shock_at_step`` onward.
    """

    sigma_baseline: float = 0.60
    sigma_shock: float = 1.50
    shock_at_step: int = 15
    mu: float = 0.0
    T_years: float = 30 / 365
    n_steps: int = 30

    def __post_init__(self) -> None:
        if not 0 <= self.shock_at_step <= self.n_steps:
            raise ValueError(
                f"shock_at_step must be in [0, n_steps={self.n_steps}], got {self.shock_at_step}"
            )
        if self.sigma_baseline < 0 or self.sigma_shock < 0:
            raise ValueError("sigmas must be non-negative")


def vol_regime_shift_terminal_fn(cfg: VolRegimeShiftConfig) -> TerminalFn:
    """One shared GBM path with σ jumping at ``cfg.shock_at_step``; same
    terminal price applied to every position in the batch."""

    def fn(positions: pd.DataFrame, rng: Generator) -> np.ndarray:
        n = len(positions)
        P0 = float(positions["P0"].iloc[0])

        dt = cfg.T_years / cfg.n_steps
        sqrt_dt = np.sqrt(dt)
        z = rng.standard_normal(cfg.n_steps)
        sigma_per_step = np.where(
            np.arange(cfg.n_steps) < cfg.shock_at_step,
            cfg.sigma_baseline,
            cfg.sigma_shock,
        )
        log_inc = (
            (cfg.mu - 0.5 * sigma_per_step**2) * dt + sigma_per_step * sqrt_dt * z
        )
        terminal_log = float(log_inc.sum())
        P_T = P0 * np.exp(terminal_log)
        return np.full(n, P_T)

    return fn


def vol_regime_shift(
    *,
    n_runs: int,
    n_positions: int,
    waterfall_cfg: WaterfallConfig,
    rng: Generator,
    cfg: VolRegimeShiftConfig | None = None,
    P0: float = 100.0,
    mix: PositionMix | None = None,
) -> pd.DataFrame:
    """Scenario 2 driver. See :class:`VolRegimeShiftConfig` for the shock dial."""
    return run_scenario(
        n_runs=n_runs,
        n_positions=n_positions,
        waterfall_cfg=waterfall_cfg,
        terminal_price_fn=vol_regime_shift_terminal_fn(cfg or VolRegimeShiftConfig()),
        rng=rng,
        P0=P0,
        mix=mix,
        resample_positions=True,
    )


# ─── Scenario 3: utilization spike ──────────────────────────────────────────


def utilization_spike(
    *,
    n_runs: int,
    n_positions_base: int,
    spike_multiplier: float,
    waterfall_cfg: WaterfallConfig,
    rng: Generator,
    cfg: CorrelatedCrashConfig | None = None,
    P0: float = 100.0,
    mix: PositionMix | None = None,
) -> pd.DataFrame:
    """Correlated crash with the book scaled to ``n_positions_base ·
    spike_multiplier``.

    Fund_pays_total scales (roughly) linearly with book; fund equity does not.
    Task 14.7 uses this to set per-market and per-MM exposure caps.
    """
    if spike_multiplier <= 0:
        raise ValueError(f"spike_multiplier must be > 0, got {spike_multiplier}")
    return correlated_crash(
        n_runs=n_runs,
        n_positions=max(1, int(round(n_positions_base * spike_multiplier))),
        waterfall_cfg=waterfall_cfg,
        rng=rng,
        cfg=cfg,
        P0=P0,
        mix=mix,
    )


# ─── Tail-risk helpers ──────────────────────────────────────────────────────


def ruin_probability(
    pnl_distribution: pd.Series | np.ndarray,
    initial_fund_balance: float = 0.0,
    threshold: float = 0.0,
) -> float:
    """``P(initial_fund_balance + fund_pnl < threshold)``.

    With defaults this is just ``P(fund loses money)``. For calibration,
    pass the current fund equity and ``threshold=0`` to compute
    ``P(bankruptcy)``.
    """
    arr = np.asarray(pnl_distribution, dtype=float)
    return float(np.mean(arr + initial_fund_balance < threshold))


def var_cvar(
    pnl_distribution: pd.Series | np.ndarray,
    confidence: float = 0.99,
) -> tuple[float, float]:
    """Value-at-Risk and Conditional-VaR at the given confidence.

    Reported as **positive losses**::

        VaR(α)  = -quantile(pnl, 1-α)
        CVaR(α) = -E[pnl | pnl ≤ quantile(pnl, 1-α)]
    """
    if not 0.0 < confidence < 1.0:
        raise ValueError(f"confidence must be in (0,1); got {confidence}")
    arr = np.asarray(pnl_distribution, dtype=float)
    cutoff = float(np.quantile(arr, 1.0 - confidence))
    var = -cutoff
    tail = arr[arr <= cutoff]
    cvar = float(-tail.mean()) if len(tail) > 0 else var
    return var, cvar


def summarise(
    per_run: pd.DataFrame,
    *,
    initial_fund_balance: float = 0.0,
    pnl_col: str = "fund_pnl_total",
) -> dict[str, float | int]:
    """Tail-risk summary of a per-run scenario DataFrame.

    Returns ``n_runs, mean, std, min, p1, p5, p50, p95, p99, max,
    ruin_p, var_99, cvar_99``.
    """
    pnl = per_run[pnl_col]
    var_99, cvar_99 = var_cvar(pnl, confidence=0.99)
    return {
        "n_runs": int(len(pnl)),
        "mean": float(pnl.mean()),
        "std": float(pnl.std()),
        "min": float(pnl.min()),
        "p1": float(np.quantile(pnl, 0.01)),
        "p5": float(np.quantile(pnl, 0.05)),
        "p50": float(np.quantile(pnl, 0.50)),
        "p95": float(np.quantile(pnl, 0.95)),
        "p99": float(np.quantile(pnl, 0.99)),
        "max": float(pnl.max()),
        "ruin_p": ruin_probability(pnl, initial_fund_balance),
        "var_99": var_99,
        "cvar_99": cvar_99,
    }
