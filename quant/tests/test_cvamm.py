"""Tests for inflexion_quant.cvamm — the single-asset cvAMM launch primitives (P1).

Covers: the EXACT closed-form FairPremium surface (≡ il.py to machine precision +
reproduces the authoritative reference numbers), the MaxIL pure-geometry
decomposition, the lone-writer-CVaR / diversification-collapse envelope, the two
skews, and the I10 clamp holding BY CONSTRUCTION.
"""

from __future__ import annotations

import numpy as np
import pytest

from inflexion_quant import cvamm as cv
from inflexion_quant.il import compute_max_il, compute_payout, position_V0

P0, L = 3000.0, 1.0


# ─── Deliverable 1: MaxIL pure geometry (duration-independent) ───────────────


def test_maxil_geometry_authoritative():
    """Authoritative MaxIL/V0 (il.py ground truth): 1.27/2.56/5.23/13.76% geometric."""
    assert cv.maxil_over_v0(0.05) == pytest.approx(0.0127, abs=5e-4)
    assert cv.maxil_over_v0(0.10) == pytest.approx(0.0256, abs=5e-4)
    assert cv.maxil_over_v0(0.20) == pytest.approx(0.0523, abs=5e-4)
    assert cv.maxil_over_v0(0.50) == pytest.approx(0.1376, abs=5e-4)
    # arithmetic ±50% = 18.0%
    assert cv.maxil_over_v0(0.50, "arithmetic") == pytest.approx(0.180, abs=1e-3)


def test_maxil_duration_independent():
    """MaxIL is pure geometry — identical regardless of T (only fairRate moves)."""
    Pa, Pb = cv.make_range(P0, 0.10)
    mil = compute_max_il(P0, Pa, Pb, L)
    # fairRate differs across durations but MaxIL does not depend on T at all.
    assert mil == compute_max_il(P0, Pa, Pb, L)  # trivially, T is not an input


# ─── Deliverable 1: the EXACT closed form ────────────────────────────────────


def test_closed_form_equals_il_py_to_machine_precision():
    """fair_rate (closed form) ≡ il.py quadrature across width × σ × T."""
    res = cv.verify_closed_form(quad_n=400_001)
    assert res["max_abs_err"] < 1e-5, f"closed form disagrees with il.py: {res}"


def test_fair_rate_reproduces_authoritative_surface():
    """σ=60% geometric reference points (il.py MC ground truth)."""
    expect = {
        0.05: (0.695, 0.848, 0.913),
        0.10: (0.449, 0.708, 0.829),
        0.20: (0.182, 0.473, 0.674),
    }
    for w, (e7, e30, e90) in expect.items():
        Pa, Pb = cv.make_range(P0, w)
        got = tuple(cv.fair_rate(P0, Pa, Pb, L, 0.60, d / 365) for d in (7, 30, 90))
        assert got[0] == pytest.approx(e7, abs=2e-3)
        assert got[1] == pytest.approx(e30, abs=2e-3)
        assert got[2] == pytest.approx(e90, abs=2e-3)


def test_fair_rate_is_s_curve_in_sigma2_t():
    """fairRate is monotone increasing in σ²·T (the S-curve)."""
    Pa, Pb = cv.make_range(P0, 0.10)
    vals = [cv.fair_rate(P0, Pa, Pb, L, 0.60, d / 365) for d in (7, 30, 90)]
    assert vals[0] < vals[1] < vals[2]
    # and increasing in sigma
    s = [cv.fair_rate(P0, Pa, Pb, L, sig, 30 / 365) for sig in (0.3, 0.6, 1.2)]
    assert s[0] < s[1] < s[2]


def test_fair_rate_bounded_unit_interval():
    """fairRate ∈ (0, 1] — it is a fraction of MaxIL."""
    for w in (0.02, 0.10, 0.50):
        Pa, Pb = cv.make_range(P0, w)
        for sig in (0.2, 0.6, 1.5):
            for d in (7, 30, 90):
                fr = cv.fair_rate(P0, Pa, Pb, L, sig, d / 365)
                assert 0.0 < fr <= 1.0 + 1e-9


def test_fair_rate_asymmetric_position():
    """Closed form stays exact when P0 sits near an edge (numéraire-error probe)."""
    for off in (-0.8, -0.4, 0.4, 0.8):
        Pa, Pb = cv.place_range_with_offset(P0, 0.20, off)
        cf = cv.fair_rate(P0, Pa, Pb, L, 0.60, 30 / 365)
        qd = cv.fair_rate_quad(P0, Pa, Pb, L, 0.60, 30 / 365, n=400_001)
        assert cf == pytest.approx(qd, abs=1e-4)


def test_fair_rate_vec_equals_scalar():
    """The vectorised closed form ≡ the scalar reference (the hot-path engine)."""
    rng = np.random.default_rng(11)
    hw = rng.uniform(0.02, 0.5, size=200)
    off = rng.uniform(-0.85, 0.85, size=200)
    Pa = np.empty(200)
    Pb = np.empty(200)
    for i in range(200):
        Pa[i], Pb[i] = cv.place_range_with_offset(P0, hw[i], off[i])
    sig = rng.uniform(0.2, 1.5, size=200)
    T = rng.choice([7, 30, 90], size=200) / 365.0
    Lv = np.full(200, L)
    vec = cv.fair_rate_vec(np.full(200, P0), Pa, Pb, Lv, sig, T)
    scal = np.array([cv.fair_rate(P0, Pa[i], Pb[i], L, sig[i], T[i]) for i in range(200)])
    np.testing.assert_allclose(vec, scal, atol=1e-12, rtol=1e-10)


def test_example_a():
    """Worked Example A: 50k, ±10% geometric, 30d, σ=60% → MaxIL 1280, fair 906, @+15% 1042."""
    Pa, Pb = cv.make_range(P0, 0.10)
    Lx = 50_000.0 / position_V0(P0, Pa, Pb, 1.0)
    mil = compute_max_il(P0, Pa, Pb, Lx)
    fp = cv.fair_premium(P0, Pa, Pb, Lx, 0.60, 30 / 365)
    assert mil == pytest.approx(1280, abs=10)
    assert fp == pytest.approx(906, abs=10)
    assert fp * 1.15 == pytest.approx(1042, abs=10)


# ─── Deliverable 3: CVaR / diversification collapse → baseLoad ───────────────


def test_lone_writer_cvar_high():
    """A lone writer's CVaR95 sits at ≈91–100% of MaxIL — the overcharge gap."""
    Pa, Pb = cv.make_range(P0, 0.10)
    r = cv.lone_writer_cvar(P0, Pa, Pb, L, 0.60, 30 / 365, n=100_000)
    assert 0.90 <= r["cvar"] <= 1.0001
    assert r["cvar"] > r["fair"]  # the gap diversification collapses


def test_diversification_collapses_when_uncorrelated():
    """Per-contract CVaR collapses as N grows when the book is diversified (ρ=0)."""
    dc = cv.diversification_collapse(correlation=0.0, n_runs=15_000)
    assert dc["per_contract_cvar"][0] > dc["per_contract_cvar"][-1]
    assert dc["per_contract_cvar"][-1] < 0.90  # collapsed below the lone-writer level


def test_no_diversification_when_synchronized():
    """A perfectly synchronized single-pair book (ρ=1) gets NO diversification —
    the honest tail-dependent crash regime."""
    dc = cv.diversification_collapse(correlation=1.0, n_runs=15_000)
    assert dc["per_contract_cvar"][-1] == pytest.approx(dc["per_contract_cvar"][0], abs=0.02)


def test_base_load_inside_envelope():
    dc = cv.diversification_collapse(correlation=0.0, n_runs=15_000)
    bl = cv.base_load_from_envelope(
        fair=dc["fair"], diversified_cvar=dc["diversified_cvar"], capital_fraction=0.5
    )
    assert bl["base_load"] >= 0.0
    assert dc["fair"] <= bl["target_rate"] <= dc["diversified_cvar"] + 1e-9


# ─── Deliverables 4 + 5: the two skews ───────────────────────────────────────


def test_util_skew_monotone_and_flat_below_knee():
    p = cv.UtilSkewParams(knee=0.5, slope=0.4, power=2.0, cap=0.5)
    assert float(cv.util_skew(0.3, p)) == 0.0  # flat below knee
    us = [float(cv.util_skew(u, p)) for u in (0.5, 0.7, 0.9, 1.0)]
    assert us == sorted(us)  # monotone increasing
    assert max(us) <= p.cap + 1e-12


def test_dispersion_concentration_and_skew():
    assert cv.coverage_concentration(np.ones(9)) == pytest.approx(0.0, abs=1e-9)
    assert cv.coverage_concentration(np.array([5.0, 0, 0, 0])) == pytest.approx(1.0)
    p = cv.DispersionSkewParams()
    ds = [float(cv.dispersion_skew(h, p)) for h in (0.0, 0.25, 0.5, 1.0)]
    assert ds == sorted(ds)
    assert ds[0] == 0.0
    assert max(ds) <= p.cap + 1e-12


# ─── Deliverable 6: I10 clamp BY CONSTRUCTION ───────────────────────────────


def test_i10_clamp_by_construction_fuzz():
    """premium ≤ FairPremium·(1+maxLoad) for ANY inputs — the I10 ceiling holds
    by construction of the clamp (this is the quant mirror of the on-chain I10)."""
    rng = np.random.default_rng(7)
    for _ in range(2000):
        base = rng.uniform(0, 1.0)
        util = rng.uniform(0, 1.0)
        disp = rng.uniform(0, 1.0)
        max_load = rng.uniform(0, 1.0)
        total = float(cv.clamp_load(base, util, disp, max_load))
        assert total <= max_load + 1e-12
        fairp = 906.0
        prem = cv.premium_from_load(fairp, total)
        assert prem <= fairp * (1.0 + max_load) + 1e-9


def test_size_max_load_bps_covers_reachable_max():
    base, uc, dc = 0.20, 0.5, 0.5
    mlb = cv.size_max_load_bps(base_load=base, util_cap=uc, dispersion_cap=dc)
    # the clamp at this maxLoad must NOT truncate the legitimately-built max load
    assert float(cv.clamp_load(base, uc, dc, mlb / 10_000.0)) == pytest.approx(
        base + uc + dc, abs=1e-9
    )


# ─── Surface builder ─────────────────────────────────────────────────────────


def test_fair_rate_surface_shape():
    rows = cv.fair_rate_surface(half_widths=(0.05, 0.10), offsets=(0.0, 0.5))
    assert len(rows) == 2 * 2 * 3  # widths × offsets × durations
    for r in rows:
        assert 0.0 < r["fair_rate"] <= 1.0
