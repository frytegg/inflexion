//! ILMath — pure-compute Stylus contract for Uniswap v3 IL / MaxIL math.
//!
//! Spec references:
//!   * `spec.md` §3.1 — IL formula (3 cases: in-range, below Pa, above Pb)
//!   * `spec.md` §3.2 — MaxIL = max(IL(Pa), IL(Pb)) and the coverage cap
//!
//! This file is a Phase-1 SKELETON: it validates the Stylus toolchain end-to-end
//! and exports the surface that `IILMath.sol` will call. Phase 2 (Tasks 2.3-2.7)
//! fills in the math + proofs + 25+ unit tests.

#![cfg_attr(not(any(feature = "export-abi", test)), no_main)]
extern crate alloc;

use stylus_sdk::{alloy_primitives::U256, prelude::*};

sol_storage! {
    #[entrypoint]
    pub struct ILMath {}
}

#[public]
impl ILMath {
    /// Maximum in-range IL = max(IL(Pa), IL(Pb)). See `spec.md` §3.2.
    /// Phase 2.3 implements this; current stub returns 0.
    pub fn compute_max_il(
        &self,
        _sqrt_price_x96: U256,
        _sqrt_pa_x96: U256,
        _sqrt_pb_x96: U256,
        _liquidity: u128,
    ) -> U256 {
        U256::ZERO
    }

    /// Realized IL at settlement price P_T = max(0, V_hold − V_lp). See `spec.md` §3.1.
    /// Phase 2.5–2.7 implement the three price regimes; current stub returns 0.
    pub fn compute_il(
        &self,
        _sqrt_price_t_x96: U256,
        _sqrt_pa_x96: U256,
        _sqrt_pb_x96: U256,
        _liquidity: u128,
        _amount0_entry: U256,
        _amount1_entry: U256,
    ) -> U256 {
        U256::ZERO
    }
}
