//! Pure fixed-point IL / MaxIL math (Uniswap v3, Q64.96).
//!
//! Faithful port of `packages/contracts/src/ILMath.sol`: identical `mul_div`
//! chain and floor rounding, so the Stylus and Solidity implementations agree
//! to the wei (Task 2.11 cross-check). Spec §3.1 (realized IL), §3.2
//! (MaxIL = boundary max via convexity).
//!
//! All sqrt-price inputs are Q64.96 (`sqrtPriceX96`); IL is returned in token1
//! wei (the numéraire). No allocation, no syscalls — safe to compile into the
//! WASM contract; the `#[cfg(test)]` oracle (`num-bigint`/`proptest`) is
//! host-only and never reaches the binary.

use stylus_sdk::alloy_primitives::U256;

/// 512-bit accumulator for the widening multiply inside [`mul_div`].
type U512 = stylus_sdk::alloy_primitives::Uint<512, 8>;

/// `Q96 = 2^96`, the Q64.96 normalisation constant.
#[inline]
fn q96() -> U256 {
    U256::from(1u128) << 96usize
}

// ─── Primitives (Task 2.2) ──────────────────────────────────────────────

/// Zero-extend a 256-bit value into the 512-bit accumulator.
#[inline]
fn to_u512(x: U256) -> U512 {
    let mut buf = [0u8; 64];
    buf[32..].copy_from_slice(&x.to_be_bytes::<32>());
    U512::from_be_bytes::<64>(buf)
}

/// Narrow a 512-bit value back to 256 bits. The high half must be zero —
/// guaranteed for every call site in this crate (token amounts and IL are
/// bounded well under 2^256). The `debug_assert` catches a violated bound in
/// tests; it compiles out of the release WASM.
#[inline]
fn from_u512(x: U512) -> U256 {
    let bytes = x.to_be_bytes::<64>();
    debug_assert!(
        bytes[..32].iter().all(|&b| b == 0),
        "mul_div: result exceeds 256 bits"
    );
    U256::from_be_slice(&bytes[32..])
}

/// `floor(a * b / denom)` — the equivalent of OpenZeppelin `Math.mulDiv` /
/// Uniswap `FullMath.mulDiv`. Panics on `denom == 0` (mirrors the Solidity
/// divide-by-zero revert).
///
/// **Fast path (the common case):** when `a * b` fits in 256 bits — which it
/// does for every in-protocol call (`liquidity · Δsqrt ≈ 2^156`, `amount · 2^96`,
/// etc.) — the result is computed in pure U256, skipping the 512-bit widening
/// (two byte-buffer copies) and the 512-bit division (≈ 8× a 256-bit one). This
/// is **wei-identical** to the full-width form: floor division agrees whenever
/// the product does not overflow 256 bits. The 512-bit path remains only as the
/// exact fallback for a genuine `a · b ≥ 2^256` (exercised by the proptest
/// oracle), so the cross-check against `ILMath.sol` is unchanged.
#[inline]
pub fn mul_div(a: U256, b: U256, denom: U256) -> U256 {
    if let Some(product) = a.checked_mul(b) {
        return product / denom;
    }
    let product = to_u512(a) * to_u512(b);
    from_u512(product / to_u512(denom))
}

/// `floor(sqrt(n))` via Newton's method. Converges monotonically from an
/// over-estimate, so the result is exact for all `n`.
// Host/test-only primitive — the contract takes sqrtPriceX96 as input and
// never derives it on-chain; LTO drops this from the WASM.
#[allow(dead_code)]
pub fn integer_sqrt(n: U256) -> U256 {
    if n.is_zero() {
        return U256::ZERO;
    }
    let bits = n.bit_len();
    let mut x = U256::from(1u8) << ((bits + 1) / 2);
    loop {
        let next = (x + n / x) >> 1usize;
        if next >= x {
            break;
        }
        x = next;
    }
    x
}

/// `sqrtPriceX96 = floor(sqrt(price) * 2^96) = floor(sqrt(price << 192))`.
#[allow(dead_code)] // host/test-only (see `integer_sqrt`)
pub fn sqrt_price_x96(price: U256) -> U256 {
    integer_sqrt(price << 192usize)
}

/// `|a - b|` without underflow.
#[allow(dead_code)] // host/test-only (see `integer_sqrt`)
pub fn abs_diff(a: U256, b: U256) -> U256 {
    if a > b {
        a - b
    } else {
        b - a
    }
}

// ─── v3 position amounts ────────────────────────────────────────────────

/// Token amounts held by `liquidity` at `sqrt_p`, for the range
/// `[sqrt_pa, sqrt_pb]`. Caller guarantees `sqrt_pa ≤ sqrt_p ≤ sqrt_pb`.
/// Whitepaper §6.30, evaluated with [`mul_div`].
#[inline]
pub fn amounts_at(sqrt_p: U256, sqrt_pa: U256, sqrt_pb: U256, liquidity: U256) -> (U256, U256) {
    let q = q96();
    let mut t = mul_div(liquidity, sqrt_pb - sqrt_p, q);
    t = mul_div(t, q, sqrt_p);
    let amount0 = mul_div(t, q, sqrt_pb);

    let amount1 = mul_div(liquidity, sqrt_p - sqrt_pa, q);
    (amount0, amount1)
}

/// `amount0` (token0 wei) valued in token1 wei at `sqrt_p`:
/// `amount0 * (sqrt_p / 2^96)^2`.
#[inline]
pub fn amount0_in_token1(amount0: U256, sqrt_p: U256) -> U256 {
    let q = q96();
    let step = mul_div(amount0, sqrt_p, q);
    mul_div(step, sqrt_p, q)
}

/// token0 amount of the whole range when price is at (or below) `sqrt_pa`
/// — the position is then 100% token0.
#[inline]
pub fn amount0_boundary(sqrt_pa: U256, sqrt_pb: U256, liquidity: U256) -> U256 {
    let q = q96();
    let mut t = mul_div(liquidity, sqrt_pb - sqrt_pa, q);
    t = mul_div(t, q, sqrt_pa);
    mul_div(t, q, sqrt_pb)
}

/// token1 amount of the whole range when price is at (or above) `sqrt_pb`
/// — the position is then 100% token1.
#[inline]
pub fn amount1_boundary(sqrt_pa: U256, sqrt_pb: U256, liquidity: U256) -> U256 {
    mul_div(liquidity, sqrt_pb - sqrt_pa, q96())
}

// ─── Position value & realized IL (Task 2.5–2.7) ────────────────────────

/// `V_lp(P_T)` in token1 wei — the value of the LP position at settlement
/// price `sqrt_pt`. Three regimes: below `Pa` (all token0), above `Pb`
/// (all token1), in range otherwise.
#[inline]
pub fn v_lp(sqrt_pt: U256, sqrt_pa: U256, sqrt_pb: U256, liquidity: U256) -> U256 {
    if sqrt_pt < sqrt_pa {
        let a0_at_pa = amount0_boundary(sqrt_pa, sqrt_pb, liquidity);
        return amount0_in_token1(a0_at_pa, sqrt_pt);
    }
    if sqrt_pt > sqrt_pb {
        return amount1_boundary(sqrt_pa, sqrt_pb, liquidity);
    }
    let (a0, a1) = amounts_at(sqrt_pt, sqrt_pa, sqrt_pb, liquidity);
    amount0_in_token1(a0, sqrt_pt) + a1
}

/// `V_hold(P_T) = amount0_entry · P_T + amount1_entry` in token1 wei.
#[inline]
pub fn v_hold(amount0_entry: U256, amount1_entry: U256, sqrt_pt: U256) -> U256 {
    amount0_in_token1(amount0_entry, sqrt_pt) + amount1_entry
}

/// Realized IL at settlement: `max(0, V_hold − V_lp)` (invariant I3 — the
/// subtraction is guarded, never an unchecked underflow).
#[inline]
pub fn il_at(
    sqrt_pt: U256,
    sqrt_pa: U256,
    sqrt_pb: U256,
    liquidity: U256,
    amount0_entry: U256,
    amount1_entry: U256,
) -> U256 {
    let value_lp = v_lp(sqrt_pt, sqrt_pa, sqrt_pb, liquidity);
    let value_hold = v_hold(amount0_entry, amount1_entry, sqrt_pt);
    if value_hold > value_lp {
        value_hold - value_lp
    } else {
        U256::ZERO
    }
}

/// `MaxIL = max(IL(Pa), IL(Pb))` (spec §3.2). Returns `None` when the entry
/// price is out of range (`sqrt_price ∉ [sqrt_pa, sqrt_pb]`) — the caller
/// surfaces that as a `PositionOutOfRange` revert. IL is convex on `[Pa,Pb]`
/// so the maximum is always at a boundary.
pub fn compute_max_il(
    sqrt_price: U256,
    sqrt_pa: U256,
    sqrt_pb: U256,
    liquidity: U256,
) -> Option<U256> {
    if sqrt_price < sqrt_pa || sqrt_price > sqrt_pb {
        return None;
    }
    let (a0_entry, a1_entry) = amounts_at(sqrt_price, sqrt_pa, sqrt_pb, liquidity);
    let il_pa = il_at(sqrt_pa, sqrt_pa, sqrt_pb, liquidity, a0_entry, a1_entry);
    let il_pb = il_at(sqrt_pb, sqrt_pa, sqrt_pb, liquidity, a0_entry, a1_entry);
    Some(if il_pa > il_pb { il_pa } else { il_pb })
}

// ════════════════════════════════════════════════════════════════════════
//  Host-only test suite (Tasks 2.2, 2.4–2.9). Never compiled into the WASM.
// ════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigUint;
    use proptest::prelude::*;

    // ─── num-bigint bridge (arbitrary-precision oracle) ─────────────────

    fn to_big(x: U256) -> BigUint {
        BigUint::from_bytes_be(&x.to_be_bytes::<32>())
    }

    fn from_big(x: &BigUint) -> U256 {
        let bytes = x.to_bytes_be();
        assert!(bytes.len() <= 32, "bigint exceeds 256 bits");
        let mut buf = [0u8; 32];
        buf[32 - bytes.len()..].copy_from_slice(&bytes);
        U256::from_be_bytes::<32>(buf)
    }

    fn u256_strategy() -> impl Strategy<Value = U256> {
        proptest::array::uniform32(any::<u8>()).prop_map(|b| U256::from_be_bytes::<32>(b))
    }

    // ─── Fixture helpers (Python il.py: P0=100, Pa=80, Pb=125) ──────────

    const L: u128 = 1_000_000_000_000_000_000; // 1e18

    fn lv() -> U256 {
        U256::from(L)
    }
    fn sp(price: u64) -> U256 {
        sqrt_price_x96(U256::from(price))
    }
    fn entry(p0: u64, pa: u64, pb: u64) -> (U256, U256) {
        amounts_at(sp(p0), sp(pa), sp(pb), lv())
    }
    fn il(pt: u64, pa: u64, pb: u64, a0: U256, a1: U256) -> U256 {
        il_at(sp(pt), sp(pa), sp(pb), lv(), a0, a1)
    }
    fn maxil(p0: u64, pa: u64, pb: u64) -> U256 {
        compute_max_il(sp(p0), sp(pa), sp(pb), lv()).unwrap()
    }
    fn close(actual: U256, expected: U256, tol: u128) -> bool {
        abs_diff(actual, expected) <= U256::from(tol)
    }
    fn ordered(a: u64, b: u64) -> (u64, u64) {
        if a < b {
            (a, b)
        } else if a > b {
            (b, a)
        } else {
            (a, a + 1)
        }
    }

    // ─── Task 2.2 — primitive property tests vs num-bigint (10k cases) ──

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// mul_div over the u128×u128 domain (product always < 2^256).
        #[test]
        fn prop_mul_div_u128_domain(a in any::<u128>(), b in any::<u128>(), d in 1u128..=u128::MAX) {
            let (au, bu, du) = (U256::from(a), U256::from(b), U256::from(d));
            let got = mul_div(au, bu, du);
            let want = from_big(&(to_big(au) * to_big(bu) / to_big(du)));
            prop_assert_eq!(got, want);
        }

        /// mul_div with a genuine 512-bit intermediate. `denom = max(a,b)+1`
        /// keeps the quotient < 2^256, so the 256-bit result stays exact.
        #[test]
        fn prop_mul_div_wide_product(a in u256_strategy(), b in u256_strategy()) {
            let denom = a.max(b).saturating_add(U256::from(1u8));
            let got = mul_div(a, b, denom);
            let want = from_big(&(to_big(a) * to_big(b) / to_big(denom)));
            prop_assert_eq!(got, want);
        }

        /// integer_sqrt brackets: `s² ≤ n < (s+1)²` (checked in bigint).
        #[test]
        fn prop_integer_sqrt_brackets(n in u256_strategy()) {
            let s = integer_sqrt(n);
            let sb = to_big(s);
            let nb = to_big(n);
            prop_assert!(&sb * &sb <= nb, "s^2 > n");
            let s1 = &sb + &BigUint::from(1u32);
            prop_assert!(&s1 * &s1 > nb, "(s+1)^2 <= n");
        }

        /// abs_diff matches the bigint reference.
        #[test]
        fn prop_abs_diff(a in u256_strategy(), b in u256_strategy()) {
            let got = abs_diff(a, b);
            let (ab, bb) = (to_big(a), to_big(b));
            let want = if ab >= bb { &ab - &bb } else { &bb - &ab };
            prop_assert_eq!(got, from_big(&want));
        }
    }

    // ─── Task 2.8 / 2.9 — IL fuzz (2k cases) ────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_000))]

        /// Cap (convexity): in-range realized IL never exceeds MaxIL.
        #[test]
        fn fuzz_cap_holds_in_range(
            x in 1u64..10_000,
            y in 1u64..10_000,
            p0_seed in 0u64..10_000,
            pt_seed in 0u64..10_000,
        ) {
            let (pa_p, pb_p) = ordered(x, y);
            let span = pb_p - pa_p;
            let p0_p = pa_p + p0_seed % (span + 1);
            let pt_p = pa_p + pt_seed % (span + 1);
            let (a0, a1) = entry(p0_p, pa_p, pb_p);
            let mx = maxil(p0_p, pa_p, pb_p);
            let realized = il(pt_p, pa_p, pb_p, a0, a1);
            prop_assert!(realized <= mx + U256::from(1_000_000u64),
                "IL {} exceeded MaxIL {} (range [{},{}] entry {} settle {})",
                realized, mx, pa_p, pb_p, p0_p, pt_p);
        }

        /// Asymmetric entry: MaxIL == max(IL(Pa), IL(Pb)) for any valid range.
        #[test]
        fn fuzz_asymmetric_entry_maxil(
            x in 1u64..10_000,
            y in 1u64..10_000,
            p0_seed in 0u64..10_000,
        ) {
            let (pa_p, pb_p) = ordered(x, y);
            let span = pb_p - pa_p;
            let p0_p = pa_p + p0_seed % (span + 1);
            let (a0, a1) = entry(p0_p, pa_p, pb_p);
            let mx = maxil(p0_p, pa_p, pb_p);
            let il_pa = il(pa_p, pa_p, pb_p, a0, a1);
            let il_pb = il(pb_p, pa_p, pb_p, a0, a1);
            prop_assert_eq!(mx, if il_pa > il_pb { il_pa } else { il_pb });
        }
    }

    // ─── Task 2.3/2.4 — fixtures + MaxIL hand-calc suite ────────────────

    #[test]
    fn amounts_fixture_matches_python() {
        let (a0, a1) = entry(100, 80, 125);
        assert!(
            close(a0, U256::from(10_557_280_900_008_417u128), 100),
            "amount0: {a0}"
        );
        assert!(
            close(a1, U256::from(1_055_728_090_000_841_200u128), 100),
            "amount1: {a1}"
        );
    }

    #[test]
    fn maxil_fixture_matches_python() {
        // Python il.py MaxIL = 139.32022500210132 → ×1e15 at L=1e18.
        let mx = maxil(100, 80, 125);
        assert!(
            close(mx, U256::from(139_320_225_002_101_320u128), 10_000),
            "MaxIL: {mx}"
        );
    }

    #[test]
    fn maxil_equals_boundary_max() {
        let (a0, a1) = entry(100, 80, 125);
        let il_pa = il(80, 80, 125, a0, a1);
        let il_pb = il(125, 80, 125, a0, a1);
        assert_eq!(
            maxil(100, 80, 125),
            if il_pa > il_pb { il_pa } else { il_pb }
        );
    }

    #[test]
    fn maxil_pb_dominates_upward_asymmetry() {
        // [80,125] entered at 100: IL is larger at the upper boundary.
        let (a0, a1) = entry(100, 80, 125);
        let il_pa = il(80, 80, 125, a0, a1);
        let il_pb = il(125, 80, 125, a0, a1);
        assert!(
            il_pb > il_pa,
            "Pb should dominate: il_pa={il_pa} il_pb={il_pb}"
        );
        assert_eq!(maxil(100, 80, 125), il_pb);
    }

    #[test]
    fn maxil_pa_dominates_when_entered_near_top() {
        // Entered at 120 (near Pb=125): the down-move to Pa=80 is the big loss.
        let (a0, a1) = entry(120, 80, 125);
        let il_pa = il(80, 80, 125, a0, a1);
        let il_pb = il(125, 80, 125, a0, a1);
        assert!(
            il_pa > il_pb,
            "Pa should dominate: il_pa={il_pa} il_pb={il_pb}"
        );
        assert_eq!(maxil(120, 80, 125), il_pa);
    }

    #[test]
    fn maxil_positive_for_off_center() {
        assert!(maxil(100, 80, 125) > U256::ZERO);
        assert!(maxil(120, 80, 125) > U256::ZERO);
        assert!(maxil(85, 80, 125) > U256::ZERO);
    }

    #[test]
    fn maxil_scales_linearly_in_l() {
        let mx1 = compute_max_il(sp(100), sp(80), sp(125), lv()).unwrap();
        let mx2 = compute_max_il(sp(100), sp(80), sp(125), lv() * U256::from(2u8)).unwrap();
        assert!(
            close(mx2, mx1 * U256::from(2u8), 50),
            "MaxIL not linear: {mx1} {mx2}"
        );
    }

    #[test]
    fn maxil_out_of_range_returns_none() {
        assert!(
            compute_max_il(sp(70), sp(80), sp(125), lv()).is_none(),
            "below Pa"
        );
        assert!(
            compute_max_il(sp(130), sp(80), sp(125), lv()).is_none(),
            "above Pb"
        );
    }

    #[test]
    fn maxil_tight_range_smaller_than_wide() {
        let tight = maxil(100, 99, 101);
        let wide = maxil(100, 80, 125);
        assert!(tight > U256::ZERO, "tight MaxIL must be positive");
        assert!(tight < wide, "tight={tight} wide={wide}");
    }

    // ─── Task 2.5 — compute_il in range (6) ─────────────────────────────

    #[test]
    fn il_in_range_at_entry_is_zero() {
        let (a0, a1) = entry(100, 80, 125);
        let v = il(100, 80, 125, a0, a1);
        assert!(v <= U256::from(100u8), "IL at entry must be ~0: {v}");
    }

    #[test]
    fn il_in_range_positive_upward_move() {
        let (a0, a1) = entry(100, 80, 125);
        let v = il(115, 80, 125, a0, a1);
        assert!(v > U256::ZERO, "expected positive IL");
        assert!(v < maxil(100, 80, 125), "interior IL must be < MaxIL");
    }

    #[test]
    fn il_in_range_positive_downward_move() {
        let (a0, a1) = entry(100, 80, 125);
        let v = il(88, 80, 125, a0, a1);
        assert!(v > U256::ZERO, "expected positive IL");
        assert!(v < maxil(100, 80, 125), "interior IL must be < MaxIL");
    }

    #[test]
    fn il_in_range_interior_below_max() {
        let (a0, a1) = entry(100, 80, 125);
        let mx = maxil(100, 80, 125);
        for pt in [82u64, 90, 100, 110, 120, 124] {
            let v = il(pt, 80, 125, a0, a1);
            assert!(v <= mx + U256::from(100u8), "IL({pt})={v} > MaxIL={mx}");
        }
    }

    #[test]
    fn il_in_range_increases_away_from_entry() {
        let (a0, a1) = entry(100, 80, 125);
        assert!(
            il(120, 80, 125, a0, a1) > il(110, 80, 125, a0, a1),
            "upward"
        );
        assert!(
            il(84, 80, 125, a0, a1) > il(92, 80, 125, a0, a1),
            "downward"
        );
    }

    #[test]
    fn il_in_range_scales_linearly_in_l() {
        let (a0, a1) = entry(100, 80, 125);
        let il_1 = il(115, 80, 125, a0, a1);
        let (a0_2, a1_2) = amounts_at(sp(100), sp(80), sp(125), lv() * U256::from(2u8));
        let il_2 = il_at(sp(115), sp(80), sp(125), lv() * U256::from(2u8), a0_2, a1_2);
        assert!(
            close(il_2, il_1 * U256::from(2u8), 100),
            "IL not linear: {il_1} {il_2}"
        );
    }

    // ─── Task 2.6 — compute_il below Pa (4) ─────────────────────────────

    #[test]
    fn il_below_pa_is_positive() {
        let (a0, a1) = entry(100, 80, 125);
        assert!(il(79, 80, 125, a0, a1) > U256::ZERO);
        assert!(il(60, 80, 125, a0, a1) > U256::ZERO);
    }

    #[test]
    fn il_below_pa_monotone_increasing_as_price_falls() {
        let (a0, a1) = entry(100, 80, 125);
        let il_79 = il(79, 80, 125, a0, a1);
        let il_70 = il(70, 80, 125, a0, a1);
        let il_60 = il(60, 80, 125, a0, a1);
        assert!(
            il_60 > il_70 && il_70 > il_79,
            "IL must grow as price falls below Pa"
        );
    }

    #[test]
    fn il_below_pa_vlp_linear_in_price() {
        // Fully token0 below Pa ⇒ V_lp(P) = amount0(Pa)·P, linear in price.
        let vlp_30 = v_lp(sp(30), sp(80), sp(125), lv());
        let vlp_60 = v_lp(sp(60), sp(80), sp(125), lv());
        assert!(
            close(vlp_60, vlp_30 * U256::from(2u8), 10_000),
            "below-Pa V_lp not linear: vlp30={vlp_30} vlp60={vlp_60}"
        );
    }

    #[test]
    fn il_below_pa_vlp_continuous_at_boundary() {
        // At exactly Pa the in-range V_lp equals the all-token0 boundary value.
        let vlp_inrange = v_lp(sp(80), sp(80), sp(125), lv());
        let vlp_boundary = amount0_in_token1(amount0_boundary(sp(80), sp(125), lv()), sp(80));
        assert_eq!(vlp_inrange, vlp_boundary, "V_lp discontinuous at Pa");
    }

    // ─── Task 2.7 — compute_il above Pb (4) ─────────────────────────────

    #[test]
    fn il_above_pb_is_positive() {
        let (a0, a1) = entry(100, 80, 125);
        assert!(il(130, 80, 125, a0, a1) > U256::ZERO);
        assert!(il(200, 80, 125, a0, a1) > U256::ZERO);
    }

    #[test]
    fn il_above_pb_monotone_increasing_as_price_rises() {
        let (a0, a1) = entry(100, 80, 125);
        let il_130 = il(130, 80, 125, a0, a1);
        let il_160 = il(160, 80, 125, a0, a1);
        let il_200 = il(200, 80, 125, a0, a1);
        assert!(
            il_200 > il_160 && il_160 > il_130,
            "IL must grow as price rises above Pb"
        );
    }

    #[test]
    fn il_above_pb_vlp_constant() {
        // Fully token1 above Pb ⇒ V_lp(P) = amount1(Pb), constant in price.
        let cap = amount1_boundary(sp(80), sp(125), lv());
        assert_eq!(
            v_lp(sp(130), sp(80), sp(125), lv()),
            cap,
            "V_lp must equal amount1(Pb)"
        );
        assert_eq!(
            v_lp(sp(300), sp(80), sp(125), lv()),
            cap,
            "V_lp must be constant"
        );
    }

    #[test]
    fn il_above_pb_vlp_continuous_at_boundary() {
        // At exactly Pb the in-range V_lp equals the all-token1 boundary value.
        let vlp_inrange = v_lp(sp(125), sp(80), sp(125), lv());
        let cap = amount1_boundary(sp(80), sp(125), lv());
        assert_eq!(vlp_inrange, cap, "V_lp discontinuous at Pb");
    }
}
