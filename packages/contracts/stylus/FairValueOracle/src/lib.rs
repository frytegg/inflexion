//! FairValueOracle (Stylus) — exact closed-form `fairRate` Φ-sum, integer
//! fixed-point, machine-precision erf.
//!
//! `fairRate = E_Q[min(IL, MaxIL)] / MaxIL`, the exact finite Φ-sum over the
//! piecewise Uniswap-v3 capped payoff (spec Pillar 1 / P2.2). This is the Rust
//! port of `packages/contracts/src/FairValueOracle.sol`; unlike the Solidity
//! Abramowitz–Stegun erf (~1.5e-7, ÷MaxIL-amplified to ~1e-3 at the tight tier),
//! the integer fixed-point erf here matches the Python closed form to machine
//! precision (≤ 1e-12, in practice ≤ a few wei). The math lives in [`fairrate`]
//! and [`fixed`]; this file is only the on-chain surface.
//!
//! Stylus bans WASM floating point at activation — verified on this toolchain
//! ("No implementation for floating point operation ConvertIntOp(F64, I64)").
//! All transcendentals are therefore integer fixed-point. See
//! `docs/STYLUS_FAIRVALUE_BENCHMARK.md`.

#![cfg_attr(not(any(feature = "export-abi", test)), no_main)]
extern crate alloc;

mod fairrate;
mod fixed;

use alloy_sol_types::sol;
use stylus_sdk::{alloy_primitives::U256, prelude::*};

use fairrate::{fair_rate_wad, FvErr};

sol! {
    /// `a ≥ 1e18 || b ≤ 1e18` — the in-range gate (`Pa < P0 < Pb`) failed.
    #[derive(Debug)]
    error OutOfRange();
    /// `sigma == 0 || duration == 0 || P0 == 0`, or a degenerate MaxIL.
    #[derive(Debug)]
    error BadParam();
}

#[derive(SolidityError, Debug)]
pub enum FairValueError {
    OutOfRange(OutOfRange),
    BadParam(BadParam),
}

impl From<FvErr> for FairValueError {
    fn from(e: FvErr) -> Self {
        match e {
            FvErr::OutOfRange => FairValueError::OutOfRange(OutOfRange {}),
            FvErr::BadParam => FairValueError::BadParam(BadParam {}),
        }
    }
}

const WAD: U256 = U256::from_limbs([1_000_000_000_000_000_000, 0, 0, 0]);

sol_storage! {
    #[entrypoint]
    pub struct FairValueOracle {}
}

#[public]
impl FairValueOracle {
    /// `fairRate` (WAD, ∈ (0,1]) for normalised geometry `a = Pa/P0`, `b = Pb/P0`
    /// (both WAD), annualised `sigma` (WAD), `durationSeconds`. Pure — the exact
    /// Φ-sum. Reverts `OutOfRange` unless `a < 1e18 < b`.
    #[selector(name = "fairRate")]
    pub fn fair_rate(
        &self,
        a: U256,
        b: U256,
        sigma: U256,
        duration_seconds: U256,
    ) -> Result<U256, FairValueError> {
        Ok(fair_rate_wad(a, b, sigma, duration_seconds)?)
    }

    /// `fairRate` from raw prices (same scale for `P0`, `Pa`, `Pb`):
    /// `a = Pa·1e18/P0`, `b = Pb·1e18/P0`, then the normalised `fairRate`.
    #[selector(name = "fairRateFromPrices")]
    pub fn fair_rate_from_prices(
        &self,
        p0: U256,
        pa: U256,
        pb: U256,
        sigma: U256,
        duration_seconds: U256,
    ) -> Result<U256, FairValueError> {
        if p0.is_zero() {
            return Err(FairValueError::BadParam(BadParam {}));
        }
        // divWad(x, P0) = x·1e18/P0 (mirrors FairValueOracle.fairRateFromPrices).
        let a = pa.saturating_mul(WAD) / p0;
        let b = pb.saturating_mul(WAD) / p0;
        Ok(fair_rate_wad(a, b, sigma, duration_seconds)?)
    }
}
