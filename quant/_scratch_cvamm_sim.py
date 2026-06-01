"""Scratch simulation to ground the cvAMM analysis in the repo's OWN IL math.

Answers four questions with authoritative numbers (not the prompt's claims):
  1. MaxIL/V0 as a function of range width  (pure geometry; resolves spec vs prompt)
  2. Fair premium = E[min(IL,MaxIL)]/MaxIL  via risk-neutral MC, per duration & width
  3. The lone-writer CVaR (what an unhedged risk-averse MM would charge)
  4. The exact cvAMM published price for Example A (50k, +/-10%, 30d)

Run with the quant venv. Not committed; deleted after the analysis.
"""

from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import numpy as np
from inflexion_quant.il import compute_max_il, compute_payout, position_V0, entry_amounts

RNG = np.random.default_rng(20260601)

def make_range(P0: float, width: float, centering: str = "geometric"):
    """A +/- width range around P0.  geometric: Pa=P0/(1+w), Pb=P0*(1+w)."""
    if centering == "geometric":
        return P0 / (1 + width), P0 * (1 + width)
    return P0 * (1 - width), P0 * (1 + width)  # arithmetic

def maxil_over_v0(width: float, centering="geometric", P0=3000.0, L=1.0):
    Pa, Pb = make_range(P0, width, centering)
    mil = compute_max_il(P0, Pa, Pb, L)
    v0 = position_V0(P0, Pa, Pb, L)
    return mil / v0

def mc_terminal_prices(P0, sigma, T_days, n):
    """Risk-neutral GBM (drift 0), terminal price only."""
    T = T_days / 365.0
    z = RNG.standard_normal(n)
    return P0 * np.exp(-0.5 * sigma**2 * T + sigma * np.sqrt(T) * z)

def fair_and_cvar(width, sigma, T_days, centering="geometric", P0=3000.0, L=1.0, n=400_000, cvar_q=0.95):
    Pa, Pb = make_range(P0, width, centering)
    max_il = compute_max_il(P0, Pa, Pb, L)
    PT = mc_terminal_prices(P0, sigma, T_days, n)
    payout = compute_payout(PT, P0, Pa, Pb, L)        # min(IL, MaxIL), vectorised
    fair = payout.mean() / max_il                      # E[min(IL,MaxIL)]/MaxIL
    p_hit_cap = (payout >= 0.999 * max_il).mean()
    p_zero = (payout <= 1e-9 * max_il).mean()
    # lone risk-averse writer: CVaR_95 of the payoff (avg of worst 5% outcomes) / MaxIL
    thresh = np.quantile(payout, cvar_q)
    cvar = payout[payout >= thresh].mean() / max_il
    return dict(max_il_over_v0=max_il/position_V0(P0,Pa,Pb,L), fair=fair,
                cvar=cvar, p_hit_cap=p_hit_cap, p_zero=p_zero, max_il=max_il)

print("="*78)
print("Q1. MaxIL / V0  (PURE GEOMETRY — no vol, no time). Resolves spec vs prompt.")
print("="*78)
print(f"{'width':>8} | {'geometric':>12} | {'arithmetic':>12}")
for w in (0.05, 0.10, 0.20, 0.50):
    print(f"{'+/-'+str(int(w*100))+'%':>8} | {maxil_over_v0(w,'geometric'):>11.3%} | {maxil_over_v0(w,'arithmetic'):>11.3%}")
print("\nSpec  §3.2 claims (centered):  +/-5%=0.3%  +/-10%=1.2%  +/-20%=4.8%  +/-50%=25%")
print("Prompt Part0 claims:           +/-5%=1.3%  +/-10%=2.7%  +/-20%=5.8%")

print("\n" + "="*78)
print("Q2+Q3. Fair premium (E[min(IL,MaxIL)]/MaxIL) and lone-writer CVaR95, sigma=60%")
print("="*78)
print(f"{'width':>7} {'dur':>5} | {'MaxIL/V0':>9} | {'fair%MaxIL':>10} | {'CVaR95%':>8} | {'gap pts':>7} | {'P(cap)':>7} | {'P(0)':>6}")
for w in (0.05, 0.10, 0.20):
    for T in (7, 30, 90):
        r = fair_and_cvar(w, 0.60, T)
        gap = (r['cvar'] - r['fair']) * 100
        print(f"{'+/-'+str(int(w*100))+'%':>7} {str(T)+'d':>5} | {r['max_il_over_v0']:>8.2%} | "
              f"{r['fair']:>9.1%} | {r['cvar']:>7.1%} | {gap:>6.1f} | {r['p_hit_cap']:>6.1%} | {r['p_zero']:>5.1%}")

print("\n" + "="*78)
print("Q4. Example A: 50,000 USDC position, +/-10% range, 30 days, sigma=60%")
print("="*78)
# pick L so that V0 == 50_000 at P0=3000
P0 = 3000.0
Pa, Pb = make_range(P0, 0.10, "geometric")
v0_unit = position_V0(P0, Pa, Pb, 1.0)
L = 50_000.0 / v0_unit
max_il = compute_max_il(P0, Pa, Pb, L)
PT = mc_terminal_prices(P0, 0.60, 30, 400_000)
fair_frac = compute_payout(PT, P0, Pa, Pb, L).mean() / max_il
fair_prem = fair_frac * max_il
print(f"  MaxIL              = {max_il:,.0f} USDC  ({max_il/50_000:.2%} of position)")
print(f"  fair premium %MaxIL = {fair_frac:.1%}")
print(f"  fair premium       = {fair_prem:,.0f} USDC")
for load in (0.05, 0.15, 0.30):
    print(f"    cvAMM price @ load +{int(load*100)}% (k*conc=0) = {fair_prem*(1+load):,.0f} USDC  "
          f"({fair_prem*(1+load)/50_000:.2%} of position)")
# with concentration skew k=1.0, single-pair => conc=1.0 => multiplier (1+0.05)*(1+1.0*1.0)?? show the degeneracy
print("  NOTE: single-pair pool => concentration = maxAsset/total = 1.0 always (see analysis).")
