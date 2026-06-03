//! The exact `fairRate` Φ-sum (mirror of `inflexion_quant.cvamm.fair_rate` and
//! `packages/contracts/src/FairValueOracle.sol`), computed in 1e24 fixed point.
//!
//! `fairRate = E_Q[min(IL, MaxIL)] / MaxIL`, the finite Φ-sum over the piecewise
//! v3 capped payoff (below Pa linear/capped, inside [Pa,Pb] convex, above Pb
//! linear/capped) in normalised units (P0=1, L=1). The ABI is WAD (1e18) in/out
//! to match the Solidity `IFairValueOracle`; internally we lift to 1e24.
//!
//! Gas: the integration limits are K ∈ {0, a, b, PcapL, PcapR, +∞}. The two
//! sentinels are Φ-constants; `ln(K)` for the ≤4 finite limits is computed ONCE
//! and reused across M0/M1/Mh (the `Lim::Fin` payload) — `iln` is the single most
//! expensive primitive, so memoising it is a large win.

use stylus_sdk::alloy_primitives::{I256, U256};

use crate::fixed::{iexp, iln, isqrt_scaled, phi, sdiv, smul, ONE};

/// Revert reasons (mapped to custom errors in `lib.rs`).
#[derive(Debug, PartialEq, Eq)]
pub enum FvErr {
    /// `a ≥ 1e18 || b ≤ 1e18` — needs `Pa < P0 < Pb` (in-range gate).
    OutOfRange,
    /// `sigma == 0 || duration == 0`, or a degenerate MaxIL.
    BadParam,
}

// WAD (1e18) → ONE (1e24) lift factor (1e6), and the WAD unit / rounding half.
const WAD_TO_ONE: I256 = I256::from_raw(U256::from_limbs([1_000_000, 0, 0, 0]));
const WAD_U: U256 = U256::from_limbs([1_000_000_000_000_000_000, 0, 0, 0]);
const HALF_LIFT: I256 = I256::from_raw(U256::from_limbs([500_000, 0, 0, 0]));
const SECONDS_PER_YEAR: I256 = I256::from_raw(U256::from_limbs([31_536_000, 0, 0, 0]));

#[inline]
fn i2(v: u64) -> I256 {
    I256::from_raw(U256::from_limbs([v, 0, 0, 0]))
}

#[inline]
fn maxi(a: I256, b: I256) -> I256 {
    if a > b {
        a
    } else {
        b
    }
}

/// An integration limit: a Φ-constant sentinel, or a finite price carrying its
/// precomputed `ln(K)` (so `iln` runs once per distinct limit, not per moment).
enum Lim {
    Zero, // K = 0   → Φ(d) = 1
    Inf,  // K = +∞  → Φ(d) = 0
    Fin(I256),
}

#[inline]
fn phi_for(l: &Lim, s_t: I256, cterm: I256) -> I256 {
    match l {
        Lim::Zero => ONE,
        Lim::Inf => I256::ZERO,
        Lim::Fin(ln_k) => phi(sdiv(-*ln_k + cterm, s_t)),
    }
}

/// `pref · (Φ(d(K1)) − Φ(d(K2)))`.
#[inline]
fn moment(l1: &Lim, l2: &Lim, s_t: I256, cterm: I256, pref: I256) -> I256 {
    smul(pref, phi_for(l1, s_t, cterm) - phi_for(l2, s_t, cterm))
}

/// fairRate in 1e24 fixed point. `a`,`b`,`sigma` are 1e24-scaled; `t` = years (1e24).
pub fn fair_rate_one(a: I256, b: I256, sigma: I256, t: I256) -> Result<I256, FvErr> {
    let sa = isqrt_scaled(a);
    let sb = isqrt_scaled(b);
    let amt0 = ONE - sdiv(ONE, sb);
    let amt1 = ONE - sa;

    let il_pa = maxi(
        I256::ZERO,
        smul(amt0, a) + amt1 - (i2(2) * sa - sdiv(a, sb) - sa),
    );
    let il_pb = maxi(
        I256::ZERO,
        smul(amt0, b) + amt1 - (i2(2) * sb - sdiv(b, sb) - sa),
    );
    let max_il = maxi(il_pa, il_pb);
    if !max_il.is_positive() {
        return Err(FvErr::BadParam);
    }

    let a1b = amt0 - (sdiv(ONE, sa) - sdiv(ONE, sb)); // below slope (<0)
    let a0b = amt1;
    let c1 = amt0 + sdiv(ONE, sb); // inside: c1·P − 2√P + c0
    let c0 = amt1 + sa;
    let a1a = amt0; // above slope (>0)
    let a0a = amt1 - (sb - sa);

    let pcap_l = sdiv(max_il - a0b, a1b);
    let pcap_r = sdiv(max_il - a0a, a1a);

    let s_t = smul(sigma, isqrt_scaled(t)); // σ√T
    if !s_t.is_positive() {
        return Err(FvErr::BadParam);
    }
    let s2t = smul(smul(sigma, sigma), t); // σ²T
    let half = s2t / i2(2);
    let pref_h = iexp(-(s2t / i2(8))); // exp(−σ²T/8)

    // Precompute ln(K) once for each finite limit (Φ-sentinels need no ln).
    let la = Lim::Fin(iln(a));
    let lb = Lim::Fin(iln(b));

    // ── below arm (0, Pa)
    let below = if pcap_l.is_positive() {
        let lpl = Lim::Fin(iln(pcap_l));
        smul(max_il, moment(&Lim::Zero, &lpl, s_t, -half, ONE))
            + smul(a1b, moment(&lpl, &la, s_t, half, ONE))
            + smul(a0b, moment(&lpl, &la, s_t, -half, ONE))
    } else {
        smul(a1b, moment(&Lim::Zero, &la, s_t, half, ONE))
            + smul(a0b, moment(&Lim::Zero, &la, s_t, -half, ONE))
    };

    // ── inside arm (Pa, Pb): c1·M1 − 2·Mh + c0·M0
    let inside = smul(c1, moment(&la, &lb, s_t, half, ONE))
        - i2(2) * moment(&la, &lb, s_t, I256::ZERO, pref_h)
        + smul(c0, moment(&la, &lb, s_t, -half, ONE));

    // ── above arm (Pb, ∞)
    let above = if pcap_r > b {
        let lpr = Lim::Fin(iln(pcap_r));
        smul(a1a, moment(&lb, &lpr, s_t, half, ONE))
            + smul(a0a, moment(&lb, &lpr, s_t, -half, ONE))
            + smul(max_il, moment(&lpr, &Lim::Inf, s_t, -half, ONE))
    } else {
        smul(max_il, moment(&lb, &Lim::Inf, s_t, -half, ONE))
    };

    Ok(sdiv(below + inside + above, max_il))
}

/// Public WAD-in/WAD-out entry. `a`,`b`,`sigma` are WAD (1e18); `dur` seconds.
/// Mirrors `FairValueOracle.fairRate(a, b, sigma, durationSeconds)`.
pub fn fair_rate_wad(a_wad: U256, b_wad: U256, sigma_wad: U256, dur: U256) -> Result<U256, FvErr> {
    if a_wad >= WAD_U || b_wad <= WAD_U {
        return Err(FvErr::OutOfRange);
    }
    if sigma_wad.is_zero() || dur.is_zero() {
        return Err(FvErr::BadParam);
    }

    let a = I256::from_raw(a_wad) * WAD_TO_ONE;
    let b = I256::from_raw(b_wad) * WAD_TO_ONE;
    let sigma = I256::from_raw(sigma_wad) * WAD_TO_ONE;
    // T (years) in 1e24: dur (a plain seconds count) · ONE / SECONDS_PER_YEAR.
    let t = sdiv(I256::from_raw(dur), SECONDS_PER_YEAR);

    let fr = maxi(I256::ZERO, fair_rate_one(a, b, sigma, t)?);
    // round 1e24 → 1e18 (half-up): (fr + 5e5) / 1e6.
    let wad = (fr + HALF_LIFT) / WAD_TO_ONE;
    Ok(wad.into_raw())
}

// ─── host-only equivalence tests vs mpmath 50-digit fixtures ──────────────────
#[cfg(test)]
mod tests {
    use super::*;

    // (a_wad, b_wad, sigma_wad, dur_secs, fairRate_wad@HP) — generated by
    // quant/_scratch_fairvalue_hp_reference.py (mpmath dps=50).
    include!("fixtures_hp.rs");

    #[test]
    fn matches_mpmath_hp_to_machine_precision() {
        let mut worst: i128 = 0;
        let mut worst_tight: i128 = 0;
        for &(a, b, s, d, fr) in HP_FIXTURES.iter() {
            let got =
                fair_rate_wad(U256::from(a), U256::from(b), U256::from(s), U256::from(d)).unwrap();
            let want = U256::from(fr);
            let diff: U256 = if got > want { got - want } else { want - got };
            let diff_i = i128::try_from(diff).unwrap();
            if diff_i > worst {
                worst = diff_i;
            }
            if a >= 960_000_000_000_000_000u128 && diff_i > worst_tight {
                worst_tight = diff_i;
            }
            // ≤ 1e-12 absolute on fairRate == ≤ 1e6 wei (1e18 scale).
            assert!(
                diff_i <= 1_000_000,
                "fairRate vs HP exceeds 1e-12: diff={diff_i} wei at a={a}"
            );
        }
        println!("worst diff vs mpmath HP (wei, 1e18): {worst}");
        println!("worst diff on tight <±4% tier (wei): {worst_tight}");
        assert!(worst <= 1_000_000);
    }

    #[test]
    fn out_of_range_reverts() {
        let one = 1_000_000_000_000_000_000u128;
        let s = 600_000_000_000_000_000u128;
        assert_eq!(
            fair_rate_wad(
                U256::from(one),
                U256::from(2 * one),
                U256::from(s),
                U256::from(2_592_000u64)
            ),
            Err(FvErr::OutOfRange)
        );
        assert_eq!(
            fair_rate_wad(
                U256::from(one / 2),
                U256::from(one),
                U256::from(s),
                U256::from(2_592_000u64)
            ),
            Err(FvErr::OutOfRange)
        );
    }
}
