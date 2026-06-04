"""Single-asset cvAMM calibration engine (P1) — the launch pricing primitives.

Promoted from the verified scratch sim (``_scratch_fairvalue_closedform_check.py``),
wired to the repo's own ``il.py`` as the single source of truth. Produces the cvAMM-block deliverables that the
on-chain ``FairValueOracle`` + ``ConvexityVault`` read from ``params.json`` —
**no pricing primitive is hardcoded** (CLAUDE.md invariant 6 / the audit failure).

What lives here (cf. ``quant/SPEC.md`` deliverables 1, 3, 4, 5, 6):

- **Deliverable 1 — FairPremium surface.** :func:`fair_rate` is the EXACT closed
  form ``fairRate = E_Q[min(IL, MaxIL)] / MaxIL`` under risk-neutral GBM
  (``μ = 0, r = 0``) — a finite ``Φ``-sum over the piecewise v3 payoff, **no
  fitted coefficients**, the only stochastic input is ``σ_ref``. Verified ≡
  ``il.py`` (quadrature ≡ MC) to ~5e-11 (:func:`verify_closed_form`).
- **Deliverable 3 — baseLoad.** :func:`lone_writer_cvar` +
  :func:`diversification_collapse` reproduce the lone-writer-CVaR
  (≈91–100% MaxIL) vs diversified-pool envelope; :func:`base_load_from_envelope`
  sizes ``baseLoad`` inside it.
- **Deliverables 4 + 5 — the two skews.** :func:`util_skew` (on
  ``locked/(locked+free)``) and :func:`dispersion_skew` (on a Herfindahl
  concentration of outstanding coverage across width × moneyness × duration),
  both **single-asset calibrated** (no dead cross-asset ``k ≈ 1.0``).
- **Deliverable 6 — maxLoadBps (I10).** :func:`clamp_load` enforces
  ``premium ≤ FairPremium·(1 + maxLoad)`` BY CONSTRUCTION (the sum of loads is
  clamped to ``maxLoad``); :func:`size_max_load_bps` sizes the cap.

``MaxIL`` itself is pure geometry, frozen at creation, identical across
durations — computed on-chain by ``ILMath`` and here by ``il.compute_max_il``;
it is never stored as a calibrated number.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.random import Generator
from scipy.stats import norm

from inflexion_quant.il import compute_max_il, compute_payout, position_V0

# ─── The 9-marketId launch grid ──────────────────────────────────────────────
#
# ONE pool, ETH/USDC, 3 fee tiers × 3 durations. The fee tier does not enter the
# pricing math (geometry does); it selects the typical tick-spacing / width band
# an LP in that tier tends to use, which the calibration sweep spans explicitly.

PAIR = "ETH/USDC"
FEE_TIERS_BPS: tuple[int, ...] = (500, 3000, 10000)
DURATIONS_DAYS: tuple[int, ...] = (7, 30, 90)
N_MARKETS = len(FEE_TIERS_BPS) * len(DURATIONS_DAYS)

DAYS_PER_YEAR = 365.0


# ─── Geometry helpers ────────────────────────────────────────────────────────


def make_range(P0: float, half_width: float, centering: str = "geometric") -> tuple[float, float]:
    """A ±``half_width`` range around ``P0``.

    ``geometric``  → ``Pa = P0/(1+w), Pb = P0·(1+w)``  (log-symmetric; v3-native).
    ``arithmetic`` → ``Pa = P0·(1−w), Pb = P0·(1+w)``.

    The on-chain pricer takes the position's *actual* tick-derived ``(Pa, Pb)`` —
    so the ±width convention is a reference-table convention only, never a
    pricing input (``quant/SPEC.md`` deliverable 1).
    """
    if centering == "geometric":
        return P0 / (1 + half_width), P0 * (1 + half_width)
    if centering == "arithmetic":
        return P0 * (1 - half_width), P0 * (1 + half_width)
    raise ValueError(f"unknown centering {centering!r}")


def place_range_with_offset(
    P0: float, half_width: float, offset_fraction: float
) -> tuple[float, float]:
    """Place a log-width-``w`` range with ``P0`` offset toward an edge.

    ``offset_fraction`` ∈ ``[-1, 1]``: 0 = centered (geometric), +1 = P0 at the
    lower edge ``Pa`` (all distance-to-edge above), −1 = P0 at ``Pb``. Mirrors
    :func:`positions.sample_positions`'s log-space placement so distance-to-edge
    (deliverable 1's third axis) is exercised consistently.
    """
    w_log = np.log1p(half_width)
    delta = offset_fraction * w_log
    Pa = P0 * np.exp(-(w_log - delta))
    Pb = P0 * np.exp(w_log + delta)
    return float(Pa), float(Pb)


def maxil_over_v0(
    half_width: float, centering: str = "geometric", P0: float = 3000.0, L: float = 1.0
) -> float:
    """MaxIL as a fraction of V0 — pure geometry, no vol/time."""
    Pa, Pb = make_range(P0, half_width, centering)
    return compute_max_il(P0, Pa, Pb, L) / position_V0(P0, Pa, Pb, L)


# ─── Vectorised per-swap kernel (extracted from calibrate.py) ────────────────


def batch_payouts_and_maxils(
    P0: np.ndarray,
    Pa: np.ndarray,
    Pb: np.ndarray,
    L: np.ndarray,
    P_T: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-swap ``(payout, max_il)`` over arrays of params + terminals.

    Equivalent to looping :func:`il.compute_payout` / :func:`il.compute_max_il`
    but ~50× faster (stays in numpy across the batch). Extracted from
    ``calibrate._vectorised_payouts_and_maxils`` (``quant/SPEC.md`` deliverable
    1 / ROADMAP P1.4) so the cvAMM surface engine does not import the legacy
    PARTIAL stack. All inputs broadcast to a common shape.
    """
    sqrt_P0 = np.sqrt(P0)
    sqrt_Pa = np.sqrt(Pa)
    sqrt_Pb = np.sqrt(Pb)

    a0 = L * (1.0 / sqrt_P0 - 1.0 / sqrt_Pb)
    a1 = L * (sqrt_P0 - sqrt_Pa)

    # MaxIL = max(IL(Pa), IL(Pb)) — boundary evaluation of the in-range formula.
    V_hold_pa = a0 * Pa + a1
    V_lp_pa = L * (2 * sqrt_Pa - Pa / sqrt_Pb - sqrt_Pa)
    IL_pa = np.maximum(0.0, V_hold_pa - V_lp_pa)
    V_hold_pb = a0 * Pb + a1
    V_lp_pb = L * (2 * sqrt_Pb - Pb / sqrt_Pb - sqrt_Pa)
    IL_pb = np.maximum(0.0, V_hold_pb - V_lp_pb)
    max_il = np.maximum(IL_pa, IL_pb)

    sqrt_PT = np.sqrt(np.maximum(P_T, 0.0))
    V_hold = a0 * P_T + a1
    V_lp_inrange = L * (2 * sqrt_PT - P_T / sqrt_Pb - sqrt_Pa)
    V_lp_below = L * (1.0 / sqrt_Pa - 1.0 / sqrt_Pb) * P_T
    V_lp_above = L * (sqrt_Pb - sqrt_Pa)
    V_lp = np.where(P_T < Pa, V_lp_below, np.where(P_T > Pb, V_lp_above, V_lp_inrange))
    IL = np.maximum(0.0, V_hold - V_lp)
    payout = np.minimum(IL, max_il)
    # Defense-in-depth: a degenerate range (Pa==Pb ⇒ MaxIL==0) would yield a 0/0
    # payout fraction downstream; pin payout to 0 there (no coverage, no nan).
    payout = np.where(max_il > 0.0, payout, 0.0)
    return payout, max_il


# ─── Deliverable 1: FairPremium — the EXACT closed form ──────────────────────


def _interval_moment(p: float, K1: float, K2: float, P0: float, sigma: float, T: float) -> float:
    """``E[ P_T^p · 1{K1 < P_T < K2} ]`` under GBM with ``r = 0`` (forward = P0).

    A standard lognormal interval moment: ``P_T = P0·exp(−½σ²T + σ√T·Z)``, so

        E[P_T^p · 1{K1<P_T<K2}] = P0^p · exp(½p(p−1)σ²T) · (Φ(d(K1)) − Φ(d(K2)))

    with ``d(K) = (ln(P0/K) + (p−½)σ²T) / (σ√T)``. ``K1 ≤ 0 ⇒ d = +∞`` (Φ = 1);
    ``K2 = +∞ ⇒ d = −∞`` (Φ = 0). This is the building block of the Φ-sum.
    """
    sT = sigma * np.sqrt(T)

    def d(K: float) -> float:
        if K <= 0:
            return np.inf  # ln(P0/0) = +inf  → Φ = 1 (lower bound)
        if not np.isfinite(K):
            return -np.inf  # ln(P0/inf) = -inf → Φ = 0 (upper bound)
        return (np.log(P0 / K) + (p - 0.5) * sigma * sigma * T) / sT

    pref = P0**p * np.exp(0.5 * p * (p - 1.0) * sigma * sigma * T)
    return float(pref * (norm.cdf(d(K1)) - norm.cdf(d(K2))))


def fair_rate(P0: float, Pa: float, Pb: float, L: float, sigma: float, T: float) -> float:
    """``fairRate = E_Q[min(IL, MaxIL)] / MaxIL`` — EXACT closed form.

    The capped v3 payoff ``min(IL, MaxIL)`` is piecewise in the terminal price:

    - **below** ``Pa``  : ``IL = a1b·P + a0b`` (decreasing; a1b < 0), capped for
      ``P < PcapL`` if the cap binds.
    - **inside** ``[Pa, Pb]`` : ``IL = c1·P − 2L·√P + c0`` (convex, never capped —
      a convex function on the range lies below its endpoint chord ≤ MaxIL).
    - **above** ``Pb`` : ``IL = a1a·P + a0a`` (increasing; a1a > 0), capped for
      ``P > PcapR``.

    Each arm integrated against the lognormal density of ``P_T`` is a finite sum
    of :func:`_interval_moment` terms (``p ∈ {0, ½, 1}``). No Monte Carlo, no
    lookup, no fitted coefficients — evaluated live from ``(Pa, Pb, L, σ, T)``.

    ``T`` is in **years**. Verified ≡ ``il.py`` to ~5e-11 across width × σ × T
    (:func:`verify_closed_form`).
    """
    s0, sa, sb = np.sqrt(P0), np.sqrt(Pa), np.sqrt(Pb)
    amt0 = L * (1 / s0 - 1 / sb)
    amt1 = L * (s0 - sa)
    max_il = compute_max_il(P0, Pa, Pb, L)  # ground-truth geometry

    # Arm coefficients (IL = slope·P + intercept on the two linear arms).
    a1b, a0b = amt0 - L * (1 / sa - 1 / sb), amt1  # below: slope < 0
    c1, c0 = amt0 + L / sb, amt1 + L * sa  # inside: c1·P − 2L√P + c0
    a1a, a0a = amt0, amt1 - L * (sb - sa)  # above: slope > 0

    # Cap-crossing prices.
    PcapL = (max_il - a0b) / a1b  # below arm: cap binds for P < PcapL (if > 0)
    PcapR = (max_il - a0a) / a1a  # above arm: cap binds for P > PcapR (if > Pb)

    def M0(k1: float, k2: float) -> float:
        return _interval_moment(0.0, k1, k2, P0, sigma, T)

    def M1(k1: float, k2: float) -> float:
        return _interval_moment(1.0, k1, k2, P0, sigma, T)

    def Mh(k1: float, k2: float) -> float:
        return _interval_moment(0.5, k1, k2, P0, sigma, T)

    fp = 0.0
    # below arm (0, Pa)
    if PcapL > 0:
        fp += max_il * M0(0.0, PcapL) + (a1b * M1(PcapL, Pa) + a0b * M0(PcapL, Pa))
    else:
        fp += a1b * M1(0.0, Pa) + a0b * M0(0.0, Pa)
    # inside arm (Pa, Pb) — never capped
    fp += c1 * M1(Pa, Pb) - 2 * L * Mh(Pa, Pb) + c0 * M0(Pa, Pb)
    # above arm (Pb, inf)
    if PcapR > Pb:
        fp += (a1a * M1(Pb, PcapR) + a0a * M0(Pb, PcapR)) + max_il * M0(PcapR, np.inf)
    else:
        fp += max_il * M0(Pb, np.inf)
    return fp / max_il


def fair_premium(P0: float, Pa: float, Pb: float, L: float, sigma: float, T: float) -> float:
    """``FairPremium = fairRate · MaxIL`` (USDC) for the specific geometry."""
    return fair_rate(P0, Pa, Pb, L, sigma, T) * compute_max_il(P0, Pa, Pb, L)


# ─── Vectorised closed form (the hot path: surface sweeps, depositor MC) ──────


def _interval_moment_vec(
    p: float,
    K1: np.ndarray,
    K2: np.ndarray,
    P0: np.ndarray,
    sigma: np.ndarray,
    T: np.ndarray,
) -> np.ndarray:
    """Vectorised :func:`_interval_moment` — arrays broadcast; ``K ≤ 0 ⇒ Φ = 1``
    (lower bound), ``K = +∞ ⇒ Φ = 0`` (upper bound), elementwise."""
    sT = sigma * np.sqrt(T)

    def d(K: np.ndarray) -> np.ndarray:
        K = np.asarray(K, dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            val = (np.log(P0 / K) + (p - 0.5) * sigma * sigma * T) / sT
        val = np.where(K <= 0, np.inf, val)
        val = np.where(np.isfinite(K), val, -np.inf)
        return val

    pref = P0**p * np.exp(0.5 * p * (p - 1.0) * sigma * sigma * T)
    return pref * (norm.cdf(d(K1)) - norm.cdf(d(K2)))


def fair_rate_vec(
    P0: np.ndarray,
    Pa: np.ndarray,
    Pb: np.ndarray,
    L: np.ndarray,
    sigma: np.ndarray,
    T: np.ndarray,
) -> np.ndarray:
    """Vectorised :func:`fair_rate` — all inputs broadcast to a common shape.

    Same exact Φ-sum, with the two cap-branches folded into ``np.where``-free
    uniform formulas via clipped split points (``PcapL_eff = max(PcapL, 0)``,
    ``PcapR_eff = max(PcapR, Pb)``): when a cap does not bind the cap term's
    interval collapses to zero width, so the single expression covers both
    branches. ~1000× faster than looping the scalar form; verified ≡ scalar in
    the test suite.
    """
    P0, Pa, Pb, L, sigma, T = np.broadcast_arrays(
        *[np.asarray(x, dtype=float) for x in (P0, Pa, Pb, L, sigma, T)]
    )
    s0, sa, sb = np.sqrt(P0), np.sqrt(Pa), np.sqrt(Pb)
    amt0 = L * (1 / s0 - 1 / sb)
    amt1 = L * (s0 - sa)

    # MaxIL = max(IL(Pa), IL(Pb))  (vectorised boundary evaluation)
    il_pa = np.maximum(0.0, (amt0 * Pa + amt1) - L * (2 * sa - Pa / sb - sa))
    il_pb = np.maximum(0.0, (amt0 * Pb + amt1) - L * (2 * sb - Pb / sb - sa))
    max_il = np.maximum(il_pa, il_pb)

    a1b, a0b = amt0 - L * (1 / sa - 1 / sb), amt1  # below: slope < 0
    c1, c0 = amt0 + L / sb, amt1 + L * sa  # inside
    a1a, a0a = amt0, amt1 - L * (sb - sa)  # above: slope > 0

    PcapL = np.maximum((max_il - a0b) / a1b, 0.0)  # cap binds on (0, PcapL)
    PcapR = np.maximum((max_il - a0a) / a1a, Pb)  # cap binds on (PcapR, inf)

    inf = np.full_like(P0, np.inf)
    zero = np.zeros_like(P0)

    def M0(k1, k2):
        return _interval_moment_vec(0.0, k1, k2, P0, sigma, T)

    def M1(k1, k2):
        return _interval_moment_vec(1.0, k1, k2, P0, sigma, T)

    def Mh(k1, k2):
        return _interval_moment_vec(0.5, k1, k2, P0, sigma, T)

    below = max_il * M0(zero, PcapL) + a1b * M1(PcapL, Pa) + a0b * M0(PcapL, Pa)
    inside = c1 * M1(Pa, Pb) - 2 * L * Mh(Pa, Pb) + c0 * M0(Pa, Pb)
    above = a1a * M1(Pb, PcapR) + a0a * M0(Pb, PcapR) + max_il * M0(PcapR, inf)
    return (below + inside + above) / max_il


# ─── Closed-form verification references (CI cross-check) ─────────────────────


def fair_rate_quad(
    P0: float, Pa: float, Pb: float, L: float, sigma: float, T: float, n: int = 2_000_001
) -> float:
    """Dense-trapezoid reference for :func:`fair_rate` (exact to ~1e-7).

    Integrates the ``il.py`` capped payoff against the standard-normal density in
    z-space. This is the independent ground truth the closed form is checked
    against.
    """
    z = np.linspace(-12, 12, n)
    P_T = P0 * np.exp(-0.5 * sigma * sigma * T + sigma * np.sqrt(T) * z)
    payoff = compute_payout(P_T, P0, Pa, Pb, L)
    return float(np.trapezoid(payoff * norm.pdf(z), z) / compute_max_il(P0, Pa, Pb, L))


def fair_rate_mc(
    P0: float,
    Pa: float,
    Pb: float,
    L: float,
    sigma: float,
    T: float,
    n: int = 1_000_000,
    rng: Generator | None = None,
) -> float:
    """Monte-Carlo reference for :func:`fair_rate` (independent cross-check)."""
    rng = rng or np.random.default_rng(20260601)
    z = rng.standard_normal(n)
    P_T = P0 * np.exp(-0.5 * sigma * sigma * T + sigma * np.sqrt(T) * z)
    payoff = compute_payout(P_T, P0, Pa, Pb, L)
    return float(payoff.mean() / compute_max_il(P0, Pa, Pb, L))


def verify_closed_form(
    *,
    half_widths: tuple[float, ...] = (0.02, 0.05, 0.10, 0.20, 0.35, 0.50),
    sigmas: tuple[float, ...] = (0.30, 0.60, 1.00),
    durations_days: tuple[int, ...] = (7, 30, 90),
    P0: float = 3000.0,
    L: float = 1.0,
    centering: str = "geometric",
    quad_n: int = 2_000_001,
) -> dict[str, float | tuple]:
    """Assert ``fair_rate`` ≡ the quadrature ground truth across the domain.

    Returns the worst-cell absolute error and its coordinates. The contract: this
    must stay below ~1e-5 (machine precision vs the dense trapezoid) — if it ever
    disagrees, STOP and surface (the closed form is a proposal vs ``il.py``).
    """
    max_err = 0.0
    worst: tuple = ()
    for hw in half_widths:
        Pa, Pb = make_range(P0, hw, centering)
        for sig in sigmas:
            for td in durations_days:
                T = td / DAYS_PER_YEAR
                cf = fair_rate(P0, Pa, Pb, L, sig, T)
                qd = fair_rate_quad(P0, Pa, Pb, L, sig, T, n=quad_n)
                err = abs(cf - qd)
                if err > max_err:
                    max_err, worst = err, (hw, sig, td, cf, qd)
    return {"max_abs_err": max_err, "worst_cell": worst}


# ─── Deliverable 3: lone-writer CVaR vs diversification collapse → baseLoad ──


def lone_writer_cvar(
    P0: float,
    Pa: float,
    Pb: float,
    L: float,
    sigma: float,
    T: float,
    *,
    cvar_q: float = 0.95,
    n: int = 400_000,
    rng: Generator | None = None,
) -> dict[str, float]:
    """A single risk-averse writer's CVaR95 of the payoff, as a fraction of MaxIL.

    The lone writer must reserve against the *tail* of what they may pay, not the
    mean: ``CVaR_q = E[payout | payout ≥ quantile_q] / MaxIL``. This sits at
    ≈91–100% of MaxIL almost everywhere — the **overcharge gap** vs ``fairRate``
    that a diversified pool collapses (its reason to exist). Also returns
    ``fair`` (= fairRate, the closed form), ``p_hit_cap`` and ``p_zero``.
    """
    rng = rng or np.random.default_rng(20260601)
    max_il = compute_max_il(P0, Pa, Pb, L)
    z = rng.standard_normal(n)
    P_T = P0 * np.exp(-0.5 * sigma * sigma * T + sigma * np.sqrt(T) * z)
    payout = compute_payout(P_T, P0, Pa, Pb, L)
    thresh = np.quantile(payout, cvar_q)
    cvar = payout[payout >= thresh].mean() / max_il
    return {
        "fair": fair_rate(P0, Pa, Pb, L, sigma, T),
        "cvar": float(cvar),
        "p_hit_cap": float((payout >= 0.999 * max_il).mean()),
        "p_zero": float((payout <= 1e-9 * max_il).mean()),
        "max_il_over_v0": max_il / position_V0(P0, Pa, Pb, L),
    }


def diversification_collapse(
    *,
    half_width: float = 0.10,
    sigma: float = 0.60,
    T_days: int = 30,
    n_grid: tuple[int, ...] = (1, 2, 5, 10, 25, 50, 100),
    correlation: float = 0.0,
    cvar_q: float = 0.95,
    n_runs: int = 40_000,
    P0: float = 3000.0,
    L: float = 1.0,
    rng: Generator | None = None,
) -> dict[str, object]:
    """Per-contract pool CVaR95 as the book size ``N`` grows: the collapse curve.

    Each run draws ``N`` correlated terminal prices for ``N`` identical-geometry
    contracts via a one-factor model::

        P_T,i = P0·exp(−½σ²T + σ√T·(√ρ·Z_common + √(1−ρ)·Z_i))

    ``ρ = correlation``: ``ρ = 0`` is full cross-sectional diversification (the
    benign upper bound — distinct durations / staggered entries decorrelate the
    book), ``ρ = 1`` is a synchronized book (one ETH move hits every contract —
    zero diversification, the tail-dependent crash regime). The pool's
    per-contract CVaR is ``CVaR_q( mean payout per contract ) / MaxIL``. The
    spread between the ``N = 1`` value (the lone-writer CVaR) and the large-``N``
    value is the diversification benefit that funds ``baseLoad``.
    """
    rng = rng or np.random.default_rng(20260601)
    Pa, Pb = make_range(P0, half_width)
    max_il = compute_max_il(P0, Pa, Pb, L)
    fair = fair_rate(P0, Pa, Pb, L, sigma, T_days / DAYS_PER_YEAR)
    T = T_days / DAYS_PER_YEAR
    drift = -0.5 * sigma * sigma * T
    vol = sigma * np.sqrt(T)

    per_contract_cvar: list[float] = []
    for N in n_grid:
        z_common = rng.standard_normal((n_runs, 1))
        z_idio = rng.standard_normal((n_runs, N))
        shock = np.sqrt(correlation) * z_common + np.sqrt(1.0 - correlation) * z_idio
        P_T = P0 * np.exp(drift + vol * shock)
        payout, _ = batch_payouts_and_maxils(
            np.full((n_runs, N), P0),
            np.full((n_runs, N), Pa),
            np.full((n_runs, N), Pb),
            np.full((n_runs, N), L),
            P_T,
        )
        per_contract = payout.mean(axis=1) / max_il  # mean payout per contract / MaxIL
        thresh = np.quantile(per_contract, cvar_q)
        per_contract_cvar.append(float(per_contract[per_contract >= thresh].mean()))

    return {
        "n_grid": list(n_grid),
        "per_contract_cvar": per_contract_cvar,
        "fair": float(fair),
        "lone_writer_cvar": per_contract_cvar[0],
        "diversified_cvar": per_contract_cvar[-1],
        "correlation": correlation,
        "half_width": half_width,
        "sigma": sigma,
        "T_days": T_days,
    }


def base_load_from_envelope(
    *,
    fair: float,
    diversified_cvar: float,
    capital_fraction: float = 0.5,
) -> dict[str, float]:
    """Size ``baseLoad`` inside the [fair, diversified-CVaR] envelope.

    The pool must charge ≥ ``fair`` (else negative-EV) and *can* charge up to the
    diversified-pool CVaR (the capital a prudent diversified underwriter reserves)
    while still undercutting a lone MM (whose CVaR is ~100%). ``baseLoad`` is the
    load *over fair* that places the price a ``capital_fraction`` of the way from
    fair to the diversified CVaR::

        target_rate = fair + capital_fraction·(diversified_cvar − fair)
        baseLoad    = target_rate / fair − 1

    Returned in both fractional and bps form. ``capital_fraction`` is the policy
    dial the heavy run (P1.13) sets per regime against the safety targets.
    """
    target_rate = fair + capital_fraction * max(0.0, diversified_cvar - fair)
    base_load = target_rate / fair - 1.0 if fair > 0 else 0.0
    return {
        "fair": fair,
        "diversified_cvar": diversified_cvar,
        "target_rate": target_rate,
        "base_load": base_load,
        "base_load_bps": base_load * 10_000.0,
        "capital_fraction": capital_fraction,
    }


# ─── Deliverables 4 + 5: the two skews (single-asset) ────────────────────────


@dataclass(frozen=True)
class UtilSkewParams:
    """Monotone-convex ``util_skew(u)`` on utilization ``u = locked/(locked+free)``.

    ``util_skew(u) = slope · (max(0, u − knee) / (1 − knee))^power``, clamped at
    ``cap``. Flat below ``knee`` (spare capacity is cheap), rising convexly as the
    pool approaches full commitment — the same locked/free accounting that powers
    the withdrawal-delay run-defense also prices new coverage up before the pool
    is over-committed (spec §3.5 / §7.3). Returned as a fraction (load over fair).
    """

    knee: float = 0.5
    slope: float = 0.40
    power: float = 2.0
    cap: float = 0.50

    def __post_init__(self) -> None:
        if not 0.0 <= self.knee < 1.0:
            raise ValueError("knee must be in [0, 1)")
        if self.slope < 0 or self.power <= 0 or self.cap < 0:
            raise ValueError("slope ≥ 0, power > 0, cap ≥ 0 required")


def util_skew(u: float | np.ndarray, params: UtilSkewParams | None = None) -> np.ndarray:
    """Utilization skew (load over fair) — see :class:`UtilSkewParams`."""
    p = params or UtilSkewParams()
    u = np.clip(np.asarray(u, dtype=float), 0.0, 1.0)
    x = np.maximum(0.0, u - p.knee) / (1.0 - p.knee)
    return np.minimum(p.cap, p.slope * x**p.power)


def coverage_concentration(coverage: np.ndarray) -> float:
    """Normalised Herfindahl–Hirschman index of an outstanding-coverage histogram.

    ``coverage`` is the MaxIL-weighted coverage per corner of the
    width × moneyness × duration grid (any flattened shape). Returns the HHI
    normalised to ``[0, 1]``: ``0`` = perfectly dispersed across ``m`` non-empty
    corners, ``1`` = all coverage in one corner. This is the honest single-pair
    analogue of concentration — clustered coverage all hits MaxIL together in one
    move (spec §3.5).
    """
    c = np.asarray(coverage, dtype=float).ravel()
    total = c.sum()
    if total <= 0:
        return 0.0
    shares = c / total
    m = int((c > 0).sum())
    hhi = float((shares**2).sum())
    if m <= 1:
        return 1.0
    return (hhi - 1.0 / m) / (1.0 - 1.0 / m)


@dataclass(frozen=True)
class DispersionSkewParams:
    """``dispersion_skew(h) = slope · h^power`` clamped at ``cap``.

    ``h`` is the normalised concentration from :func:`coverage_concentration`.
    Rises with clustering; a well-dispersed book (different widths, moneyness,
    durations) is charged ~0. Returned as a fraction (load over fair).
    """

    slope: float = 0.50
    power: float = 1.5
    cap: float = 0.50

    def __post_init__(self) -> None:
        if self.slope < 0 or self.power <= 0 or self.cap < 0:
            raise ValueError("slope ≥ 0, power > 0, cap ≥ 0 required")


def dispersion_skew(
    concentration: float | np.ndarray, params: DispersionSkewParams | None = None
) -> np.ndarray:
    """Dispersion skew (load over fair) — see :class:`DispersionSkewParams`."""
    p = params or DispersionSkewParams()
    h = np.clip(np.asarray(concentration, dtype=float), 0.0, 1.0)
    return np.minimum(p.cap, p.slope * h**p.power)


# ─── Deliverable 6: the I10 clamp (premium ≤ FairPremium·(1+maxLoad)) ────────


def clamp_load(
    base_load: float | np.ndarray,
    util: float | np.ndarray,
    dispersion: float | np.ndarray,
    max_load: float,
) -> np.ndarray:
    """Total load = ``min(baseLoad + util_skew + dispersion_skew, maxLoad)``.

    Invariant **I10**, enforced BY CONSTRUCTION: the premium is
    ``FairPremium·(1 + clamp_load(...))`` so ``premium ≤ FairPremium·(1 + maxLoad)``
    holds for *any* inputs — both paths, upstream of settle (never touches
    settle / MaxIL / I1–I9).
    """
    total = np.asarray(base_load, float) + np.asarray(util, float) + np.asarray(dispersion, float)
    return np.minimum(total, max_load)


def premium_from_load(fair_premium_usdc: float, total_load: float) -> float:
    """``premium = FairPremium · (1 + clamped_total_load)`` (round-up is on-chain)."""
    return fair_premium_usdc * (1.0 + total_load)


def size_max_load_bps(
    *,
    base_load: float,
    util_cap: float,
    dispersion_cap: float,
    headroom: float = 0.0,
) -> int:
    """Size ``maxLoadBps`` so the clamp never truncates a legitimately-built load.

    ``maxLoad`` must be ≥ ``baseLoad + util_cap + dispersion_cap`` for the clamp
    to be a genuine ceiling (not a routine truncation), yet small enough to be a
    real overcharge guard. Default sets it exactly at the reachable maximum (plus
    optional ``headroom``). Returned in basis points (the on-chain unit).
    """
    max_load = base_load + util_cap + dispersion_cap + headroom
    return int(round(max_load * 10_000.0))


# ─── Surface builders for the 9-marketId grid ────────────────────────────────


@dataclass(frozen=True)
class GeometryCell:
    """One (width, distance-to-edge, duration) point on the calibration grid."""

    half_width: float
    offset_fraction: float
    T_days: int
    fee_tier_bps: int | None = None


def fair_rate_surface(
    *,
    half_widths: tuple[float, ...] = (0.05, 0.10, 0.20),
    offsets: tuple[float, ...] = (0.0,),
    durations_days: tuple[int, ...] = DURATIONS_DAYS,
    sigma: float = 0.60,
    P0: float = 3000.0,
    L: float = 1.0,
) -> list[dict[str, float]]:
    """Evaluate the exact ``fairRate`` over a width × distance-to-edge × duration
    grid at a fixed ``σ`` — the reference surface (deliverable 1)."""
    rows: list[dict[str, float]] = []
    for hw in half_widths:
        for off in offsets:
            Pa, Pb = place_range_with_offset(P0, hw, off)
            for td in durations_days:
                T = td / DAYS_PER_YEAR
                rows.append(
                    {
                        "half_width": hw,
                        "offset_fraction": off,
                        "T_days": td,
                        "sigma": sigma,
                        "fair_rate": fair_rate(P0, Pa, Pb, L, sigma, T),
                        "max_il_over_v0": compute_max_il(P0, Pa, Pb, L)
                        / position_V0(P0, Pa, Pb, L),
                    }
                )
    return rows
