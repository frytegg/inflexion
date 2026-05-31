//! Binary entry — only used when invoking `cargo stylus export-abi`.
//! Stylus runtime provides the on-chain entry point separately.
//!
//! `#[entrypoint]` (stylus-sdk 0.7) generates `print_abi(license, pragma)` in
//! the lib crate under the `export-abi` feature. (The `print_from_args()` helper
//! only exists in newer SDKs, hence the explicit license/pragma here — matching
//! `packages/contracts/src/ILMath.sol`.)

#![cfg_attr(not(feature = "export-abi"), no_main)]

#[cfg(feature = "export-abi")]
fn main() {
    il_math::print_abi("MIT", "pragma solidity ^0.8.24;");
}
