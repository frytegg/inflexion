"""Smoke tests for inflexion_quant.cvamm_charts — render all three at small MC size."""

from __future__ import annotations

from pathlib import Path

from inflexion_quant.cvamm_charts import render_all


def test_render_all_writes_three_charts(tmp_path: Path):
    paths = render_all(tmp_path, fast=True)
    assert set(paths) == {"fairpremium_scurve", "overcharge_gap", "depositor_loss_distribution"}
    for p in paths.values():
        assert p.exists() and p.stat().st_size > 1000
