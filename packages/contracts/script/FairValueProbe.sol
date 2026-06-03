// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IFairValueOracle } from "../src/interfaces/IFairValueOracle.sol";

/// @title  FairValueProbe — on-node cross-check + gas probe for `fairRate` (P2.2)
/// @notice Calls `fairRate(a,b,sigma,dur)` on a Stylus impl and a Solidity impl of
///         {IFairValueOracle} and returns both results plus the gas each sub-call
///         consumed. The accuracy GAP between them is the point: Stylus uses an
///         integer fixed-point erf (machine precision) where Solidity uses
///         Abramowitz–Stegun (~1.5e-7, ÷MaxIL-amplified). The gas comparison
///         answers whether the larger fairRate kernel flips the ILMath verdict
///         (where Stylus lost on a tiny kernel). See docs/STYLUS_FAIRVALUE_BENCHMARK.md.
/// @dev    **Invoke via `eth_call` against a real Arbitrum Nitro node** (`cast
///         call`) — Foundry's revm cannot execute Stylus WASM. The two warm-up
///         calls equalise EIP-2929 cold-access cost so the deltas isolate
///         execution cost.
contract FairValueProbe {
    function bench(
        address stylus,
        address sol,
        uint256 a,
        uint256 b,
        uint256 sigma,
        uint256 durationSeconds
    ) external view returns (uint256 vStylus, uint256 vSol, uint256 gasStylus, uint256 gasSol) {
        // Warm both program/account caches so the measured calls are steady-state.
        IFairValueOracle(stylus).fairRate(a, b, sigma, durationSeconds);
        IFairValueOracle(sol).fairRate(a, b, sigma, durationSeconds);

        uint256 g0 = gasleft();
        vStylus = IFairValueOracle(stylus).fairRate(a, b, sigma, durationSeconds);
        uint256 g1 = gasleft();
        vSol = IFairValueOracle(sol).fairRate(a, b, sigma, durationSeconds);
        uint256 g2 = gasleft();

        gasStylus = g0 - g1;
        gasSol = g1 - g2;
    }
}
