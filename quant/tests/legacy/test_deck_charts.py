"""Smoke tests for inflexion_quant.deck_charts — Task 14.9."""

from __future__ import annotations

from pathlib import Path

import pytest

from inflexion_quant.legacy.deck_charts import (
    DECK_STYLE,
    DeckInputs,
    prepare_inputs,
    render_all,
    render_fund_pnl_distribution,
    render_ruin_probability_vs_c,
    render_tail_coverage,
)


# Use small MC sizes so the test stays under a couple of seconds
FAST_KW = dict(n_runs=80, n_positions=40, rng_seed=42)


@pytest.fixture(scope="module")
def fast_inputs() -> DeckInputs:
    """One calibration shared by all chart smoke tests."""
    return prepare_inputs(**FAST_KW)


def test_prepare_inputs_returns_sane_object(fast_inputs: DeckInputs):
    assert 0.0 < fast_inputs.c_min <= 1.0
    assert fast_inputs.fund_target >= 0.0
    assert fast_inputs.bootstrap_balance > 0.0
    assert fast_inputs.cache_severe.n_runs == FAST_KW["n_runs"]


def test_render_fund_pnl_distribution_writes_png(tmp_path: Path, fast_inputs: DeckInputs):
    import matplotlib.pyplot as plt
    plt.rcParams.update(DECK_STYLE)
    out = tmp_path / "fund_pnl.png"
    render_fund_pnl_distribution(fast_inputs, out)
    assert out.exists()
    assert out.stat().st_size > 10_000  # ≥ 10 KB sanity for a real plot


def test_render_ruin_probability_vs_c_writes_png(tmp_path: Path, fast_inputs: DeckInputs):
    import matplotlib.pyplot as plt
    plt.rcParams.update(DECK_STYLE)
    out = tmp_path / "ruin.png"
    render_ruin_probability_vs_c(fast_inputs, out)
    assert out.exists()
    assert out.stat().st_size > 10_000


def test_render_tail_coverage_writes_png(tmp_path: Path, fast_inputs: DeckInputs):
    import matplotlib.pyplot as plt
    plt.rcParams.update(DECK_STYLE)
    out = tmp_path / "tail.png"
    render_tail_coverage(fast_inputs, out)
    assert out.exists()
    assert out.stat().st_size > 10_000


def test_render_all_produces_three_charts(tmp_path: Path):
    paths = render_all(tmp_path, **FAST_KW)
    assert set(paths.keys()) == {
        "fund_pnl_distribution",
        "ruin_probability_vs_c",
        "tail_coverage",
    }
    for name, p in paths.items():
        assert p.exists(), f"{name} not written"
        assert p.suffix == ".png"
        assert p.stat().st_size > 10_000, f"{name} suspiciously small"


def test_render_all_creates_output_dir(tmp_path: Path):
    """render_all must mkdir -p the target."""
    nested = tmp_path / "deep" / "nest" / "quant"
    assert not nested.exists()
    render_all(nested, **FAST_KW)
    assert nested.is_dir()
    assert (nested / "fund_pnl_distribution.png").exists()
