"""IL formulas — Python reference implementation of spec.md §3.1 / §3.2.

This module MUST stay numerically consistent with the Stylus / Rust
implementation in ``packages/contracts/stylus/ILMath/``. Phase 14.4
implements the bodies AND adds a cross-check that compares this module's
output against the Stylus contract on a sample of inputs (any divergence
beyond rounding tolerance is a bug in either side).

Notation matches ``spec.md`` §3.1:

- ``P`` = price of token0 in token1 (e.g. ETH in USDC)
- ``sqrt_p_x96`` = ``floor(sqrt(P) * 2**96)`` — Uniswap v3's Q64.96 fixed-point
- ``L`` = position liquidity
- ``Pa``, ``Pb`` = lower and upper tick prices (range bounds)
- ``amount0_entry``, ``amount1_entry`` = token amounts at swap creation
"""

from __future__ import annotations

# ---- Stubs (Phase 14.4 fills) ---------------------------------------------


def compute_max_il(
    sqrt_p_x96: int,
    sqrt_pa_x96: int,
    sqrt_pb_x96: int,
    liquidity: int,
) -> int:
    """Maximum in-range IL = ``max(IL(Pa), IL(Pb))``. See spec.md §3.2.

    Phase 14.4 implements this; current stub raises ``NotImplementedError``.
    """
    raise NotImplementedError("Phase 14.4 — implement per spec.md §3.2")


def compute_il(
    sqrt_p_t_x96: int,
    sqrt_pa_x96: int,
    sqrt_pb_x96: int,
    liquidity: int,
    amount0_entry: int,
    amount1_entry: int,
) -> int:
    """Realized IL at settlement = ``max(0, V_hold − V_lp)``. See spec.md §3.1.

    Phase 14.4 implements the three regimes (in-range / below Pa / above Pb).
    """
    raise NotImplementedError("Phase 14.4 — implement per spec.md §3.1")
