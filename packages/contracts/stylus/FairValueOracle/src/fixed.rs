//! Integer fixed-point transcendentals at SCALE = 1e24 (`ONE`).
//!
//! Stylus rejects WASM floating point at activation, so every transcendental here
//! is pure integer arithmetic on `I256`. Faithful transliteration of the verified
//! Python prototype `quant/_scratch_fairvalue_fp2.py` (validated ≡ mpmath 50-digit
//! truth to ≤ 3.4e-16 across the domain — ≫ the 1e-12 bar).
//!
//! **Gas tuning (P2.2):** SCALE = 1e24 (not 1e36) so every product fits U256
//! (max intermediate 2^167 ≪ 2^256) — multiplies are 256-bit, not 512-bit. The
//! erfc tail (t>2) uses a Chebyshev/Clenshaw rational (`exp(−t²)·P(1/t²)/t`)
//! instead of an iterative continued fraction, eliminating ~108 divisions/call;
//! `ln` is memoised in `fairrate.rs`. Together these cut the kernel from ~463k to
//! ~60k gas while staying ~3 orders inside the 1e-12 bar (worst 6.7e-15).
//!
//! Methods: `iexp` (arg-reduce by ln2 + Taylor), `iln` (mantissa→[1,2) + atanh
//! series), `isqrt_scaled` (Newton), `erf` (Maclaurin, t≤2), `erfc` (Cody/Clenshaw
//! rational, t>2), `phi` (½·erfc, cancellation-safe).

use stylus_sdk::alloy_primitives::{I256, U256};

// ─── Constants, scaled to ONE = 1e24 (limbs little-endian, exact @40 digits) ──
pub const ONE_U: U256 = U256::from_limbs([2_003_764_205_206_896_640, 54_210, 0, 0]);
pub const ONE: I256 = I256::from_raw(ONE_U);
const LN2: I256 = I256::from_raw(U256::from_limbs([10_771_990_308_907_446_032, 37_575, 0, 0]));
const SQRT2: I256 = I256::from_raw(U256::from_limbs([12_374_706_225_983_712_665, 76_664, 0, 0]));
const TWO_OVER_SQRTPI: I256 =
    I256::from_raw(U256::from_limbs([10_278_850_773_011_097_055, 61_169, 0, 0]));

const TWO: I256 = I256::from_raw(U256::from_limbs([2, 0, 0, 0]));

// Chebyshev coeffs a_0..a_15 of P(s) = erfc(x)·x·exp(x²) on s = 1/x² ∈ [0,0.25],
// scaled 1e24, two's-complement I256 limbs (Clenshaw eval). erfc(x) =
// P(1/x²)·exp(−x²)/x for x>2 — a low-op-count rational that replaces the Lentz
// continued fraction (which spent ~108 divisions/call on the wide/asym tail).
// Generated + validated by quant/_scratch_fairvalue_fp2.py (full-surface worst
// 6.7e-15 ≪ the 1e-12 bar; this branch is low-amplification so ~1e-13 rel suffices).
const ACHEB: [I256; 16] = [
    I256::from_raw(U256::from_limbs([10177377399731141697, 29043, 0, 0])),
    I256::from_raw(U256::from_limbs([
        12430384461329019535,
        18446744073709550177,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([14053523139577134655, 92, 0, 0])),
    I256::from_raw(U256::from_limbs([
        2269033204868080380,
        18446744073709551607,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([1424549426842484884, 1, 0, 0])),
    I256::from_raw(U256::from_limbs([
        15603031660942996528,
        18446744073709551615,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([460616130896313037, 0, 0, 0])),
    I256::from_raw(U256::from_limbs([
        18364466543450759532,
        18446744073709551615,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([15921418727709011, 0, 0, 0])),
    I256::from_raw(U256::from_limbs([
        18443449002347298773,
        18446744073709551615,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([722343976040056, 0, 0, 0])),
    I256::from_raw(U256::from_limbs([
        18446577588128211743,
        18446744073709551615,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([40103925882377, 0, 0, 0])),
    I256::from_raw(U256::from_limbs([
        18446734025547407359,
        18446744073709551615,
        18446744073709551615,
        18446744073709551615,
    ])),
    I256::from_raw(U256::from_limbs([2608275913300, 0, 0, 0])),
    I256::from_raw(U256::from_limbs([
        18446743374598495576,
        18446744073709551615,
        18446744073709551615,
        18446744073709551615,
    ])),
];

#[inline]
fn i(v: u64) -> I256 {
    I256::from_raw(U256::from_limbs([v, 0, 0, 0]))
}

// ─── fixed-point multiply / divide (U256 — no U512; products fit, see header) ──
/// `(x·y)/ONE`, truncated toward zero.
#[inline]
pub fn smul(x: I256, y: I256) -> I256 {
    let neg = x.is_negative() ^ y.is_negative();
    let q = I256::from_raw(x.unsigned_abs() * y.unsigned_abs() / ONE_U);
    if neg {
        -q
    } else {
        q
    }
}

/// `(x·ONE)/y`, truncated toward zero.
#[inline]
pub fn sdiv(x: I256, y: I256) -> I256 {
    let neg = x.is_negative() ^ y.is_negative();
    let q = I256::from_raw(x.unsigned_abs() * ONE_U / y.unsigned_abs());
    if neg {
        -q
    } else {
        q
    }
}

// ─── isqrt ────────────────────────────────────────────────────────────────────
fn integer_sqrt(n: U256) -> U256 {
    if n.is_zero() {
        return U256::ZERO;
    }
    let bits = 256 - n.leading_zeros();
    let mut x = U256::from(1u8) << ((bits + 1) / 2);
    loop {
        let next = (x + n / x) >> 1;
        if next >= x {
            break;
        }
        x = next;
    }
    x
}

/// `sqrt(value)·ONE` where `value = x/ONE` (x ≥ 0)  ⇒  `isqrt(x·ONE)`.
pub fn isqrt_scaled(x: I256) -> I256 {
    I256::from_raw(integer_sqrt(x.into_raw() * ONE_U))
}

// ─── exp ──────────────────────────────────────────────────────────────────────
/// `e^x` in fixed point. Arg-reduce by ln2, Taylor on the remainder, scale 2^k.
pub fn iexp(x: I256) -> I256 {
    let bias = if x.is_negative() { -LN2 } else { LN2 };
    let k = (x * TWO + bias) / (LN2 * TWO);
    let r = x - k * LN2;
    let mut term = ONE;
    let mut s = ONE;
    let mut n: u64 = 1;
    loop {
        term = smul(term, r) / i(n);
        s += term;
        if term > -i(1) && term < i(1) {
            break;
        }
        n += 1;
        if n > 100 {
            break;
        }
    }
    let su = s.into_raw();
    let kshift = k.unsigned_abs().as_limbs()[0] as usize; // |k| < 256
    I256::from_raw(if k.is_negative() {
        su >> kshift
    } else {
        su << kshift
    })
}

// ─── ln ───────────────────────────────────────────────────────────────────────
/// `ln(value)`, `value = x/ONE > 0`. Normalise mantissa to [1,2), atanh series.
pub fn iln(x: I256) -> I256 {
    debug_assert!(x.is_positive());
    let mut y = x.into_raw();
    let two_one = ONE_U << 1;
    let mut e: i64 = 0;
    while y >= two_one {
        y >>= 1;
        e += 1;
    }
    while y < ONE_U {
        y <<= 1;
        e -= 1;
    }
    let ym = I256::from_raw(y);
    let u = sdiv(ym - ONE, ym + ONE);
    let uu = smul(u, u);
    let mut term = u;
    let mut s = u;
    let mut k: u64 = 1;
    loop {
        term = smul(term, uu);
        let add = term / i(2 * k + 1);
        s += add;
        if add > -i(1) && add < i(1) {
            break;
        }
        k += 1;
        if k > 100 {
            break;
        }
    }
    i(e.unsigned_abs()) * if e < 0 { -LN2 } else { LN2 } + TWO * s
}

// ─── erf / erfc / Φ ──────────────────────────────────────────────────────────
/// `erf(t)` for 0 ≤ t ≤ 2 via Maclaurin series.
fn erf_taylor(t: I256) -> I256 {
    let tt = smul(t, t);
    let mut x = t;
    let mut s = t;
    let mut n: u64 = 1;
    loop {
        // xₙ = xₙ₋₁·(−t²)·(2n−1)/(n·(2n+1)) — ONE division (variable divisor is the
        // expensive op; folding the two divides halves them in this hot loop).
        x = smul(x, -tt) * i(2 * n - 1) / i(n * (2 * n + 1));
        s += x;
        if x > -i(1) && x < i(1) {
            break;
        }
        n += 1;
        if n > 200 {
            break;
        }
    }
    smul(TWO_OVER_SQRTPI, s)
}

/// `erfc(t)` for t > 2 via `erfc = P(1/t²)·exp(−t²)/t`, where `P(s)` is the
/// Chebyshev polynomial [`ACHEB`] evaluated by Clenshaw recurrence (16 coeffs,
/// no per-term division, no cancellation). ~17 muls + 2 divisions + 1 exp —
/// replacing the Lentz continued fraction's ~108 divisions on the tail.
fn cody_erfc(t: I256) -> I256 {
    let tt = smul(t, t);
    let s = sdiv(ONE, tt); // 1/t² ∈ [0, 0.25]
    let u = i(8) * s - ONE; // map [0,0.25] → [−1,1]
    let two_u = TWO * u;
    let mut b1 = I256::ZERO;
    let mut b2 = I256::ZERO;
    for k in (1..16).rev() {
        let nb = ACHEB[k] + smul(two_u, b1) - b2;
        b2 = b1;
        b1 = nb;
    }
    let p = ACHEB[0] + smul(u, b1) - b2;
    sdiv(smul(p, iexp(-tt)), t)
}

/// `erfc(t)` for t ≥ 0. Taylor below the t=2 crossover (exact, handles the
/// high-amplification tight tier); Cody rational above (cheap; the wide/asym
/// geometries that reach it are low-amplification, so ~1e-13 rel suffices).
pub fn erfc_pos(t: I256) -> I256 {
    if t <= TWO * ONE {
        ONE - erf_taylor(t)
    } else {
        cody_erfc(t)
    }
}

/// Standard normal CDF `Φ(d) = ½·erfc(−d/√2)`, assembled so both terms stay
/// un-saturated (no catastrophic cancellation).
pub fn phi(d: I256) -> I256 {
    let x = sdiv(d, SQRT2);
    if d.is_negative() {
        erfc_pos(-x) / TWO
    } else {
        ONE - erfc_pos(x) / TWO
    }
}

// ─── host-only unit tests for the primitives (never reach the WASM) ───────────
#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: I256, b: I256, tol: i128) -> bool {
        let d = if a > b { a - b } else { b - a };
        d <= I256::try_from(tol).unwrap()
    }

    #[test]
    fn exp_known_values() {
        assert!(close(iexp(I256::ZERO), ONE, 0));
        let e1: I256 = "2718281828459045235360287".parse().unwrap();
        assert!(close(iexp(ONE), e1, 1_000_000i128));
        let em2: I256 = "135335283236612691893999".parse().unwrap();
        assert!(close(iexp(-TWO * ONE), em2, 1_000_000i128));
    }

    #[test]
    fn ln_known_values() {
        assert!(close(iln(TWO * ONE), LN2, 1_000_000i128));
        assert!(close(iln(ONE / TWO), -LN2, 1_000_000i128));
        assert!(close(iln(ONE), I256::ZERO, 1_000i128));
    }

    #[test]
    fn sqrt_known_values() {
        assert!(close(isqrt_scaled(i(4) * ONE), TWO * ONE, 0));
        assert!(close(isqrt_scaled(TWO * ONE), SQRT2, 1_000i128));
    }

    #[test]
    fn erf_known_values() {
        let e1: I256 = "842700792949714869341221".parse().unwrap();
        assert!(close(erf_taylor(ONE), e1, 1_000_000i128));
        let eh: I256 = "520499877813046537682747".parse().unwrap();
        assert!(close(erf_taylor(ONE / TWO), eh, 1_000_000i128));
    }

    #[test]
    fn phi_known_values() {
        assert!(close(phi(I256::ZERO), ONE / TWO, 0));
        let d196 = i(196) * ONE / i(100);
        let p: I256 = "975002104851779565863416".parse().unwrap();
        assert!(close(phi(d196), p, 1_000_000i128));
        let pn: I256 = "24997895148220434136584".parse().unwrap();
        assert!(close(phi(-d196), pn, 1_000_000i128));
    }

    #[test]
    fn erfc_tail_branch() {
        // erfc(3) = 2.2090496998585441e-5 (exercises the Lentz CF branch).
        let got = erfc_pos(i(3) * ONE);
        let want: I256 = "22090496998585441373".parse().unwrap();
        assert!(close(got, want, 1_000_000i128));
    }
}
