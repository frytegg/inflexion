"""VERIFY the proposed EXACT closed form for FairPremium = E_Q[min(IL, MaxIL)]
against the repo's OWN il.py, via two independent references (Gauss-Hermite-style
dense trapezoid in z-space, and Monte Carlo). Per the Q2 instruction: treat the
closed form as a proposal; if it disagrees with il.py, STOP and surface.

Ground truth = il.py.compute_payout (min(IL,MaxIL)) and compute_max_il.
Reference 1  = dense trapezoid of min(IL,MaxIL)*phi(z) over z in [-12,12]  (exact ~1e-7).
Reference 2  = Monte Carlo (independent).
Candidate    = the proposed Phi-sum closed form (implemented below).

Also reconciles the 0.6942 (user grid) vs 0.708 (my earlier MC) discrepancy by
testing BOTH arithmetic and geometric range conventions.
"""
from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import numpy as np
from scipy.stats import norm
from inflexion_quant.il import compute_max_il, compute_payout, compute_il, entry_amounts

RNG = np.random.default_rng(20260601)
Phi = norm.cdf


def make_range(P0, hw, conv):
    if conv == "geometric":
        return P0 / (1 + hw), P0 * (1 + hw)
    return P0 * (1 - hw), P0 * (1 + hw)  # arithmetic


# ─── Candidate: the proposed exact closed form ───────────────────────────────
def _Mp(p, K1, K2, P0, sigma, T):
    """E[ P_T^p * 1{K1<P_T<K2} ] under GBM, r=0.  K1<=0 -> 0 ; K2=inf -> inf."""
    sT = sigma * np.sqrt(T)
    def d(K):
        if K <= 0:
            return np.inf          # ln(P0/0)=+inf -> Phi=1 (lower bound)
        if not np.isfinite(K):
            return -np.inf         # ln(P0/inf)=-inf -> Phi=0 (upper bound)
        return (np.log(P0 / K) + (p - 0.5) * sigma * sigma * T) / sT
    pref = P0 ** p * np.exp(0.5 * p * (p - 1.0) * sigma * sigma * T)
    return pref * (Phi(d(K1)) - Phi(d(K2)))


def closed_form_fairrate(P0, Pa, Pb, L, sigma, T):
    s0, sa, sb = np.sqrt(P0), np.sqrt(Pa), np.sqrt(Pb)
    amt0 = L * (1 / s0 - 1 / sb)
    amt1 = L * (s0 - sa)
    MaxIL = compute_max_il(P0, Pa, Pb, L)        # ground-truth geometry

    # arm coefficients
    a1b, a0b = amt0 - L * (1 / sa - 1 / sb), amt1            # below: a1b*P + a0b
    c1, c0 = amt0 + L / sb, amt1 + L * sa                    # inside: c1*P - 2L*sqrt(P) + c0
    a1a, a0a = amt0, amt1 - L * (sb - sa)                    # above: a1a*P + a0a

    # cap crossings
    PcapL = (MaxIL - a0b) / a1b      # a1b<0 ; <=0 means cap never binds below
    PcapR = (MaxIL - a0a) / a1a      # a1a>0 ; >Pb when right edge isn't the max

    M0 = lambda k1, k2: _Mp(0.0, k1, k2, P0, sigma, T)
    M1 = lambda k1, k2: _Mp(1.0, k1, k2, P0, sigma, T)
    Mh = lambda k1, k2: _Mp(0.5, k1, k2, P0, sigma, T)

    fp = 0.0
    # below arm (0, Pa)
    if PcapL > 0:
        fp += MaxIL * M0(0.0, PcapL) + (a1b * M1(PcapL, Pa) + a0b * M0(PcapL, Pa))
    else:
        fp += a1b * M1(0.0, Pa) + a0b * M0(0.0, Pa)
    # inside arm (Pa, Pb) — never capped (IL<=MaxIL on the whole range)
    fp += c1 * M1(Pa, Pb) - 2 * L * Mh(Pa, Pb) + c0 * M0(Pa, Pb)
    # above arm (Pb, inf)
    if PcapR > Pb:
        fp += (a1a * M1(Pb, PcapR) + a0a * M0(Pb, PcapR)) + MaxIL * M0(PcapR, np.inf)
    else:
        fp += MaxIL * M0(Pb, np.inf)
    return fp / MaxIL


# ─── Reference 1: dense trapezoid in z-space (exact ~1e-7) ────────────────────
def quad_fairrate(P0, Pa, Pb, L, sigma, T, n=4_000_001):
    z = np.linspace(-12, 12, n)
    PT = P0 * np.exp(-0.5 * sigma * sigma * T + sigma * np.sqrt(T) * z)
    payoff = compute_payout(PT, P0, Pa, Pb, L)          # il.py: min(IL,MaxIL)
    w = norm.pdf(z)
    integral = np.trapezoid(payoff * w, z)
    return integral / compute_max_il(P0, Pa, Pb, L)


# ─── Reference 2: Monte Carlo ─────────────────────────────────────────────────
def mc_fairrate(P0, Pa, Pb, L, sigma, T, n=2_000_000):
    z = RNG.standard_normal(n)
    PT = P0 * np.exp(-0.5 * sigma * sigma * T + sigma * np.sqrt(T) * z)
    payoff = compute_payout(PT, P0, Pa, Pb, L)
    return payoff.mean() / compute_max_il(P0, Pa, Pb, L)


P0, L = 3000.0, 1.0
print("=" * 96)
print("USER'S CITED GRID — which range convention reproduces it? (closed form vs quad vs MC)")
print("=" * 96)
grid = [(0.10, 0.60, 30, 0.6942), (0.10, 0.60, 7, 0.4288), (0.10, 0.60, 90, 0.8206),
        (0.05, 0.60, 30, 0.8453), (0.20, 0.60, 30, 0.4312), (0.35, 0.90, 90, 0.4053)]
for conv in ("arithmetic", "geometric"):
    print(f"\n--- convention = {conv} ---")
    print(f"{'hw':>5} {'sig':>4} {'T':>4} | {'cited':>7} | {'closed':>8} | {'quad':>8} | {'MC':>8} | {'|cf-quad|':>9}")
    for hw, sig, Td, cited in grid:
        Pa, Pb = make_range(P0, hw, conv)
        T = Td / 365.0
        cf = closed_form_fairrate(P0, Pa, Pb, L, sig, T)
        qd = quad_fairrate(P0, Pa, Pb, L, sig, T)
        mc = mc_fairrate(P0, Pa, Pb, L, sig, T)
        print(f"{hw:>5} {sig:>4} {Td:>4} | {cited:>7.4f} | {cf:>8.5f} | {qd:>8.5f} | {mc:>8.5f} | {abs(cf-qd):>9.2e}")

print("\n" + "=" * 96)
print("FULL-DOMAIN EXACTNESS: closed form vs quadrature (the il.py ground truth), geometric")
print("=" * 96)
maxerr = 0.0
worst = None
for hw in (0.02, 0.05, 0.10, 0.20, 0.35, 0.50):
    for sig in (0.30, 0.60, 1.00):
        for Td in (7, 30, 90):
            Pa, Pb = make_range(P0, hw, "geometric")
            T = Td / 365.0
            cf = closed_form_fairrate(P0, Pa, Pb, L, sig, T)
            qd = quad_fairrate(P0, Pa, Pb, L, sig, T)
            e = abs(cf - qd)
            if e > maxerr:
                maxerr, worst = e, (hw, sig, Td, cf, qd)
print(f"  max |closed - quad| over 54 cells = {maxerr:.3e}")
print(f"  worst cell: hw={worst[0]} sig={worst[1]} T={worst[2]}d  closed={worst[3]:.6f} quad={worst[4]:.6f}")
print("\n  VERDICT:", "CONFIRMED (machine precision)" if maxerr < 1e-5 else "DISAGREEMENT — STOP & SURFACE")
