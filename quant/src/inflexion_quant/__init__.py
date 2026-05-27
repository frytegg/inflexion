"""Inflexion quant model — Monte Carlo solvency for PARTIAL-mode parameters.

See ``../README.md`` and ``spec.md`` §9 for methodology.
"""

from inflexion_quant import (
    calibrate,
    data,
    deck_charts,
    il,
    params,
    portfolio,
    positions,
    prices,
    stress,
)

__version__ = "0.1.0"
__all__ = [
    "calibrate",
    "data",
    "deck_charts",
    "il",
    "params",
    "portfolio",
    "positions",
    "prices",
    "stress",
]
