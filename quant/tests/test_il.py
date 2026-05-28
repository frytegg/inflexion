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


# ─── Hand-calculated fixture (audit C1: external correctness vs Uniswap v3 §6.30) ────


# Fixture position: P0=100, Pa=80, Pb=125, L=1000.
#
# All reference values below were computed by an INDEPENDENT script using
# only Python's stdlib math (sqrt) — no inflexion_quant code — applying
# Uniswap v3 whitepaper §6.30 formulas directly:
#
#   sqrt_Pa = math.sqrt(80)   = 8.944271909999159
#   sqrt_Pb = math.sqrt(125)  = 11.180339887498949
#   sqrt_P0 = math.sqrt(100)  = 10.0
#   amount0 = L * (1/sqrt_P0 - 1/sqrt_Pb)
#   amount1 = L * (sqrt_P0 - sqrt_Pa)
#   V0      = amount0·P0 + amount1
#   V_lp(P_T)   per regime (in-range / below Pa / above Pb)
#   V_hold(P_T) = amount0·P_T + amount1
#   IL(P_T)     = max(0, V_hold - V_lp)
#
# These tests catch sign errors, formula swaps, regime-boundary bugs, or
# other domain bugs that the internal-consistency tests (vectorised matches
# loop) would silently pass through. Audit findings C1 + C2.


FIXTURE_P0 = 100.0
FIXTURE_PA = 80.0
FIXTURE_PB = 125.0
FIXTURE_L = 1000.0
FIXTURE_A0 = 10.557280900008417
FIXTURE_A1 = 1055.728090000841
FIXTURE_V0 = 2111.4561800016827


def test_fixture_entry_amounts_match_whitepaper():
    a0, a1 = entry_amounts(FIXTURE_P0, FIXTURE_PA, FIXTURE_PB, FIXTURE_L)
    assert a0 == pytest.approx(FIXTURE_A0, abs=1e-9)
    assert a1 == pytest.approx(FIXTURE_A1, abs=1e-9)


def test_fixture_V0_matches_whitepaper():
    v0 = position_V0(FIXTURE_P0, FIXTURE_PA, FIXTURE_PB, FIXTURE_L)
    assert v0 == pytest.approx(FIXTURE_V0, abs=1e-9)


def test_fixture_il_at_Pa():
    # IL at lower boundary, in-range formula at P=Pa:
    #   V_lp(Pa) = L * (2√Pa - Pa/√Pb - √Pa)
    #   IL(Pa)   = 111.45618000168088
    il_pa = float(
        compute_il(np.array([FIXTURE_PA]), FIXTURE_PA, FIXTURE_PB, FIXTURE_L,
                   FIXTURE_A0, FIXTURE_A1)[0]
    )
    assert il_pa == pytest.approx(111.45618000168088, abs=1e-9)


def test_fixture_il_at_Pb_equals_max_il():
    # IL at upper boundary — dominates here (P0 is asymmetric, Pb is 25% up
    # vs Pa is 20% down; the wider half wins → MaxIL is at Pb):
    #   IL(Pb) = 139.32022500210132
    il_pb = float(
        compute_il(np.array([FIXTURE_PB]), FIXTURE_PA, FIXTURE_PB, FIXTURE_L,
                   FIXTURE_A0, FIXTURE_A1)[0]
    )
    assert il_pb == pytest.approx(139.32022500210132, abs=1e-9)
    max_il = compute_max_il(FIXTURE_P0, FIXTURE_PA, FIXTURE_PB, FIXTURE_L)
    assert max_il == pytest.approx(139.32022500210132, abs=1e-9)


def test_fixture_il_interior_no_cap():
    # P_T = 110 (10% up, still well inside the range); IL < MaxIL → no cap:
    #   IL(110) = 23.823036596968905
    payout = float(
        compute_payout(np.array([110.0]), FIXTURE_P0, FIXTURE_PA, FIXTURE_PB,
                       FIXTURE_L)[0]
    )
    assert payout == pytest.approx(23.823036596968905, abs=1e-9)


def test_fixture_payout_capped_below_Pa():
    # P_T = 60 < Pa = 80; BELOW-range formula → V_lp = L·(1/√Pa - 1/√Pb)·P_T:
    #   raw IL(60) = 347.52415750147225  (uncapped)
    #   MaxIL      = 139.32022500210132
    # Payout MUST be capped at MaxIL. This exercises the cap AND the
    # below-range regime branch in lp_value.
    payout = float(
        compute_payout(np.array([60.0]), FIXTURE_P0, FIXTURE_PA, FIXTURE_PB,
                       FIXTURE_L)[0]
    )
    assert payout == pytest.approx(139.32022500210132, abs=1e-9)


def test_fixture_payout_capped_above_Pb():
    # P_T = 150 > Pb = 125; ABOVE-range → V_lp = L·(√Pb - √Pa) (constant):
    #   raw IL(150) = 403.25224750231337  (uncapped)
    #   MaxIL       = 139.32022500210132
    # Exercises the cap AND the above-range regime branch.
    payout = float(
        compute_payout(np.array([150.0]), FIXTURE_P0, FIXTURE_PA, FIXTURE_PB,
                       FIXTURE_L)[0]
    )
    assert payout == pytest.approx(139.32022500210132, abs=1e-9)


# ─── Boundary-max proof (audit C2) ────────────────────────────────────────────


def test_max_il_at_boundary_holds_across_finely_sampled_interior():
    """Proof sketch: IL(P) = V_hold(P) - V_lp(P). V_hold is linear in P
    (a0·P + a1); V_lp is concave in P on [Pa, Pb] (sum of √P terms). So
    IL is convex on the interval, and a convex function on a closed
    interval attains its max at a boundary.

    This test discretises the interval and verifies the claim empirically
    for several geometries. Combined with the convexity argument, it
    rules out an interior maximum to numerical precision.
    """
    np.random.seed(20260527)
    for _ in range(8):
        P0 = float(np.random.uniform(50, 5000))
        hw = float(np.random.uniform(0.05, 0.50))  # ±5% to ±50% half-width
        Pa = P0 * (1 - hw)
        Pb = P0 * (1 + hw)
        L = 1000.0
        a0, a1 = entry_amounts(P0, Pa, Pb, L)
        max_il_boundary = compute_max_il(P0, Pa, Pb, L)
        interior_grid = np.linspace(Pa, Pb, 500)
        il_interior = compute_il(interior_grid, Pa, Pb, L, a0, a1)
        # Allow 1e-9 absolute slack for floating-point at the boundary
        assert il_interior.max() <= max_il_boundary + 1e-9, (
            f"Interior IL exceeded boundary max for P0={P0}, hw={hw}"
        )
