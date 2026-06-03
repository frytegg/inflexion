//! FairValueOracle (Stylus) — exact closed-form `fairRate` Φ-sum, integer
//! fixed-point, machine-precision erf.
//!
//! `fairRate = E_Q[min(IL, MaxIL)] / MaxIL`, the exact finite Φ-sum over the
//! piecewise Uniswap-v3 capped payoff (spec Pillar 1 / P2.2). This is the Rust
//! port of `packages/contracts/src/FairValueOracle.sol`; unlike the Solidity
//! Abramowitz–Stegun erf (~1.5e-7, ÷MaxIL-amplified to ~1e-3 at the tight tier),
//! the integer fixed-point erf here matches the Python closed form to machine
//! precision (≤ 1e-12, in practice ≤ a few wei). The math lives in [`fairrate`]
//! and [`fixed`]; this file is only the on-chain surface (a full drop-in
//! `IFairValueOracle`: `fairRate`, `fairRateFromPrices`, `fairPremium`, `volOracle`).
//!
//! Stylus bans WASM floating point at activation — verified on this toolchain
//! ("No implementation for floating point operation ConvertIntOp(F64, I64)").
//! All transcendentals are therefore integer fixed-point. See
//! `docs/STYLUS_FAIRVALUE_BENCHMARK.md`.

#![cfg_attr(not(any(feature = "export-abi", test)), no_main)]
extern crate alloc;

mod fairrate;
mod fixed;

use alloc::vec::Vec;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{Address, U256},
    prelude::*,
};

use fairrate::{fair_rate_wad, FvErr};

sol! {
    /// `a ≥ 1e18 || b ≤ 1e18` — the in-range gate (`Pa < P0 < Pb`) failed.
    #[derive(Debug)]
    error OutOfRange();
    /// `sigma == 0 || duration == 0 || P0 == 0`, or a degenerate MaxIL.
    #[derive(Debug)]
    error BadParam();
    /// `init` called more than once, or with a zero VolOracle address.
    #[derive(Debug)]
    error BadInit();
    /// The cross-contract `VolOracle.sigmaRef` call reverted (e.g. token never poked).
    #[derive(Debug)]
    error VolCallFailed();
}

#[derive(SolidityError, Debug)]
pub enum FairValueError {
    OutOfRange(OutOfRange),
    BadParam(BadParam),
    BadInit(BadInit),
    VolCallFailed(VolCallFailed),
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

// The VolOracle surface this oracle reads `σ_ref` from (a Solidity contract;
// `sigmaRef` is `view` ⇒ a STATICCALL, valid inside core's own staticcall of
// `fairPremium`).
sol_interface! {
    interface IVolOracle {
        function sigmaRef(address token) external view returns (uint256);
    }
}

sol_storage! {
    #[entrypoint]
    pub struct FairValueOracle {
        /// The VolOracle, set once at deploy via `init` (mirrors the Solidity
        /// constructor's immutable `vol`).
        address vol;
        bool initialized;
    }
}

#[public]
impl FairValueOracle {
    /// One-time wiring of the VolOracle address (the Stylus analogue of the
    /// Solidity constructor arg). Reverts if already initialized or `vol == 0`.
    /// The deploy script calls this immediately after activation.
    pub fn init(&mut self, vol: Address) -> Result<(), FairValueError> {
        if self.initialized.get() || vol.is_zero() {
            return Err(FairValueError::BadInit(BadInit {}));
        }
        self.vol.set(vol);
        self.initialized.set(true);
        Ok(())
    }

    /// The VolOracle this oracle reads `σ_ref` from.
    #[selector(name = "volOracle")]
    pub fn vol_oracle(&self) -> Address {
        self.vol.get()
    }

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
        let a = pa.saturating_mul(WAD) / p0;
        let b = pb.saturating_mul(WAD) / p0;
        Ok(fair_rate_wad(a, b, sigma, duration_seconds)?)
    }

    /// `FairPremium = fairRate(σ_ref) · maxIL` for `token`, reading `σ_ref` from
    /// the VolOracle (STATICCALL). `maxIL` is in token1 units; the returned
    /// premium is in the same units. Mirrors `IFairValueOracle.fairPremium`.
    #[selector(name = "fairPremium")]
    pub fn fair_premium(
        &self,
        token: Address,
        a_wad: U256,
        b_wad: U256,
        duration_seconds: U256,
        max_il: U256,
    ) -> Result<(U256, U256, U256), FairValueError> {
        let sigma_ref = IVolOracle::new(self.vol.get())
            .sigma_ref(self, token)
            .map_err(|_| FairValueError::VolCallFailed(VolCallFailed {}))?;
        let fair_rate_wad_v = fair_rate_wad(a_wad, b_wad, sigma_ref, duration_seconds)?;
        let premium = max_il.saturating_mul(fair_rate_wad_v) / WAD;
        Ok((premium, fair_rate_wad_v, sigma_ref))
    }
}
