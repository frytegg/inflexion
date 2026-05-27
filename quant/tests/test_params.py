"""Tests for inflexion_quant.params — Task 14.8 versioned params.json."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from inflexion_quant.calibrate import calibrate_all
from inflexion_quant.params import (
    PARAMS_SCHEMA_VERSION,
    BreakerLevels,
    ExposureCaps,
    FeeCurveParams,
    FloorCurve,
    Params,
    emit_params,
)
from inflexion_quant.stress import CorrelatedCrashConfig


# ─── helpers ─────────────────────────────────────────────────────────────────


def _minimal_valid_params_dict() -> dict:
    """Hand-built dict that's the smallest valid Params (no calibration run)."""
    return {
        "schema_version": PARAMS_SCHEMA_VERSION,
        "quant_package_version": "0.1.0",
        "created_at": "2026-05-27T12:00:00+00:00",
        "c_min": 0.10,
        "floor_curve": {"c_at_baseline_vol": 0.10, "note": "single-σ"},
        "fee_curve": {
            "fee_ref_recommended": 0.02,
            "fee_pct_at_c": 0.08,
            "placeholder_fee_pct_at_c": 0.05,
            "c_ref": 0.20,
            "exponent": 2.32,
            "median_pnl_at_refit": 0.1,
            "feasible_in_fee_search": True,
        },
        "breakers": {"L0": 1.0, "L1": 0.7, "L2": 0.4, "L3": 0.0},
        "withdrawal_delay_seconds": 7 * 86_400,
        "exposure_caps": {
            "per_market_cap": 500,
            "per_mm_cap": 100,
            "n_mms_per_market": 5,
        },
        "first_loss_fraction": 0.02,
        "fund_target": 50_000.0,
        "ruin_budget": 0.001,
        "c_used_for_fund_target": 0.10,
        "n_runs": 1000,
        "n_positions": 200,
        "rng_seed": 20260527,
        "stress_scenario": "CorrelatedCrashConfig.severe",
        "notes": "test fixture",
    }


def _calibrated_params(rng_seed: int = 42) -> Params:
    result = calibrate_all(
        n_runs=80, n_positions=40,
        cfg=CorrelatedCrashConfig.moderate(),
        exposure_grid=np.array([20, 40, 80]),
        rng_seed=rng_seed,
    )
    return Params.from_calibration(
        result, rng_seed=rng_seed, stress_scenario="CorrelatedCrashConfig.moderate",
    )


# ─── construction from calibration ──────────────────────────────────────────


def test_from_calibration_produces_valid_params():
    p = _calibrated_params()
    assert p.schema_version == PARAMS_SCHEMA_VERSION
    assert 0 < p.c_min <= 1.0
    assert p.fund_target >= 0
    assert p.breakers.L0 > p.breakers.L1 > p.breakers.L2 >= p.breakers.L3
    assert p.exposure_caps.per_mm_cap <= p.exposure_caps.per_market_cap


def test_minimal_dict_validates():
    Params.model_validate(_minimal_valid_params_dict())


# ─── schema rejections ──────────────────────────────────────────────────────


def test_rejects_unknown_field():
    bad = _minimal_valid_params_dict()
    bad["surprise_field"] = "boom"
    with pytest.raises(ValidationError, match="surprise_field|forbid"):
        Params.model_validate(bad)


def test_rejects_c_min_out_of_range():
    bad = _minimal_valid_params_dict()
    bad["c_min"] = 1.5
    with pytest.raises(ValidationError):
        Params.model_validate(bad)
    bad["c_min"] = 0.0  # exclusive lower bound
    with pytest.raises(ValidationError):
        Params.model_validate(bad)


def test_rejects_schema_version_mismatch():
    bad = _minimal_valid_params_dict()
    bad["schema_version"] = "0.9.0"
    with pytest.raises(ValidationError, match="schema_version"):
        Params.model_validate(bad)


def test_rejects_breakers_out_of_order():
    bad = _minimal_valid_params_dict()
    bad["breakers"] = {"L0": 0.4, "L1": 0.7, "L2": 1.0, "L3": 0.0}  # reversed
    with pytest.raises(ValidationError, match="strictly_decreasing|L0 > L1"):
        Params.model_validate(bad)


def test_rejects_per_mm_cap_above_per_market():
    bad = _minimal_valid_params_dict()
    bad["exposure_caps"] = {
        "per_market_cap": 50, "per_mm_cap": 100, "n_mms_per_market": 5,
    }
    with pytest.raises(ValidationError, match="per_mm_cap"):
        Params.model_validate(bad)


def test_rejects_non_finite_c_min():
    bad = _minimal_valid_params_dict()
    bad["c_min"] = float("inf")
    with pytest.raises(ValidationError):
        Params.model_validate(bad)


def test_rejects_ruin_budget_out_of_range():
    bad = _minimal_valid_params_dict()
    bad["ruin_budget"] = 1.5
    with pytest.raises(ValidationError):
        Params.model_validate(bad)


def test_rejects_negative_withdrawal_delay():
    bad = _minimal_valid_params_dict()
    bad["withdrawal_delay_seconds"] = -1
    with pytest.raises(ValidationError):
        Params.model_validate(bad)


# ─── roundtrip ──────────────────────────────────────────────────────────────


def test_save_and_load_roundtrip(tmp_path: Path):
    p = _calibrated_params()
    out = tmp_path / "params.json"
    p.save(out)
    reloaded = Params.load(out)
    assert reloaded == p


def test_saved_file_is_json_native(tmp_path: Path):
    """Output must be plain JSON — no NaN/Inf, parseable by stdlib."""
    p = _calibrated_params()
    out = tmp_path / "params.json"
    p.save(out)
    parsed = json.loads(out.read_text(encoding="utf-8"))
    # All 8 top-level keys present
    expected_top_keys = {
        "c_min", "floor_curve", "fee_curve", "breakers",
        "withdrawal_delay_seconds", "exposure_caps",
        "first_loss_fraction", "fund_target",
    }
    assert expected_top_keys.issubset(parsed.keys())
    # Provenance present
    assert {"schema_version", "rng_seed", "stress_scenario"}.issubset(parsed.keys())


def test_load_rejects_corrupt_file(tmp_path: Path):
    out = tmp_path / "params.json"
    out.write_text("{ not valid json", encoding="utf-8")
    with pytest.raises(Exception):
        Params.load(out)


def test_repeated_save_byte_identical_except_timestamp(tmp_path: Path):
    """Two saves of the SAME in-memory Params produce identical bytes
    (deterministic serialiser)."""
    p = _calibrated_params(rng_seed=11)
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    p.save(a)
    p.save(b)
    assert a.read_bytes() == b.read_bytes()


# ─── emit_params end-to-end ─────────────────────────────────────────────────


def test_emit_params_writes_loadable_file(tmp_path: Path):
    out = tmp_path / "params.json"
    p = emit_params(out, n_runs=50, n_positions=30, rng_seed=7)
    assert out.exists()
    reloaded = Params.load(out)
    assert reloaded == p


# ─── checked-in params.json sanity (if present) ─────────────────────────────


def test_repo_params_json_loads_if_present():
    """If quant/params.json is checked in, it must load + validate against
    the current schema. CI uses this to flag stale params after schema bumps."""
    candidate = Path(__file__).resolve().parents[1] / "params.json"
    if not candidate.exists():
        pytest.skip("quant/params.json not yet generated")
    p = Params.load(candidate)
    assert p.schema_version == PARAMS_SCHEMA_VERSION
