"""Property tests for IL formulas (Task 14.4).

These pin the math down so future refactors can't silently break the IL
calculation — every subsequent quant notebook depends on this being correct.
"""

import numpy as np
import pytest

from inflexion_quant.il import (
    compute_il,
    compute_max_il,
    compute_payout,
    entry_amounts,
    lp_value,
    position_V0,
)


# ─── Basic correctness ────────────────────────────────────────────────────────


def test_entry_amounts_rejects_out_of_range():
    with pytest.raises(ValueError):
        entry_amounts(P0=100.0, Pa=110.0, Pb=120.0, L=1000.0)  # P0 below Pa
    with pytest.raises(ValueError):
        entry_amounts(P0=130.0, Pa=110.0, Pb=120.0, L=1000.0)  # P0 above Pb


def test_il_at_entry_is_zero():
    """At ``P_T == P0`` we have ``V_hold == V_lp`` ⇒ IL = 0."""
    P0, Pa, Pb, L = 3000.0, 2700.0, 3300.0, 1_000_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    il = float(compute_il(P0, Pa, Pb, L, a0, a1))
    assert abs(il) < 1e-6 * P0


def test_il_is_non_negative_everywhere():
    """Invariant **I3**: compute_il is never negative — across the *full* domain."""
    P0, Pa, Pb, L = 3000.0, 2700.0, 3300.0, 1_000_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    P_T = np.linspace(100.0, 30_000.0, 1_000)  # far below to far above range
    il = compute_il(P_T, Pa, Pb, L, a0, a1)
    assert (il >= 0).all()


def test_lp_value_continuous_at_both_boundaries():
    """V_lp must be continuous across Pa and Pb (no regime-jump)."""
    Pa, Pb, L = 2700.0, 3300.0, 1_000_000.0
    eps = 1e-6
    # At Pa
    just_below = float(lp_value(Pa - eps, Pa, Pb, L))
    just_above = float(lp_value(Pa + eps, Pa, Pb, L))
    assert abs(just_above - just_below) < 1.0  # token1 units; jump should be ~0
    # At Pb
    just_below = float(lp_value(Pb - eps, Pa, Pb, L))
    just_above = float(lp_value(Pb + eps, Pa, Pb, L))
    assert abs(just_above - just_below) < 1.0


def test_max_il_equals_max_of_boundary_ils():
    """MaxIL definition: ``max(IL(Pa), IL(Pb))`` — by spec §3.2."""
    P0, Pa, Pb, L = 3000.0, 2400.0, 3600.0, 500_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    il_pa = float(compute_il(np.array([Pa]), Pa, Pb, L, a0, a1)[0])
    il_pb = float(compute_il(np.array([Pb]), Pa, Pb, L, a0, a1)[0])
    max_il = compute_max_il(P0, Pa, Pb, L)
    assert abs(max_il - max(il_pa, il_pb)) < 1e-9


def test_il_convex_within_range():
    """IL(P) is convex on ``[Pa, Pb]`` (spec §3.2). Second-difference ≥ 0."""
    P0, Pa, Pb, L = 3000.0, 2400.0, 3600.0, 500_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    ps = np.linspace(Pa, Pb, 21)
    ils = compute_il(ps, Pa, Pb, L, a0, a1)
    second_diff = np.diff(ils, 2)
    # Allow tiny negative noise; convex within ~1e-3 (token1 units)
    assert (second_diff >= -1e-3).all(), f"non-convex: {second_diff.min():.3e}"


def test_interior_il_never_exceeds_boundary_max():
    """Sweep interior with fine grid; no point above MaxIL (validates the
    convexity ⇒ boundary-max claim from spec §3.2 via fuzz)."""
    P0, Pa, Pb, L = 3000.0, 2500.0, 3700.0, 800_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    max_il = compute_max_il(P0, Pa, Pb, L)
    P_grid = np.linspace(Pa, Pb, 500)
    il_grid = compute_il(P_grid, Pa, Pb, L, a0, a1)
    assert il_grid.max() <= max_il + 1e-6


# ─── Payout cap (invariants I1 + I2) ──────────────────────────────────────────


def test_payout_never_exceeds_max_il_anywhere():
    """The cap that makes FULL bad-debt-free: ``payout = min(IL, MaxIL)``."""
    P0, Pa, Pb, L = 3000.0, 2700.0, 3300.0, 1_000_000.0
    max_il = compute_max_il(P0, Pa, Pb, L)
    # Sweep far outside the range where raw IL grows past MaxIL
    P_T = np.linspace(10.0, 100_000.0, 2_000)
    payout = compute_payout(P_T, P0, Pa, Pb, L)
    assert (payout <= max_il + 1e-9).all()
    # And: well above Pb the *raw* IL exceeds MaxIL (cap actually bites)
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    raw_il_far = float(compute_il(np.array([100_000.0]), Pa, Pb, L, a0, a1)[0])
    assert raw_il_far > max_il  # without cap, would be unbounded


def test_payout_zero_when_lp_outperforms():
    """Invariant **I4**: ``V_lp ≥ V_hold ⇒ payout == 0``."""
    P0, Pa, Pb, L = 3000.0, 2700.0, 3300.0, 1_000_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    # Find a P_T where V_lp ≥ V_hold — at entry (P_T = P0) they are equal,
    # so a tiny neighbourhood must have payout ≈ 0
    payout = compute_payout(P0, P0, Pa, Pb, L)
    assert float(payout) < 1e-6 * P0


# ─── Reference magnitudes (regenerates spec §3.2 placeholder table) ──────────


def test_max_il_monotonic_in_range_width():
    """Wider range ⇒ larger MaxIL/V0."""
    P0, L = 1_000_000.0, 1_000_000.0
    ratios = []
    for hw in [0.05, 0.10, 0.20, 0.50, 1.0]:
        Pa = P0 / (1 + hw)
        Pb = P0 * (1 + hw)
        V0 = position_V0(P0, Pa, Pb, L)
        ratios.append(compute_max_il(P0, Pa, Pb, L) / V0)
    diffs = np.diff(ratios)
    assert (diffs > 0).all(), f"non-monotonic: {ratios}"


@pytest.mark.parametrize(
    "hw,min_pct,max_pct",
    [
        (0.05, 0.5, 2.0),    # ±5%  range → MaxIL/V0 ≈ 1.2%
        (0.10, 2.0, 5.0),    # ±10%               ≈ 2.4%
        (0.20, 5.0, 12.0),   # ±20%               ≈ 4.7%
        (0.50, 10.0, 20.0),  # ±50%               ≈ 13.8%
    ],
)
def test_max_il_in_expected_band(hw, min_pct, max_pct):
    """MaxIL/V0 for centred ±hw ranges falls in a sensible band.

    Bands are loose — purpose is to assert *order of magnitude* correctness,
    not to enforce a tight fit. The notebook reports the precise table.
    The spec.md §3.2 "reference magnitudes" were placeholders; these tests
    document the true values.
    """
    P0, L = 1_000_000.0, 1_000_000.0
    Pa = P0 / (1 + hw)
    Pb = P0 * (1 + hw)
    V0 = position_V0(P0, Pa, Pb, L)
    pct = 100 * compute_max_il(P0, Pa, Pb, L) / V0
    assert min_pct < pct < max_pct, (
        f"hw=±{hw * 100:.0f}% MaxIL/V0={pct:.2f}% (expected {min_pct}-{max_pct}%)"
    )


# ─── Asymmetric (off-centred) positions ───────────────────────────────────────


def test_asymmetric_position_max_il_at_correct_boundary():
    """An off-centre position has larger IL at the *farther* boundary."""
    P0 = 3000.0
    # P0 is near Pb — most of the convex room is on the down side
    Pa = 2000.0
    Pb = 3100.0
    L = 1_000_000.0
    a0, a1 = entry_amounts(P0, Pa, Pb, L)
    il_pa = float(compute_il(np.array([Pa]), Pa, Pb, L, a0, a1)[0])
    il_pb = float(compute_il(np.array([Pb]), Pa, Pb, L, a0, a1)[0])
    # Down side is farther → IL(Pa) should dominate
    assert il_pa > il_pb
