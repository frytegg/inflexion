"""Optimization sandbox for the fixed-point fairRate (gas reduction, P2.2).

Parametrised by SCALE so I can find the MINIMUM precision that still hits the
1e-12 fairRate bar (smaller scale => U256 instead of U512 multiplies => big gas
win on Stylus). Adds: adaptive Lentz continued fraction for erfc (vs fixed 80
iters), memoised ln(K) (4 distinct K, not 12-16 calls), and op counters + a
U256-feasibility check (max intermediate product < 2^256). Validated against
mpmath 50-digit truth. Once the algorithm + min scale are locked here, the Rust
port is a transliteration.

Run: quant/.venv/Scripts/python.exe quant/_scratch_fairvalue_fp2.py
"""

from __future__ import annotations

import importlib.util
import sys

import mpmath as mp

mp.mp.dps = 60
sys.path.insert(0, ".")
_hp = importlib.util.spec_from_file_location("hp", "_scratch_fairvalue_hp_reference.py")
hp = importlib.util.module_from_spec(_hp)
_hp.loader.exec_module(hp)

WAD = 10**18
SPY = 365 * 24 * 3600
U256_MAX = (1 << 256) - 1


class FP:
    """Fixed-point engine at a given SCALE, with op counters + overflow tracking."""

    def __init__(self, scale_pow: int):
        self.ONE = 10**scale_pow
        self.SCALE_POW = scale_pow
        S = self.ONE
        self.LN2 = int(mp.nint(mp.log(2) * S))
        self.SQRT2 = int(mp.nint(mp.sqrt(2) * S))
        self.SQRTPI = int(mp.nint(mp.sqrt(mp.pi) * S))
        self.TWO_OVER_SQRTPI = int(mp.nint(2 / mp.sqrt(mp.pi) * S))
        self.cnt = {}
        self.max_prod = 0  # track largest |x*y| intermediate (U256 feasibility)
        # Chebyshev coeffs a_k of P(s)=erfc(x)*x*exp(x^2), s=1/x^2, on [0,0.25],
        # evaluated by Clenshaw (coeffs O(1), no cancellation). erfc(x) =
        # P(1/x^2)*exp(-x^2)/x. u = 8s-1 maps [0,0.25]->[-1,1].
        Nn = 48
        a = []
        for k in range(16):
            tot = mp.mpf(0)
            for j in range(Nn):
                uu = mp.cos(mp.pi * (j + mp.mpf("0.5")) / Nn)
                ss = mp.mpf("0.125") * uu + mp.mpf("0.125")  # [0,0.25]
                tot += self._P_of_s(ss) * mp.cos(k * mp.pi * (j + mp.mpf("0.5")) / Nn)
            a.append((2 / mp.mpf(Nn)) * tot)
        a[0] /= 2
        self.ACHEB = [int(mp.nint(c * S)) for c in a]

    @staticmethod
    def _P_of_s(s):
        if s == 0:
            return 1 / mp.sqrt(mp.pi)
        x = 1 / mp.sqrt(s)
        return mp.erfc(x) * x * mp.exp(x * x)

    def _c(self, k):
        self.cnt[k] = self.cnt.get(k, 0) + 1

    def smul(self, x, y):
        self._c("smul")
        p = abs(x) * abs(y)
        if p > self.max_prod:
            self.max_prod = p
        s = -1 if (x < 0) ^ (y < 0) else 1
        return s * (p // self.ONE)

    def sdiv(self, x, y):
        self._c("sdiv")
        p = abs(x) * self.ONE
        if p > self.max_prod:
            self.max_prod = p
        s = -1 if (x < 0) ^ (y < 0) else 1
        return s * (p // abs(y))

    def isqrt(self, x):  # sqrt(value)*ONE = isqrt(x*ONE)
        self._c("isqrt")
        import math

        return math.isqrt(x * self.ONE)

    def iexp(self, x):
        self._c("iexp")
        ONE, LN2 = self.ONE, self.LN2
        k = (2 * x + (LN2 if x >= 0 else -LN2)) // (2 * LN2)
        r = x - k * LN2
        term = ONE
        s = ONE
        n = 1
        while True:
            term = self.smul(term, r) // n
            s += term
            if -1 < term < 1:
                break
            n += 1
            if n > 100:
                break
        return (s << k) if k >= 0 else (s >> (-k))

    def iln(self, x):
        self._c("iln")
        ONE, LN2 = self.ONE, self.LN2
        e = 0
        y = x
        while y >= 2 * ONE:
            y >>= 1
            e += 1
        while y < ONE:
            y <<= 1
            e -= 1
        u = self.sdiv(y - ONE, y + ONE)
        uu = self.smul(u, u)
        term = u
        s = u
        k = 1
        while True:
            term = self.smul(term, uu)
            add = term // (2 * k + 1)
            s += add
            if -1 < add < 1:
                break
            k += 1
            if k > 100:
                break
        return e * LN2 + 2 * s

    def erf_taylor(self, t):
        self._c("erf")
        ONE = self.ONE
        tt = self.smul(t, t)
        x = t
        s = t
        n = 1
        while True:
            x = self.smul(x, -tt) // n
            x = (x * (2 * n - 1)) // (2 * n + 1)
            s += x
            if -1 < x < 1:
                break
            n += 1
            if n > 200:
                break
        return self.smul(self.TWO_OVER_SQRTPI, s)

    def erfc_lentz(self, t):
        """erfc(t), t>1, via Lentz CF: exp(-t^2)/sqrt(pi) / D, D=t+a1/(t+a2/...)."""
        self._c("cf")
        ONE = self.ONE
        tiny = max(1, ONE >> (self.SCALE_POW // 2))
        eps = max(1, ONE >> 47)  # ~7e-15 relative stop (cf branch is low-amplification)
        f = t if t != 0 else tiny
        C = f
        D = 0
        j = 1
        iters = 0
        while True:
            a = (j * ONE) // 2  # a_j = j/2
            # D_j = 1/(t + a*D)   (scaled reciprocal)
            den = t + self.smul(a, D)
            if den == 0:
                den = tiny
            D = self.sdiv(ONE, den)
            # C_j = t + a/C
            C = t + self.sdiv(a, C)
            if C == 0:
                C = tiny
            delta = self.smul(C, D)
            f = self.smul(f, delta)
            iters += 1
            if abs(delta - ONE) < eps or j > 200:
                break
            j += 1
        self.cnt["cf_iters"] = self.cnt.get("cf_iters", 0) + iters
        tt = self.smul(t, t)
        return self.sdiv(self.sdiv(self.iexp(-tt), self.SQRTPI), f)

    def cody_erfc(self, t):
        """erfc(t), t>2, via erfc = P(1/t^2)*exp(-t^2)/t, P by Clenshaw (no division)."""
        self._c("cody")
        ONE = self.ONE
        tt = self.smul(t, t)
        s = self.sdiv(ONE, tt)  # 1/t^2  (in [0,0.25])
        u = 8 * s - ONE  # map to [-1,1]
        two_u = 2 * u
        b1 = 0
        b2 = 0
        for k in range(15, 0, -1):
            b1, b2 = self.ACHEB[k] + self.smul(two_u, b1) - b2, b1
        P = self.ACHEB[0] + self.smul(u, b1) - b2
        return self.sdiv(self.smul(P, self.iexp(-tt)), t)

    def erfc_pos(self, t):
        # crossover at t=2: erf Taylor below (exact, handles the high-amplification
        # tight tier); Cody rational erfc above (cheap, low-amplification geometries).
        if t <= 2 * self.ONE:
            return self.ONE - self.erf_taylor(t)
        return self.cody_erfc(t)

    def phi(self, d):
        self._c("phi")
        x = self.sdiv(d, self.SQRT2)
        if d >= 0:
            return self.ONE - self.erfc_pos(x) // 2
        return self.erfc_pos(-x) // 2

    def fair_rate(self, a, b, sigma, T):
        ONE = self.ONE
        sa, sb = self.isqrt(a), self.isqrt(b)
        amt0 = ONE - self.sdiv(ONE, sb)
        amt1 = ONE - sa
        il_pa = max(0, self.smul(amt0, a) + amt1 - (2 * sa - self.sdiv(a, sb) - sa))
        il_pb = max(0, self.smul(amt0, b) + amt1 - (2 * sb - self.sdiv(b, sb) - sa))
        max_il = max(il_pa, il_pb)
        a1b, a0b = amt0 - (self.sdiv(ONE, sa) - self.sdiv(ONE, sb)), amt1
        c1, c0 = amt0 + self.sdiv(ONE, sb), amt1 + sa
        a1a, a0a = amt0, amt1 - (sb - sa)
        PcapL = self.sdiv(max_il - a0b, a1b)
        PcapR = self.sdiv(max_il - a0a, a1a)
        s_t = self.smul(sigma, self.isqrt(T))
        s2t = self.smul(self.smul(sigma, sigma), T)
        half = s2t // 2
        prefH = self.iexp(-(s2t // 8))

        # Memoise ln(K) for the (few) distinct integration limits.
        _ln = {}

        def lnK(K):
            v = _ln.get(K)
            if v is None:
                v = self.iln(K)
                _ln[K] = v
            return v

        def phi_d(K, cterm):
            if K is None:
                return 0
            if K <= 0:
                return ONE
            return self.phi(self.sdiv(-lnK(K) + cterm, s_t))

        def M(k1, k2, cterm, pref):
            return self.smul(pref, phi_d(k1, cterm) - phi_d(k2, cterm))

        fp = 0
        if PcapL > 0:
            fp += self.smul(max_il, M(0, PcapL, -half, ONE)) + self.smul(a1b, M(PcapL, a, half, ONE)) + self.smul(a0b, M(PcapL, a, -half, ONE))
        else:
            fp += self.smul(a1b, M(0, a, half, ONE)) + self.smul(a0b, M(0, a, -half, ONE))
        fp += self.smul(c1, M(a, b, half, ONE)) - 2 * M(a, b, 0, prefH) + self.smul(c0, M(a, b, -half, ONE))
        if PcapR > b:
            fp += self.smul(a1a, M(b, PcapR, half, ONE)) + self.smul(a0a, M(b, PcapR, -half, ONE)) + self.smul(max_il, M(PcapR, None, -half, ONE))
        else:
            fp += self.smul(max_il, M(b, None, -half, ONE))
        return self.sdiv(fp, max_il)


def run(scale_pow: int):
    fx = hp.parse_fixtures()
    eng = FP(scale_pow)
    worst = mp.mpf(0)
    worst_tight = mp.mpf(0)
    tot = {}
    maxprod = 0
    for a_w, b_w, s_w, d_w, _ in fx:
        f = FP(scale_pow)
        a = a_w * (f.ONE // WAD)
        b = b_w * (f.ONE // WAD)
        sg = s_w * (f.ONE // WAD)
        T = (d_w * f.ONE) // SPY
        fr = f.fair_rate(a, b, sg, T)
        # round to wad
        wad = (max(0, fr) + (f.ONE // WAD) // 2) // (f.ONE // WAD)
        fr_val = mp.mpf(wad) / WAD
        truth = hp.fair_rate_hp(mp.mpf(a_w) / WAD, mp.mpf(b_w) / WAD, mp.mpf(s_w) / WAD, mp.mpf(d_w) / SPY)
        err = abs(fr_val - truth)
        if err > worst:
            worst = err
        if a_w >= 960 * 10**15 and err > worst_tight:
            worst_tight = err
        for k, v in f.cnt.items():
            tot[k] = tot.get(k, 0) + v
        if f.max_prod > maxprod:
            maxprod = f.max_prod
    n = len(fx)
    avg = {k: round(v / n) for k, v in tot.items()}
    u256_ok = maxprod <= U256_MAX
    print(f"SCALE=1e{scale_pow:<3} worst={mp.nstr(worst,3):>10} tight={mp.nstr(worst_tight,3):>10} "
          f"1e-12:{'PASS' if worst < mp.mpf('1e-12') else 'FAIL'}  "
          f"U256_fits:{u256_ok} (max_prod=2^{maxprod.bit_length()})")
    print(f"   avg ops/call: smul={avg.get('smul',0)} sdiv={avg.get('sdiv',0)} iln={avg.get('iln',0)} "
          f"iexp={avg.get('iexp',0)} erf={avg.get('erf',0)} cf={avg.get('cf',0)} cf_iters={avg.get('cf_iters',0)} phi={avg.get('phi',0)}")


if __name__ == "__main__":
    for sp in (18, 20, 22, 24, 27, 30):
        run(sp)
