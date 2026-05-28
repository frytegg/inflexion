"""Task 14.8 — versioned, schema-validated ``quant/params.json``.

Wraps a Task 14.7 :class:`CalibrationResult` in a pydantic v2 schema with
version + provenance metadata, serialises to disk, reloads and validates.
Phase 15 deploy (Solidity) reads from this file via ``vm.readFile`` — no
PARTIAL constant is ever hardcoded in contracts (CLAUDE.md invariant 6).

CLI::

    uv run python -m inflexion_quant.params --output params.json [--n-runs N] [--rng-seed S]

Schema versions follow semver. Bump major when a field is removed or
renamed (contracts must be redeployed); minor when a field is added (old
consumers must tolerate it); patch for clarifications or doc fixes.
"""

from __future__ import annotations

import argparse
import importlib.metadata as _md
import math
from datetime import UTC, datetime
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    NonNegativeFloat,
    PositiveInt,
    field_validator,
    model_validator,
)

from inflexion_quant.calibrate import CalibrationResult, calibrate_all


PARAMS_SCHEMA_VERSION = "2.0.0"


# ─── Sub-models ──────────────────────────────────────────────────────────────


class FloorCurve(BaseModel):
    """Per-vol-regime ``c_min`` curve. Currently single-σ (Phase 14.7);
    multi-σ fit deferred to Phase 15 calibration sweep."""

    model_config = ConfigDict(extra="forbid")

    c_at_baseline_vol: float = Field(..., gt=0.0, le=1.0)
    note: str


class FeeCurveParams(BaseModel):
    """Convex leverage tax ``fee(c) = fee_ref · (c_ref/c)^exponent``."""

    model_config = ConfigDict(extra="forbid")

    fee_ref_recommended: NonNegativeFloat
    fee_pct_at_c: NonNegativeFloat
    placeholder_fee_pct_at_c: NonNegativeFloat
    c_ref: float = Field(..., gt=0.0, le=1.0)
    exponent: float = Field(..., gt=0.0)
    mean_pnl_at_refit: float
    target_mean_pnl: float
    feasible_in_fee_search: bool


class BreakerLevels(BaseModel):
    """Health-ratio thresholds (fund equity / fund_target).

    Strictly decreasing: ``L0 > L1 > L2 > L3 ≥ 0``.
    """

    model_config = ConfigDict(extra="forbid")

    L0: float = Field(..., ge=0.0, le=1.0)
    L1: float = Field(..., ge=0.0, le=1.0)
    L2: float = Field(..., ge=0.0, le=1.0)
    L3: float = Field(..., ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _strictly_decreasing(self) -> "BreakerLevels":
        if not (self.L0 > self.L1 > self.L2 >= self.L3):
            raise ValueError(
                f"breakers must satisfy L0 > L1 > L2 ≥ L3; got "
                f"{self.L0}, {self.L1}, {self.L2}, {self.L3}"
            )
        return self


class ExposureCaps(BaseModel):
    """Per-market and per-MM book-size limits derived from the 14.6 spike sweep."""

    model_config = ConfigDict(extra="forbid")

    per_market_cap: int = Field(..., ge=0)
    per_mm_cap: int = Field(..., ge=0)
    n_mms_per_market: int = Field(..., ge=1)

    @model_validator(mode="after")
    def _per_mm_le_per_market(self) -> "ExposureCaps":
        if self.per_mm_cap > self.per_market_cap:
            raise ValueError(
                f"per_mm_cap ({self.per_mm_cap}) cannot exceed "
                f"per_market_cap ({self.per_market_cap})"
            )
        return self


# ─── Top-level Params ────────────────────────────────────────────────────────


class Params(BaseModel):
    """Versioned PARTIAL parameters — calibrated by 14.7, written by 14.8,
    consumed by Phase 15 deploy + matching engine."""

    model_config = ConfigDict(extra="forbid")

    schema_version: str
    quant_package_version: str
    created_at: str  # ISO 8601 UTC

    # The 8 calibrated PARTIAL parameters
    c_min: float = Field(..., gt=0.0, le=1.0)
    floor_curve: FloorCurve
    fee_curve: FeeCurveParams
    breakers: BreakerLevels
    withdrawal_delay_seconds: int = Field(..., gt=0)
    exposure_caps: ExposureCaps
    first_loss_fraction: float = Field(..., gt=0.0, le=1.0)
    fund_target: NonNegativeFloat

    # Provenance / sanity
    ruin_budget_per_horizon: float = Field(..., gt=0.0, lt=1.0)
    horizon_days: PositiveInt
    annualized_ruin_budget: float = Field(..., gt=0.0, lt=1.0)
    c_used_for_fund_target: float = Field(..., gt=0.0, le=1.0)
    fund_target_estimator: str  # "CVaR" or "VaR"
    n_runs: PositiveInt
    n_positions: PositiveInt
    rng_seed: int
    stress_scenario: str
    parameter_provenance: dict[str, str]  # per-field: calibrated / heuristic / deferred
    fixed_point_iterations: PositiveInt
    stability_check: dict[str, float] | None = None
    notes: str

    @field_validator("schema_version")
    @classmethod
    def _schema_version_matches(cls, v: str) -> str:
        if v != PARAMS_SCHEMA_VERSION:
            raise ValueError(
                f"schema_version mismatch: file says {v!r}, code expects "
                f"{PARAMS_SCHEMA_VERSION!r}. Either regenerate params.json with the "
                f"current calibrator, or pin the consumer to the older schema."
            )
        return v

    @field_validator("c_min", "fund_target", "first_loss_fraction")
    @classmethod
    def _finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError(f"value must be finite; got {v}")
        return v

    @classmethod
    def from_calibration(
        cls,
        result: CalibrationResult,
        *,
        rng_seed: int,
        stress_scenario: str,
    ) -> "Params":
        """Build a Params from a 14.7 CalibrationResult plus provenance."""
        exposure_dict = {
            k: v for k, v in result.exposure_caps.items() if k != "sweep"
        }
        return cls(
            schema_version=PARAMS_SCHEMA_VERSION,
            quant_package_version=_md.version("inflexion-quant"),
            created_at=datetime.now(UTC).isoformat(timespec="seconds"),
            c_min=result.c_min,
            floor_curve=FloorCurve(**result.floor_curve),
            fee_curve=FeeCurveParams(**result.fee_curve),
            breakers=BreakerLevels(**result.breakers),
            withdrawal_delay_seconds=result.withdrawal_delay_seconds,
            exposure_caps=ExposureCaps(**exposure_dict),
            first_loss_fraction=result.first_loss_fraction,
            fund_target=result.fund_target,
            ruin_budget_per_horizon=result.ruin_budget_per_horizon,
            horizon_days=result.horizon_days,
            annualized_ruin_budget=result.annualized_ruin_budget,
            c_used_for_fund_target=result.c_used_for_fund_target,
            fund_target_estimator=result.fund_target_estimator,
            n_runs=result.n_runs,
            n_positions=result.n_positions,
            rng_seed=rng_seed,
            stress_scenario=stress_scenario,
            parameter_provenance=result.parameter_provenance,
            fixed_point_iterations=result.fixed_point_iterations,
            stability_check=result.stability_check,
            notes=result.notes,
        )

    def save(self, path: Path | str) -> None:
        """Write deterministic JSON (pydantic preserves field order)."""
        Path(path).write_text(
            self.model_dump_json(indent=2) + "\n", encoding="utf-8"
        )

    @classmethod
    def load(cls, path: Path | str) -> "Params":
        """Load + validate; raises ``ValidationError`` on schema mismatch."""
        return cls.model_validate_json(Path(path).read_text(encoding="utf-8"))


# ─── Convenience emitter ────────────────────────────────────────────────────


def emit_params(
    output_path: Path | str,
    *,
    n_runs: int = 50_000,
    n_positions: int = 200,
    rng_seed: int = 20260527,
    stress_scenario: str = "CorrelatedCrashConfig.severe",
    run_stability_check: bool = True,
) -> Params:
    """Run :func:`calibrate_all` → wrap → save → return the in-memory model."""
    result = calibrate_all(
        n_runs=n_runs,
        n_positions=n_positions,
        rng_seed=rng_seed,
        run_stability_check=run_stability_check,
    )
    p = Params.from_calibration(
        result, rng_seed=rng_seed, stress_scenario=stress_scenario
    )
    p.save(output_path)
    return p


# ─── CLI ────────────────────────────────────────────────────────────────────


def _main() -> None:
    parser = argparse.ArgumentParser(
        description="Calibrate PARTIAL parameters and emit a versioned params.json."
    )
    parser.add_argument(
        "--output", type=Path, default=Path("params.json"),
        help="output path (default: ./params.json)",
    )
    parser.add_argument("--n-runs", type=int, default=50_000)
    parser.add_argument("--n-positions", type=int, default=200)
    parser.add_argument("--rng-seed", type=int, default=20260527)
    parser.add_argument("--no-stability-check", action="store_true",
                        help="Skip the cross-seed stability check (faster).")
    args = parser.parse_args()

    p = emit_params(
        args.output,
        n_runs=args.n_runs,
        n_positions=args.n_positions,
        rng_seed=args.rng_seed,
        run_stability_check=not args.no_stability_check,
    )
    print(f"Wrote {args.output}")
    print(f"  schema_version:   {p.schema_version}")
    print(f"  c_min:            {p.c_min * 100:.2f}%")
    print(f"  fund_target:      ${p.fund_target:,.0f}  ({p.fund_target_estimator})")
    print(f"  per_market_cap:   {p.exposure_caps.per_market_cap} swaps")
    print(f"  per_mm_cap:       {p.exposure_caps.per_mm_cap} swaps")
    print(f"  ruin (per {p.horizon_days}d):   {p.ruin_budget_per_horizon * 100:.2f}%")
    print(f"  ruin (annualized): {p.annualized_ruin_budget * 100:.2f}%")
    print(f"  fixed-point iterations: {p.fixed_point_iterations}")
    if p.stability_check:
        sc = p.stability_check
        print(f"  cross-seed c_min spread: {sc['c_min_spread_bp']:.0f} bp "
              f"(min={sc['c_min_min'] * 100:.2f}%, max={sc['c_min_max'] * 100:.2f}%)")
        print(f"  cross-seed fund_target spread: {sc['fund_target_spread_pct']:.1f}% "
              f"(min=${sc['fund_target_min']:,.0f}, max=${sc['fund_target_max']:,.0f})")


if __name__ == "__main__":
    _main()
