"""IL formulas — Python reference implementation of spec.md §3.1 / §3.2 (Task 14.4).

Float-based for use in the Monte Carlo. The Stylus contract in
``packages/contracts/stylus/ILMath/`` uses Q64.96 integer arithmetic for
on-chain determinism — Phase 2 (Tasks 2.10–2.11) cross-checks the two
within numerical tolerance.

Public API:

- :func:`entry_amounts`  — ``(amount0, amount1)`` at swap creation
- :func:`hold_value`     — ``V_hold(T) = amount0_entry·P_T + amount1_entry``
- :func:`lp_value`       — ``V_lp(T)`` across the three regimes
- :func:`compute_il`     — realised IL = ``max(0, V_hold − V_lp)``
- :func:`compute_max_il` — ``MaxIL = max(IL(Pa), IL(Pb))``  (spec §3.2)
- :func:`compute_payout` — FULL-mode payout = ``min(realised_IL, MaxIL)``
- :func:`position_V0`    — notional at creation

All functions are vectorised over ``P_T`` if it is array-like.
"""

from __future__ import annotations

import numpy as np


def entry_amounts(P0: float, Pa: float, Pb: float, L: float) -> tuple[float, float]:
    """Token amounts at swap creation (price P0 in range ``[Pa, Pb]``).

    ``amount0 = L · (1/√P0 − 1/√Pb)`` — token0 (numerator, e.g. ETH).
    ``amount1 = L · (√P0 − √Pa)``    — token1 (denominator, e.g. USDC).

    Raises ``ValueError`` if ``P0`` is outside ``[Pa, Pb]`` — enforces the
    spec §5.2 PHASE 1 invariant ``Pa ≤ P0 ≤ Pb``.
    """
    if not (Pa <= P0 <= Pb):
        raise ValueError(f"P0={P0} must lie in [Pa={Pa}, Pb={Pb}]")
    sqrt_P0 = np.sqrt(P0)
    sqrt_Pa = np.sqrt(Pa)
    sqrt_Pb = np.sqrt(Pb)
    amount0 = float(L * (1 / sqrt_P0 - 1 / sqrt_Pb))
    amount1 = float(L * (sqrt_P0 - sqrt_Pa))
    return amount0, amount1


def hold_value(
    P_T: float | np.ndarray,
    amount0_entry: float,
    amount1_entry: float,
) -> np.ndarray:
    """V_hold(T) — value if the LP had simply held their entry tokens.

    ``V_hold(T) = amount0_entry · P_T + amount1_entry``
    """
    return amount0_entry * np.asarray(P_T, dtype=float) + amount1_entry


def lp_value(
    P_T: float | np.ndarray,
    Pa: float,
    Pb: float,
    L: float,
) -> np.ndarray:
    """V_lp(T) — value of the LP position at price P_T (spec §3.1).

    Three regimes::

        in range  (Pa ≤ P_T ≤ Pb):  V_lp = L · (2√P_T − P_T/√Pb − √Pa)
        below Pa  (full token0):    V_lp = L · (1/√Pa − 1/√Pb) · P_T
        above Pb  (full token1):    V_lp = L · (√Pb − √Pa)
    """
    P_T = np.asarray(P_T, dtype=float)
    out = np.empty_like(P_T)
    sqrt_Pa = np.sqrt(Pa)
    sqrt_Pb = np.sqrt(Pb)

    below = P_T < Pa
    above = P_T > Pb
    inside = ~(below | above)

    if inside.any():
        sqrt_PT = np.sqrt(P_T[inside])
        out[inside] = L * (2 * sqrt_PT - P_T[inside] / sqrt_Pb - sqrt_Pa)
    if below.any():
        out[below] = L * (1 / sqrt_Pa - 1 / sqrt_Pb) * P_T[below]
    if above.any():
        out[above] = L * (sqrt_Pb - sqrt_Pa)

    return out


def compute_il(
    P_T: float | np.ndarray,
    Pa: float,
    Pb: float,
    L: float,
    amount0_entry: float,
    amount1_entry: float,
) -> np.ndarray:
    """Realised IL at settlement = ``max(0, V_hold − V_lp)``. Vectorised over P_T.

    Invariants from ``spec.md`` §13:

    - **I3** — subtraction is *guarded*; if ``V_lp ≥ V_hold``, returns ``0``.
    - **I4** — LP never profits from the swap.
    """
    V_hold = hold_value(P_T, amount0_entry, amount1_entry)
    V_lp = lp_value(P_T, Pa, Pb, L)
    return np.maximum(0.0, V_hold - V_lp)


def compute_max_il(P0: float, Pa: float, Pb: float, L: float) -> float:
    """``MaxIL = max(IL(Pa), IL(Pb))``  (spec §3.2, invariant **I1**).

    IL is convex on ``[Pa, Pb]`` (linear V_hold minus concave V_lp), so its
    in-range max is attained at a boundary. This is the FULL-mode *collateral
    unit* and the payout *cap*.
    """
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    il_at_pa = float(compute_il(np.array([Pa]), Pa, Pb, L, a0, a1)[0])
    il_at_pb = float(compute_il(np.array([Pb]), Pa, Pb, L, a0, a1)[0])
    return max(il_at_pa, il_at_pb)


def compute_payout(
    P_T: float | np.ndarray,
    P0: float,
    Pa: float,
    Pb: float,
    L: float,
) -> np.ndarray:
    """Inflexion FULL-mode payout = ``min(realised_IL, MaxIL)`` (spec §3.2).

    This is *the* function the rest of the quant model uses — the cap is what
    makes FULL bad-debt-free by construction (invariants I1 + I2 combined).
    """
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    IL = compute_il(P_T, Pa, Pb, L, a0, a1)
    max_il = compute_max_il(P0, Pa, Pb, L)
    return np.minimum(IL, max_il)


def position_V0(P0: float, Pa: float, Pb: float, L: float) -> float:
    """Notional ``V0`` at creation = ``amount0_entry · P0 + amount1_entry``."""
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    return float(a0 * P0 + a1)


# ─── Stylus cross-check (Phase 2.11 stub) ────────────────────────────────────


def cross_check_against_stylus(*_args, **_kwargs) -> None:
    """Compare this module's float output against the deployed Stylus contract.

    Phase 2.10 deploys ``ILMath`` to local Nitro; this helper will then fetch
    contract output for the same inputs and assert agreement within rounding
    tolerance (~1 wei after scaling). Currently a stub — implemented when
    the Stylus deployment lands.
    """
    raise NotImplementedError(
        "Phase 2.10 must deploy ILMath to local Nitro before cross-check runs"
    )
