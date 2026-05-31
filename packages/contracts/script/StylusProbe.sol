// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IILMath } from "../src/interfaces/IILMath.sol";

/// @title  StylusProbe — on-node cross-check + gas probe for `computeMaxIL`
/// @notice Calls `computeMaxIL` on a Stylus implementation and a Solidity
///         implementation of {IILMath} and returns both results plus the gas
///         each sub-call consumed. Used by Tasks 2.11 (equivalence) and 2.12
///         (gas benchmark).
/// @dev    **Must be invoked via `eth_call` against a real Arbitrum Nitro
///         node** (`cast call`). Foundry's local revm cannot execute Stylus
///         WASM, so the Stylus branch only runs on-chain. The two warm-up
///         calls equalise EIP-2929 cold-access cost (both target addresses
///         become "warm") so the measured deltas isolate execution cost.
contract StylusProbe {
    /// @param  stylus        address of the deployed Stylus `ILMath`
    /// @param  sol           address of the deployed Solidity `ILMath`
    /// @return vStylus       MaxIL from the Stylus impl
    /// @return vSol          MaxIL from the Solidity impl
    /// @return gasStylus     gas charged for the (warm) Stylus sub-call
    /// @return gasSol        gas charged for the (warm) Solidity sub-call
    function bench(
        address stylus,
        address sol,
        uint256 sqrtPriceX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity
    ) external view returns (uint256 vStylus, uint256 vSol, uint256 gasStylus, uint256 gasSol) {
        // Warm both program/account caches so the measured calls are steady-state.
        IILMath(stylus).computeMaxIL(sqrtPriceX96, sqrtPaX96, sqrtPbX96, liquidity);
        IILMath(sol).computeMaxIL(sqrtPriceX96, sqrtPaX96, sqrtPbX96, liquidity);

        uint256 g0 = gasleft();
        vStylus = IILMath(stylus).computeMaxIL(sqrtPriceX96, sqrtPaX96, sqrtPbX96, liquidity);
        uint256 g1 = gasleft();
        vSol = IILMath(sol).computeMaxIL(sqrtPriceX96, sqrtPaX96, sqrtPbX96, liquidity);
        uint256 g2 = gasleft();

        gasStylus = g0 - g1;
        gasSol = g1 - g2;
    }
}
