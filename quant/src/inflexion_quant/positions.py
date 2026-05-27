"""Heuristic Uniswap v3 LP position structures (Task 14.3).

Samples positions ``(Pa, Pb, P0, L, V0)`` from a hand-picked mixture of
range widths intended to **bracket** observed crypto-major LP behaviour:

- ~30% tight   (±5%)  — high-fee active LPs, frequent re-ranging
- ~40% moderate (±15%) — "passive concentrated", re-range monthly
- ~25% wide    (±30%) — low-maintenance
- ~5%  v2-like (±80%) — set-and-forget

**These weights and half-widths are placeholders, not calibrations.** They
are not fit to on-chain data; they are an informed guess at "what a realistic
mix might look like" pending empirical replacement.

Mainnet replacement (audit B4): ingest live Uniswap v3 NFT distribution
via the subgraph, computing tick-width quantiles per market. JIT (Just-In-
Time) liquidity bots provide single-tick positions that dominate by count;
the current mixture underweights them and over-represents wide ranges.
Tight-range LPs hit MaxIL on smaller moves, so the current mixture likely
**under-estimates** the fund's tail exposure.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd
from numpy.random import Generator


@dataclass(frozen=True)
class PositionMix:
    """Mixture-of-buckets describing realistic LP behaviour.

    ``half_widths[i]`` is the typical ±half-width as a fraction of P0
    (so ``0.10`` ≡ ±10% in price space). ``weights[i]`` is the probability
    of a position falling in bucket ``i``. Weights are renormalised on use.
    """

    weights: Sequence[float]
    half_widths: Sequence[float]

    def __post_init__(self) -> None:
        if len(self.weights) != len(self.half_widths):
            raise ValueError("weights and half_widths must have same length")
        if any(w < 0 for w in self.weights):
            raise ValueError("weights must be non-negative")
        if any(h <= 0 for h in self.half_widths):
            raise ValueError("half_widths must be positive")

    @classmethod
    def crypto_majors(cls) -> "PositionMix":
        """Default mix for ETH/BTC/ARB-style markets."""
        return cls(
            weights=[0.30, 0.40, 0.25, 0.05],
            half_widths=[0.05, 0.15, 0.30, 0.80],
        )


def sample_positions(
    n: int,
    P0: float,
    mix: PositionMix,
    rng: Generator,
    *,
    median_V0: float = 5_000.0,
    log_V0_sigma: float = 1.5,
    half_width_jitter: float = 0.25,
    max_offset_fraction: float = 0.40,
) -> pd.DataFrame:
    """Sample n LP positions from a mixture.

    For each position:

    1. Pick a bucket (multinomial over ``mix.weights``).
    2. Jitter the bucket's half-width log-normally (``half_width_jitter`` is
       the std of the log multiplier — blurs discrete buckets into a continuum).
    3. Sample an offset (where P0 sits inside ``[Pa, Pb]``) from a centred
       Beta(2, 2) scaled to ±``max_offset_fraction`` × log-half-width.
    4. Sample V0 log-normally with ``median_V0`` and ``log_V0_sigma``.
    5. Derive L from V0 + geometry (closed-form, no root-finding).

    Returns a DataFrame with columns:
        ``[bucket, half_width, offset_fraction, P0, Pa, Pb, L, V0]``.
    """
    weights = np.asarray(mix.weights, dtype=float)
    weights = weights / weights.sum()
    bucket = rng.choice(len(weights), size=n, p=weights)
    base_hw = np.asarray(mix.half_widths)[bucket]

    # Jitter half-width log-normally
    hw = base_hw * np.exp(rng.normal(0, half_width_jitter, size=n))
    hw = np.clip(hw, 0.005, 2.0)  # ±0.5% to ±200% sanity bound

    # Offset: Beta(2,2) is bell-shaped on [0,1]; rescale to [-1,1] then shrink
    offset_fraction = max_offset_fraction * (2 * rng.beta(2, 2, size=n) - 1)

    # Place Pa, Pb in log-space (so centered ≡ log-symmetric ≡ what v3 favours)
    #   log(Pb / P0) = w + δ
    #   log(P0 / Pa) = w − δ
    # with w = log(1 + hw) and δ = offset_fraction · w.
    w_log = np.log1p(hw)
    delta = offset_fraction * w_log
    Pa = P0 * np.exp(-(w_log - delta))
    Pb = P0 * np.exp(w_log + delta)

    # V0 log-normal
    V0 = np.exp(np.log(median_V0) + log_V0_sigma * rng.standard_normal(n))

    # Derive L from V0 + geometry:  V0 = L · (2√P0 − P0/√Pb − √Pa)
    sqrt_P0 = np.sqrt(P0)
    sqrt_Pa = np.sqrt(Pa)
    sqrt_Pb = np.sqrt(Pb)
    denom = 2 * sqrt_P0 - P0 / sqrt_Pb - sqrt_Pa
    L = V0 / denom

    return pd.DataFrame({
        "bucket": bucket,
        "half_width": hw,
        "offset_fraction": offset_fraction,
        "P0": P0,
        "Pa": Pa,
        "Pb": Pb,
        "L": L,
        "V0": V0,
    })
