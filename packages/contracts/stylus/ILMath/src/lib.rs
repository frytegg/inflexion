//! ILMath — pure-compute Stylus contract for Uniswap v3 IL / MaxIL math.
//!
//! Spec references:
//!   * `spec.md` §3.1 — realized IL (3 regimes: in-range, below Pa, above Pb)
//!   * `spec.md` §3.2 — MaxIL = max(IL(Pa), IL(Pb)), the coverage cap
//!
//! The math lives in [`math`] (a faithful port of
//! `packages/contracts/src/ILMath.sol`, wei-identical by construction). This
//! file is only the on-chain surface: the `#[entrypoint]` struct and the three
//! `IILMath` ABI methods. `#[selector]` pins the camelCase Solidity names.

#![cfg_attr(not(any(feature = "export-abi", test)), no_main)]
extern crate alloc;

mod math;

use alloy_sol_types::sol;
use stylus_sdk::{alloy_primitives::U256, prelude::*};

sol! {
    /// Entry price outside `[sqrt_pa_x96, sqrt_pb_x96]` (spec rule: enforce
    /// `Pa ≤ P0 ≤ Pb` at creation).
    #[derive(Debug)]
    error PositionOutOfRange(uint256 sqrt_price_x96, uint256 sqrt_pa_x96, uint256 sqrt_pb_x96);
}

#[derive(SolidityError, Debug)]
pub enum ILMathError {
    PositionOutOfRange(PositionOutOfRange),
}

sol_storage! {
    #[entrypoint]
    pub struct ILMath {}
}

#[public]
impl ILMath {
    /// `MaxIL = max(IL(Pa), IL(Pb))` (spec §3.2). Reverts
    /// `PositionOutOfRange` if `sqrtPriceX96 ∉ [sqrtPaX96, sqrtPbX96]`.
    #[selector(name = "computeMaxIL")]
    pub fn compute_max_il(
        &self,
        sqrt_price_x96: U256,
        sqrt_pa_x96: U256,
        sqrt_pb_x96: U256,
        liquidity: u128,
    ) -> Result<U256, ILMathError> {
        math::compute_max_il(sqrt_price_x96, sqrt_pa_x96, sqrt_pb_x96, U256::from(liquidity))
            .ok_or(ILMathError::PositionOutOfRange(PositionOutOfRange {
                sqrt_price_x96,
                sqrt_pa_x96,
                sqrt_pb_x96,
            }))
    }

    /// Realized IL at settlement price `P_T` = `max(0, V_hold − V_lp)`
    /// (spec §3.1). Entry amounts are supplied by the caller (stored at
    /// position creation — invariant I6).
    #[selector(name = "computeIL")]
    pub fn compute_il(
        &self,
        sqrt_price_t_x96: U256,
        sqrt_pa_x96: U256,
        sqrt_pb_x96: U256,
        liquidity: u128,
        amount0_entry: U256,
        amount1_entry: U256,
    ) -> U256 {
        math::il_at(
            sqrt_price_t_x96,
            sqrt_pa_x96,
            sqrt_pb_x96,
            U256::from(liquidity),
            amount0_entry,
            amount1_entry,
        )
    }

    /// Token amounts held by `liquidity` at `sqrtPX96` for `[Pa, Pb]`.
    /// Caller guarantees `sqrtPaX96 ≤ sqrtPX96 ≤ sqrtPbX96`.
    #[selector(name = "getAmountsForLiquidity")]
    pub fn get_amounts_for_liquidity(
        &self,
        sqrt_p_x96: U256,
        sqrt_pa_x96: U256,
        sqrt_pb_x96: U256,
        liquidity: u128,
    ) -> (U256, U256) {
        math::amounts_at(sqrt_p_x96, sqrt_pa_x96, sqrt_pb_x96, U256::from(liquidity))
    }
}
