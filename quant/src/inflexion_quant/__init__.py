"""Inflexion quant model.

**Launch (cvAMM-FULL, single-asset ETH/USDC):** the on-chain pricing primitives
live in :mod:`inflexion_quant.cvamm` (FairPremium closed form, baseLoad, the two
skews, the I10 clamp), the σ_ref EWMA helper in :mod:`inflexion_quant.prices`,
the depositor loss-distribution in :mod:`inflexion_quant.depositor`, and the
roadmap sizing (idle / hedge / tranche) in :mod:`inflexion_quant.roadmap`. See
``../SPEC.md`` for the 10-deliverable work order.

**Legacy (PARTIAL multi-asset study):** preserved under
:mod:`inflexion_quant.legacy` (portfolio / stress / calibrate / deck_charts).
The frozen ``params.py`` / ``params.json`` (schema 2.0.0) keep the PARTIAL
outputs; the ``cvamm`` block is documented in ``params.cvamm.schema.json`` and
added with a minor schema bump when the contracts land.
"""

from inflexion_quant import (
    cvamm,
    data,
    depositor,
    il,
    params,
    positions,
    prices,
    roadmap,
)

__version__ = "0.1.0"
__all__ = [
    "cvamm",
    "data",
    "depositor",
    "il",
    "params",
    "positions",
    "prices",
    "roadmap",
]
