"""High-precision (mpmath, 50-digit) ground truth for the FairValueOracle Φ-sum.

Purpose (P2.2 part 2): the Solidity fixtures in
``packages/contracts/test/FairValueOracle.t.sol`` were generated with float64
SciPy + the Abramowitz–Stegun erf, so they themselves carry error — amplified by
1/MaxIL at tight ranges. To prove the *Rust/Stylus* port hits machine precision
we need a reference that is ITSELF exact, not the f64 fixtures.

This script:
  1. Re-implements ``fair_rate`` (normalised P0=1, L=1) in mpmath at dps=50 —
     the same exact Φ-sum, but arbitrary precision (no f64, no A&S erf).
  2. Parses the committed Solidity fixtures, computes the HP fairRate at the
     SAME (a, b, σ, T) WAD inputs, and reports how far the committed (f64+A&S)
     values are from truth — quantifying the Solidity error the Stylus port fixes.
  3. Emits Rust-ready fixtures (a_wad, b_wad, σ_wad, dur, fairRate_wad@HP) for the
     Stylus host-side equivalence test (target ≤ 1e-12 abs vs these).

Run: quant/.venv/Scripts/python.exe quant/_scratch_fairvalue_hp_reference.py
"""

from __future__ import annotations

import re
from pathlib import Path

import mpmath as mp

mp.mp.dps = 50  # 50 significant decimal digits

WAD = mp.mpf(10) ** 18
SECONDS_PER_YEAR = mp.mpf(365 * 24 * 60 * 60)  # 365-day year (matches il.py)


def _phi(x: mp.mpf) -> mp.mpf:
    """Standard normal CDF Φ(x) = ½·erfc(−x/√2), arbitrary precision."""
    return mp.mpf("0.5") * mp.erfc(-x / mp.sqrt(2))


def _moment(p: mp.mpf, K1, K2, sigma: mp.mpf, T: mp.mpf) -> mp.mpf:
    """E[P_T^p · 1{K1<P_T<K2}] under GBM r=0, P0=1.  K≤0→Φ=1 ; K=inf→Φ=0."""
    sT = sigma * mp.sqrt(T)

    def d(K):
        if K is None:  # +inf sentinel
            return mp.mpf("-inf")
        if K <= 0:
            return mp.mpf("inf")
        return (mp.log(1 / K) + (p - mp.mpf("0.5")) * sigma * sigma * T) / sT

    pref = mp.e ** (mp.mpf("0.5") * p * (p - 1) * sigma * sigma * T)
    return pref * (_phi(d(K1)) - _phi(d(K2)))


def fair_rate_hp(a: mp.mpf, b: mp.mpf, sigma: mp.mpf, T: mp.mpf) -> mp.mpf:
    """Exact fairRate = E_Q[min(IL,MaxIL)]/MaxIL, normalised P0=1, L=1, at dps=50."""
    sa, sb = mp.sqrt(a), mp.sqrt(b)
    amt0 = 1 - 1 / sb
    amt1 = 1 - sa

    # MaxIL = max(IL(Pa), IL(Pb)) — boundary evaluation of the in-range formula.
    il_pa = max(mp.mpf(0), (amt0 * a + amt1) - (2 * sa - a / sb - sa))
    il_pb = max(mp.mpf(0), (amt0 * b + amt1) - (2 * sb - b / sb - sa))
    max_il = max(il_pa, il_pb)

    a1b, a0b = amt0 - (1 / sa - 1 / sb), amt1  # below: slope < 0
    c1, c0 = amt0 + 1 / sb, amt1 + sa  # inside: c1·P − 2√P + c0
    a1a, a0a = amt0, amt1 - (sb - sa)  # above: slope > 0

    PcapL = (max_il - a0b) / a1b
    PcapR = (max_il - a0a) / a1a

    def M0(k1, k2):
        return _moment(mp.mpf(0), k1, k2, sigma, T)

    def M1(k1, k2):
        return _moment(mp.mpf(1), k1, k2, sigma, T)

    def Mh(k1, k2):
        return _moment(mp.mpf("0.5"), k1, k2, sigma, T)

    fp = mp.mpf(0)
    # below arm (0, Pa)
    if PcapL > 0:
        fp += max_il * M0(mp.mpf(0), PcapL) + (a1b * M1(PcapL, a) + a0b * M0(PcapL, a))
    else:
        fp += a1b * M1(mp.mpf(0), a) + a0b * M0(mp.mpf(0), a)
    # inside arm (Pa, Pb) — never capped
    fp += c1 * M1(a, b) - 2 * Mh(a, b) + c0 * M0(a, b)
    # above arm (Pb, inf)  (None = +inf sentinel)
    if PcapR > b:
        fp += (a1a * M1(b, PcapR) + a0a * M0(b, PcapR)) + max_il * M0(PcapR, None)
    else:
        fp += max_il * M0(b, None)
    return fp / max_il


# ─── Parse the committed Solidity fixtures ───────────────────────────────────

TEST = Path(__file__).resolve().parent.parent / "packages/contracts/test/FairValueOracle.t.sol"


def parse_fixtures() -> list[tuple[int, int, int, int, int]]:
    txt = TEST.read_text()
    # _add( a, b, s, d, fr )  — strip underscores, allow whitespace/newlines.
    body = txt[txt.index("function setUp") :]
    out = []
    for m in re.finditer(r"_add\(\s*([0-9_]+),\s*([0-9_]+),\s*([0-9_]+),\s*([0-9_]+),\s*([0-9_]+)\s*\)", body):
        a, b, s, d, fr = (int(g.replace("_", "")) for g in m.groups())
        out.append((a, b, s, d, fr))
    return out


def main() -> None:
    fx = parse_fixtures()
    print(f"Parsed {len(fx)} fixtures from FairValueOracle.t.sol\n")
    print(f"{'a/1e18':>9} {'b/1e18':>9} {'sig':>4} {'days':>4} | {'HP fairRate':>14} | "
          f"{'sol_err':>10} | {'1/MaxIL':>8}")
    print("-" * 78)

    worst_sol = (mp.mpf(0), None)
    rust_lines: list[str] = []
    for a_w, b_w, s_w, d_w, fr_sol in fx:
        a = mp.mpf(a_w) / WAD
        b = mp.mpf(b_w) / WAD
        sigma = mp.mpf(s_w) / WAD
        T = mp.mpf(d_w) / SECONDS_PER_YEAR
        fr = fair_rate_hp(a, b, sigma, T)
        # 1/MaxIL amplification proxy (normalised V0≈1)
        sa, sb = mp.sqrt(a), mp.sqrt(b)
        amt0, amt1 = 1 - 1 / sb, 1 - sa
        il_pa = max(mp.mpf(0), (amt0 * a + amt1) - (2 * sa - a / sb - sa))
        il_pb = max(mp.mpf(0), (amt0 * b + amt1) - (2 * sb - b / sb - sa))
        max_il = max(il_pa, il_pb)
        inv_maxil = 1 / max_il

        sol_err = abs(fr - mp.mpf(fr_sol) / WAD)
        if sol_err > worst_sol[0]:
            worst_sol = (sol_err, (a_w, b_w, s_w, d_w))

        days = d_w // 86400
        print(f"{float(a):>9.5f} {float(b):>9.5f} {float(sigma):>4.1f} {days:>4d} | "
              f"{mp.nstr(fr, 12):>14} | {mp.nstr(sol_err, 3):>10} | {float(inv_maxil):>8.1f}")

        fr_wad = int(mp.nint(fr * WAD))
        rust_lines.append(f"        (uint256({a_w}), uint256({b_w}), {s_w}u64, {d_w}u64, uint256({fr_wad})),")

    print("-" * 78)
    print(f"\nWORST f64-fixture error vs HP truth: {mp.nstr(worst_sol[0], 4)}")
    print(f"  at (a,b,sig,dur) = {worst_sol[1]}")
    print("  -> f64 fixtures are NOT a valid 1e-12 ref at tight; the Stylus port")
    print("     is validated against the HP values below instead.\n")

    out_path = Path(__file__).resolve().parent / "_fairvalue_hp_fixtures.txt"
    out_path.write_text("\n".join(rust_lines) + "\n")
    print(f"Wrote {len(rust_lines)} Rust-ready HP fixtures -> {out_path.name}")


if __name__ == "__main__":
    main()
