"""PARTIAL portfolio waterfall — spec §8 + §9 step 3 (Task 14.5).

Given a batch of swaps with realised terminal prices, distribute each LP
payout across (i) the MM's posted collateral and (ii) the Insurance Fund's
reinsurance tail, then aggregate the fund's P&L.

Per swap::

    MaxIL         = max(IL(Pa), IL(Pb))                 # spec §3.2, invariant I1
    payout        = min(realised_IL, MaxIL)             # invariants I1 + I2
    mm_collateral = c · V0                              # MM posts c of V0
    mm_pays       = min(payout, mm_collateral)
    fund_pays     = max(0, payout − mm_collateral)      # PARTIAL reinsurance tail

    premium       = premium_rate_of_maxil · MaxIL       # spec §4.2
    fund_inflow   = premium · (premium_share + fee(c))  # spec §8.7 inflows A + B
    mm_keeps      = premium · (1 − premium_share − fee(c))

    fund_pnl_swap = fund_inflow − fund_pays

This module is the simulator that Tasks 14.6 (stress) and 14.7 (calibrate)
ride on top of. FULL mode is recovered by setting ``c ≥ MaxIL/V0`` per
position — then ``fund_pays == 0`` always (invariant I1).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import pandas as pd

from inflexion_quant.il import compute_max_il, compute_payout


# ─── Fee curve (placeholder; Task 14.7 calibrates the real schedule) ─────────


def default_fee_curve(
    c: float,
    *,
    c_ref: float = 0.20,
    fee_ref: float = 0.01,
    exponent: float = 2.32,
) -> float:
    """Convex placeholder leverage-tax curve.

    Fits spec §8.3 illustrative pivots at moderate ``c``::

        c = 0.20 → fee ≈ 1%     (anchor)
        c = 0.15 → fee ≈ 2%
        c = 0.10 → fee ≈ 5%
        c = 0.05 → fee ≈ 25%    (overshoots spec's 12% — calibration job)

    Task 14.7 replaces this with a curve fit so portfolio ruin
    probability ≤ 0.1% under the 99.9th-percentile common-factor crash.
    """
    return fee_ref * (c_ref / max(c, 1e-3)) ** exponent


# ─── Config ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WaterfallConfig:
    """Per-batch PARTIAL economic parameters.

    All values apply uniformly across the batch; Tasks 14.6 / 14.7 sweep them.
    """

    c: float
    """MM collateral as a fraction of V0 (e.g. 0.10 = 10% PARTIAL)."""

    premium_rate_of_maxil: float
    """Premium as a fraction of MaxIL (e.g. 0.75 = 75% — what MMs quote)."""

    premium_share_to_fund: float = 0.20
    """Share of premium routed to the fund (spec §8.7 inflow A)."""

    fee_curve: Callable[[float], float] = default_fee_curve
    """Convex leverage tax on premium (spec §8.7 inflow B). Evaluated at ``c``."""

    def __post_init__(self) -> None:
        if not 0.0 < self.c <= 1.0:
            raise ValueError(f"c must be in (0, 1]; got {self.c}")
        if not 0.0 <= self.premium_rate_of_maxil <= 1.0:
            raise ValueError(
                f"premium_rate_of_maxil out of [0,1]: {self.premium_rate_of_maxil}"
            )
        if not 0.0 <= self.premium_share_to_fund <= 1.0:
            raise ValueError(
                f"premium_share_to_fund out of [0,1]: {self.premium_share_to_fund}"
            )


# ─── Waterfall ───────────────────────────────────────────────────────────────


_REQUIRED_COLS = ("P0", "Pa", "Pb", "L", "V0")


def waterfall(
    positions: pd.DataFrame,
    P_T: np.ndarray,
    cfg: WaterfallConfig,
) -> pd.DataFrame:
    """Apply the PARTIAL waterfall to a batch of ``(position, terminal-price)`` pairs.

    Parameters
    ----------
    positions : DataFrame
        One row per swap with columns ``P0, Pa, Pb, L, V0``.
    P_T : array of shape ``(n,)``
        Terminal price per position (same ordering as ``positions``).
    cfg : WaterfallConfig
        Economic parameters.

    Returns
    -------
    DataFrame
        ``n`` rows, columns::

            P0, Pa, Pb, L, V0, P_T,
            max_il, payout, premium,
            mm_collateral, mm_pays, fund_pays,
            fund_premium_share, fund_fee_tax, fund_inflow, fund_pnl
    """
    missing = [c for c in _REQUIRED_COLS if c not in positions.columns]
    if missing:
        raise ValueError(f"positions missing columns: {missing}")

    n = len(positions)
    P_T = np.asarray(P_T, dtype=float)
    if P_T.shape != (n,):
        raise ValueError(f"P_T shape {P_T.shape} != ({n},)")

    P0 = positions["P0"].to_numpy(dtype=float)
    Pa = positions["Pa"].to_numpy(dtype=float)
    Pb = positions["Pb"].to_numpy(dtype=float)
    L = positions["L"].to_numpy(dtype=float)
    V0 = positions["V0"].to_numpy(dtype=float)

    max_il = np.empty(n)
    payout = np.empty(n)
    for i in range(n):
        max_il[i] = compute_max_il(P0[i], Pa[i], Pb[i], L[i])
        payout[i] = float(compute_payout(P_T[i], P0[i], Pa[i], Pb[i], L[i]))

    mm_collateral = cfg.c * V0
    mm_pays = np.minimum(payout, mm_collateral)
    fund_pays = np.maximum(0.0, payout - mm_collateral)

    premium = cfg.premium_rate_of_maxil * max_il
    fee_pct = float(cfg.fee_curve(cfg.c))
    fund_premium_share = premium * cfg.premium_share_to_fund
    fund_fee_tax = premium * fee_pct
    fund_inflow = fund_premium_share + fund_fee_tax
    fund_pnl = fund_inflow - fund_pays

    return pd.DataFrame(
        {
            "P0": P0,
            "Pa": Pa,
            "Pb": Pb,
            "L": L,
            "V0": V0,
            "P_T": P_T,
            "max_il": max_il,
            "payout": payout,
            "premium": premium,
            "mm_collateral": mm_collateral,
            "mm_pays": mm_pays,
            "fund_pays": fund_pays,
            "fund_premium_share": fund_premium_share,
            "fund_fee_tax": fund_fee_tax,
            "fund_inflow": fund_inflow,
            "fund_pnl": fund_pnl,
        }
    )


def aggregate(per_swap: pd.DataFrame) -> dict[str, float | int]:
    """Roll a per-swap waterfall into portfolio totals.

    Useful in 14.6 (stress) and 14.7 (calibrate), where we re-run
    :func:`waterfall` across many price-path samples to build the
    fund-P&L distribution.
    """
    return {
        "n_swaps": int(len(per_swap)),
        "lp_payout_total": float(per_swap["payout"].sum()),
        "mm_pays_total": float(per_swap["mm_pays"].sum()),
        "fund_pays_total": float(per_swap["fund_pays"].sum()),
        "fund_inflow_total": float(per_swap["fund_inflow"].sum()),
        "fund_pnl_total": float(per_swap["fund_pnl"].sum()),
        "n_fund_tail_hits": int((per_swap["fund_pays"] > 0).sum()),
        "max_single_fund_pays": float(per_swap["fund_pays"].max()),
    }
