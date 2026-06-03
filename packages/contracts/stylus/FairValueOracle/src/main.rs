//! Binary entry — only used when invoking `cargo stylus export-abi`.
//! Stylus runtime provides the on-chain entry point separately.

#![cfg_attr(not(feature = "export-abi"), no_main)]

#[cfg(feature = "export-abi")]
fn main() {
    fair_value_oracle::print_abi("MIT", "pragma solidity ^0.8.24;");
}
