"""Compatibility shim — the PARTIAL stress harness moved to
``inflexion_quant.legacy.stress`` in P1 (the cvAMM pivot).

Kept at the original import path so the **frozen** ``test_params.py``
(``from inflexion_quant.stress import CorrelatedCrashConfig``) keeps working
byte-for-byte. **New code must import from ``inflexion_quant.legacy.stress``
directly** (e.g. the launch depositor module reuses ``var_cvar`` /
``ruin_probability`` from there).
"""

from inflexion_quant.legacy.stress import *  # noqa: F401,F403
from inflexion_quant.legacy.stress import (  # noqa: F401
    CorrelatedCrashConfig,
    TerminalFn,
    VolRegimeShiftConfig,
    correlated_crash,
    correlated_crash_terminal_fn,
    ruin_probability,
    run_scenario,
    summarise,
    utilization_spike,
    var_cvar,
    vol_regime_shift,
    vol_regime_shift_terminal_fn,
)
