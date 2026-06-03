"""Integer fixed-point prototype of the FairValueOracle Φ-sum (Stylus port model).

Stylus bans floating point, so the Rust port must use integer fixed-point. This
prototype implements the EXACT algorithm the Rust crate will run — Python big-ints
stand in for Rust U256/I256, with truncate-toward-zero mul/div matching Rust's
integer semantics — at SCALE = 1e36. We validate it reproduces the mpmath 50-digit
ground truth to ≤ 1e-12 across the domain (incl. the tight ±2% / 0.05%-fee tier
where 1/MaxIL ≈ 1e4 amplifies any erf error). Once this passes, the Rust port is a
mechanical transliteration of these verified integer ops.

Transcendentals (all integer ops, no floats):
  * iexp  — arg-reduce by ln2, Taylor on the remainder, scale by 2^k.
  * iln   — normalise mantissa to [1,2), atanh series.
  * isqrt — math.isqrt(x · ONE) (Rust: U512 Newton, see math.rs).
  * erf   — Maclaurin series (|t| ≤ 2; no cancellation in fixed point).
  * erfc  — exp(−t²)/√π · continued fraction (t > 2 tail; DLMF 7.9, a_k = k/2).
  * Φ(d)  — ½·erfc(−d/√2) assembled to keep both terms un-saturated.

Run: quant/.venv/Scripts/python.exe quant/_scratch_fairvalue_fixedpoint.py
"""

from __future__ import annotations

import re
from pathlib import Path

import mpmath as mp

mp.mp.dps = 60

ONE = 10**36  # fixed-point scale (1.0)
HALF = ONE // 2

# ─── High-precision constants, scaled to ONE (computed once at full precision) ─
def _c(x: mp.mpf) -> int:
    return int(mp.nint(x * ONE))

LN2 = _c(mp.log(2))
SQRT2 = _c(mp.sqrt(2))
SQRTPI = _c(mp.sqrt(mp.pi))
TWO_OVER_SQRTPI = _c(2 / mp.sqrt(mp.pi))
WAD = 10**18
SECONDS_PER_YEAR = 365 * 24 * 60 * 60

# Sentinels for Φ at the integration bounds.
PHI_ONE = ONE  # Φ(+∞)
PHI_ZERO = 0  # Φ(−∞)


# ─── Truncate-toward-zero signed primitives (match Rust I256) ─────────────────
def smul(x: int, y: int) -> int:
    """(x·y)/ONE, truncated toward zero."""
    s = -1 if (x < 0) ^ (y < 0) else 1
    return s * ((abs(x) * abs(y)) // ONE)


def sdiv(x: int, y: int) -> int:
    """(x·ONE)/y, truncated toward zero."""
    s = -1 if (x < 0) ^ (y < 0) else 1
    return s * ((abs(x) * ONE) // abs(y))


def isqrt_scaled(x: int) -> int:
    """sqrt(value)·ONE where value = x/ONE  ⇒  isqrt(x·ONE)."""
    return mp.isqrt(x * ONE) if hasattr(mp, "isqrt") else _isqrt(x * ONE)


def _isqrt(n: int) -> int:
    import math
    return math.isqrt(n)


# ─── exp / ln ─────────────────────────────────────────────────────────────────
def iexp(x: int) -> int:
    """e^x in fixed point. Arg-reduce by ln2 then Taylor on the remainder."""
    # k = round(x / ln2)
    k = (2 * x + (LN2 if x >= 0 else -LN2)) // (2 * LN2)  # nearest integer
    r = x - k * LN2  # remainder in [−ln2/2, ln2/2]
    term = ONE
    s = ONE
    n = 1
    while True:
        term = smul(term, r) // n
        s += term
        if -1 < term < 1:
            break
        n += 1
        if n > 200:
            break
    if k >= 0:
        return s << k
    return s >> (-k)


def iln(x: int) -> int:
    """ln(value), value = x/ONE > 0. Normalise mantissa to [1,2), atanh series."""
    assert x > 0
    e = 0
    y = x
    while y >= 2 * ONE:
        y >>= 1
        e += 1
    while y < ONE:
        y <<= 1
        e -= 1
    # ln(value) = e·ln2 + ln(mantissa), mantissa = y/ONE ∈ [1,2)
    u = sdiv(y - ONE, y + ONE)  # ∈ [0, 1/3)
    uu = smul(u, u)
    term = u
    s = u
    k = 1
    while True:
        term = smul(term, uu)
        add = term // (2 * k + 1)
        s += add
        if -1 < add < 1:
            break
        k += 1
        if k > 200:
            break
    return e * LN2 + 2 * s


# ─── erf / erfc / Φ ───────────────────────────────────────────────────────────
def erf_taylor(t: int) -> int:
    """erf(t) for 0 ≤ t ≤ 2 via Maclaurin series (abs precision ~1e-36)."""
    tt = smul(t, t)  # t²
    x = t  # running term x_n = (−1)^n t^{2n+1}/(n!(2n+1)) (the n=0 term is t)
    s = t
    n = 1
    while True:
        x = smul(x, -tt) // n  # ×(−t²)/n
        x = (x * (2 * n - 1)) // (2 * n + 1)  # ×(2n−1)/(2n+1)
        s += x
        if -1 < x < 1:
            break
        n += 1
        if n > 400:
            break
    return smul(TWO_OVER_SQRTPI, s)


def erfc_cf(t: int) -> int:
    """erfc(t) for t > 2 via exp(−t²)/√π · continued fraction (a_k = k/2)."""
    tt = smul(t, t)
    emx2 = iexp(-tt)
    # CF = 1/(t + a1/(t + a2/(t + ...))), a_k = k/2 ; backward recurrence.
    T = 0
    for k in range(80, 0, -1):
        ak = (k * ONE) // 2
        T = sdiv(ak, t + T)
    cf = sdiv(ONE, t + T)
    return smul(sdiv(emx2, SQRTPI), cf)


def erfc_pos(t: int) -> int:
    """erfc(t) for t ≥ 0."""
    if t <= 2 * ONE:
        return ONE - erf_taylor(t)
    return erfc_cf(t)


def phi(d: int) -> int:
    """Φ(d) = ½·erfc(−d/√2), assembled to keep both terms un-saturated."""
    x = sdiv(d, SQRT2)  # d/√2
    if d >= 0:
        return ONE - erfc_pos(x) // 2  # 1 − ½erfc(x)
    return erfc_pos(-x) // 2  # ½erfc(−x)


# ─── The Φ-sum (mirror of cvamm.fair_rate / FairValueOracle.sol) ──────────────
def _moment(p2: int, K1, K2, sigma: int, T: int, s2t: int, cTerm: int, pref: int) -> int:
    """E[P^p·1{K1<P<K2}] (normalised P0=1). p2 ∈ {0,1,2} encodes p ∈ {0,½,1}.

    K = None → +∞ (Φ=0) ; K = 0 → Φ=1. cTerm = (p−½)σ²T ; pref = exp(½p(p−1)σ²T).
    """
    sT = smul(sigma, isqrt_scaled(T))

    def phi_d(K):
        if K is None:
            return PHI_ZERO
        if K <= 0:
            return PHI_ONE
        num = -iln(K) + cTerm
        return phi(sdiv(num, sT))

    return smul(pref, phi_d(K1) - phi_d(K2))


def fair_rate_fp(a: int, b: int, sigma: int, T: int) -> int:
    """fairRate (scaled). a,b,sigma scaled to ONE; T = years scaled to ONE."""
    sa = isqrt_scaled(a)
    sb = isqrt_scaled(b)
    amt0 = ONE - sdiv(ONE, sb)
    amt1 = ONE - sa

    il_pa = smul(amt0, a) + amt1 - (2 * sa - sdiv(a, sb) - sa)
    il_pb = smul(amt0, b) + amt1 - (2 * sb - sdiv(b, sb) - sa)
    il_pa = max(0, il_pa)
    il_pb = max(0, il_pb)
    max_il = max(il_pa, il_pb)

    a1b = amt0 - (sdiv(ONE, sa) - sdiv(ONE, sb))
    a0b = amt1
    c1 = amt0 + sdiv(ONE, sb)
    c0 = amt1 + sa
    a1a = amt0
    a0a = amt1 - (sb - sa)

    PcapL = sdiv(max_il - a0b, a1b)
    PcapR = sdiv(max_il - a0a, a1a)

    s2t = smul(smul(sigma, sigma), T)  # σ²T
    half = s2t // 2
    prefH = iexp(-(s2t // 8))  # exp(−σ²T/8)

    def M0(k1, k2):
        return _moment(0, k1, k2, sigma, T, s2t, -half, ONE)

    def M1(k1, k2):
        return _moment(2, k1, k2, sigma, T, s2t, half, ONE)

    def Mh(k1, k2):
        return _moment(1, k1, k2, sigma, T, s2t, 0, prefH)

    fp = 0
    if PcapL > 0:
        fp += smul(max_il, M0(0, PcapL)) + smul(a1b, M1(PcapL, a)) + smul(a0b, M0(PcapL, a))
    else:
        fp += smul(a1b, M1(0, a)) + smul(a0b, M0(0, a))
    fp += smul(c1, M1(a, b)) - 2 * Mh(a, b) + smul(c0, M0(a, b))
    if PcapR > b:
        fp += smul(a1a, M1(b, PcapR)) + smul(a0a, M0(b, PcapR)) + smul(max_il, M0(PcapR, None))
    else:
        fp += smul(max_il, M0(b, None))
    return sdiv(fp, max_il)


# ─── Validate vs mpmath HP on the committed fixtures + a denser grid ──────────
def main() -> None:
    from _scratch_fairvalue_hp_reference import fair_rate_hp, parse_fixtures

    fx = parse_fixtures()
    print(f"Validating fixed-point prototype vs mpmath HP on {len(fx)} fixtures (SCALE=1e36)\n")
    worst = (mp.mpf(0), None)
    worst_tight = (mp.mpf(0), None)
    for a_w, b_w, s_w, d_w, _fr_sol in fx:
        a = a_w * (ONE // WAD)
        b = b_w * (ONE // WAD)
        sigma = s_w * (ONE // WAD)
        T = (d_w * ONE) // SECONDS_PER_YEAR
        fp = fair_rate_fp(a, b, sigma, T)
        fp_val = mp.mpf(fp) / ONE
        hp = fair_rate_hp(mp.mpf(a_w) / WAD, mp.mpf(b_w) / WAD, mp.mpf(s_w) / WAD, mp.mpf(d_w) / SECONDS_PER_YEAR)
        err = abs(fp_val - hp)
        if err > worst[0]:
            worst = (err, (a_w, b_w, s_w, d_w))
        if a_w >= 960 * 10**15 and err > worst_tight[0]:  # width < ~±4% (tight)
            worst_tight = (err, (a_w, b_w, s_w, d_w))

    print(f"WORST abs err (fixed-point vs HP), all fixtures : {mp.nstr(worst[0], 4)}")
    print(f"   at (a,b,sig,dur) = {worst[1]}")
    print(f"WORST abs err on TIGHT (<±4%) fixtures          : {mp.nstr(worst_tight[0], 4)}")
    print(f"   at (a,b,sig,dur) = {worst_tight[1]}")
    bar = mp.mpf("1e-12")
    print(f"\nTARGET ≤ 1e-12 : {'PASS' if worst[0] < bar else 'FAIL'}")


if __name__ == "__main__":
    main()
