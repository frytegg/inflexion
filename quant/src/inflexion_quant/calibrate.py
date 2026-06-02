"""Compatibility shim — the PARTIAL calibrator moved to
``inflexion_quant.legacy.calibrate`` in P1 (the cvAMM pivot).

Kept at the original import path so the **frozen** ``params.py``
(``from inflexion_quant.calibrate import CalibrationResult, calibrate_all``) and
``test_params.py`` keep working byte-for-byte. **New code must import from
``inflexion_quant.legacy.calibrate`` directly.**
"""

from inflexion_quant.legacy.calibrate import *  # noqa: F401,F403
from inflexion_quant.legacy.calibrate import (  # noqa: F401
    CalibrationResult,
    _ScenarioCache,
    _vectorised_payouts_and_maxils,
    build_scenario_cache,
    calibrate_all,
    calibrate_c_min,
    calibrate_exposure_caps,
    calibrate_fee_curve,
    calibrate_fund_target,
    fund_pnl_from_cache,
    validate_calibration_stability,
)
