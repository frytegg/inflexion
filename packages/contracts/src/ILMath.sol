// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IILMath } from "./interfaces/IILMath.sol";

/// @title  ILMath — Solidity reference implementation of IL formulas
/// @notice Spec §3.1 (IL definition) + §3.2 (MaxIL = boundary max).
///         Mirrors `quant/il.py` exactly — values agree under the
///         hand-calculated fixtures in `quant/tests/test_il.py`.
/// @dev    All sqrt-price inputs are Uniswap Q64.96 (`sqrtPriceX96`).
///         Token amounts are raw wei in the respective token's decimals.
///         IL is returned in **token1** wei (the numéraire, typically USDC).
///
///         **Why not vendor `SqrtPriceMath`?** Its
///         `getAmount0Delta` / `getAmount1Delta` overlap with formulas we
///         need here, and they require a separate 0.7 → 0.8 port (~200
///         lines of intricate assembly). Implementing the two we need
///         with `OZ Math.mulDiv` is ~10 lines and self-contained.
///
///         **Cross-check (Task 2.11):** the Rust/Stylus impl must return
///         identical values for the same `(sqrtPriceX96, sqrtPaX96,
///         sqrtPbX96, L, amount0Entry, amount1Entry)` inputs to within
///         ~1 wei. This contract is the reference; Stylus is the
///         gas-optimised variant of the same math.
contract ILMath is IILMath {
    /// @dev `Q96 = 2^96`, used throughout for Q64.96 normalisation.
    uint256 private constant Q96 = 1 << 96;

    error PositionOutOfRange(uint256 sqrtP0X96, uint256 sqrtPaX96, uint256 sqrtPbX96);

    // ─── Public IILMath implementation
    // ───────────────────────────────────

    /// @inheritdoc IILMath
    function computeMaxIL(
        uint256 sqrtPriceX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity
    ) external pure returns (uint256 maxIL) {
        if (sqrtPriceX96 < sqrtPaX96 || sqrtPriceX96 > sqrtPbX96) {
            revert PositionOutOfRange(sqrtPriceX96, sqrtPaX96, sqrtPbX96);
        }
        // Entry amounts at P0
        (uint256 a0Entry, uint256 a1Entry) = _amountsAt(sqrtPriceX96, sqrtPaX96, sqrtPbX96, liquidity);
        // IL at each boundary (MaxIL is the larger; spec §3.2 — convexity)
        uint256 ilAtPa = _ilAt(sqrtPaX96, sqrtPaX96, sqrtPbX96, liquidity, a0Entry, a1Entry);
        uint256 ilAtPb = _ilAt(sqrtPbX96, sqrtPaX96, sqrtPbX96, liquidity, a0Entry, a1Entry);
        return ilAtPa > ilAtPb ? ilAtPa : ilAtPb;
    }

    /// @inheritdoc IILMath
    function computeIL(
        uint256 sqrtPriceTX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity,
        uint256 amount0Entry,
        uint256 amount1Entry
    ) external pure returns (uint256 ilAmount) {
        return _ilAt(sqrtPriceTX96, sqrtPaX96, sqrtPbX96, liquidity, amount0Entry, amount1Entry);
    }

    // ─── View entry amounts (exposed for InflexionCore / tests) ─────────

    /// @notice Token amounts in a v3 position at the current sqrt price.
    ///         Caller is responsible for `sqrtPaX96 ≤ sqrtP ≤ sqrtPbX96`.
    /// @dev    Whitepaper §6.30 formulas, evaluated with `Math.mulDiv`.
    function getAmountsForLiquidity(
        uint256 sqrtPX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity
    ) external pure returns (uint256 amount0, uint256 amount1) {
        return _amountsAt(sqrtPX96, sqrtPaX96, sqrtPbX96, liquidity);
    }

    // ─── Internal core helpers
    // ───────────────────────────────────────────

    /// @dev Realised IL at a settlement sqrt price. Three regimes:
    ///        sqrtP_T < sqrtPa  →  position fully in token0
    ///        sqrtP_T > sqrtPb  →  position fully in token1
    ///        otherwise         →  in range
    function _ilAt(
        uint256 sqrtP_T,
        uint256 sqrtPa,
        uint256 sqrtPb,
        uint128 liquidity,
        uint256 amount0Entry,
        uint256 amount1Entry
    ) internal pure returns (uint256) {
        uint256 V_lp = _vLp(sqrtP_T, sqrtPa, sqrtPb, liquidity);
        uint256 V_hold = _vHold(amount0Entry, amount1Entry, sqrtP_T);
        return V_hold > V_lp ? V_hold - V_lp : 0; // I3: guarded subtraction
    }

    /// @dev `V_lp(P_T)` in token1 wei.
    function _vLp(
        uint256 sqrtP_T,
        uint256 sqrtPa,
        uint256 sqrtPb,
        uint128 liquidity
    ) internal pure returns (uint256) {
        if (sqrtP_T < sqrtPa) {
            // Fully in token0: V_lp = amount0(Pa) * P_T
            uint256 a0AtPa = _amount0Boundary(sqrtPa, sqrtPb, liquidity);
            return _amount0InToken1(a0AtPa, sqrtP_T);
        }
        if (sqrtP_T > sqrtPb) {
            // Fully in token1: V_lp = amount1(Pb)
            return _amount1Boundary(sqrtPa, sqrtPb, liquidity);
        }
        // In range: V_lp = amount0(P_T) * P_T + amount1(P_T)
        (uint256 a0, uint256 a1) = _amountsAt(sqrtP_T, sqrtPa, sqrtPb, liquidity);
        return _amount0InToken1(a0, sqrtP_T) + a1;
    }

    /// @dev `V_hold(P_T)` = a0_entry · P_T + a1_entry (token1 wei).
    function _vHold(
        uint256 amount0Entry,
        uint256 amount1Entry,
        uint256 sqrtP_T
    ) internal pure returns (uint256) {
        return _amount0InToken1(amount0Entry, sqrtP_T) + amount1Entry;
    }

    /// @dev token0_wei · sqrtP² / 2^192 == token0_wei converted to token1 wei.
    function _amount0InToken1(
        uint256 amount0,
        uint256 sqrtP
    ) internal pure returns (uint256) {
        uint256 step = Math.mulDiv(amount0, sqrtP, Q96);
        return Math.mulDiv(step, sqrtP, Q96);
    }

    /// @dev Whitepaper §6.30:
    ///        amount0 = L · (sqrtPb − sqrtP) · 2^96 / (sqrtP · sqrtPb)
    ///        amount1 = L · (sqrtP − sqrtPa) / 2^96
    function _amountsAt(
        uint256 sqrtPX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        uint256 t = Math.mulDiv(uint256(liquidity), sqrtPbX96 - sqrtPX96, Q96);
        t = Math.mulDiv(t, Q96, sqrtPX96);
        amount0 = Math.mulDiv(t, Q96, sqrtPbX96);

        amount1 = Math.mulDiv(uint256(liquidity), sqrtPX96 - sqrtPaX96, Q96);
    }

    function _amount0Boundary(
        uint256 sqrtPa,
        uint256 sqrtPb,
        uint128 liquidity
    ) internal pure returns (uint256) {
        uint256 t = Math.mulDiv(uint256(liquidity), sqrtPb - sqrtPa, Q96);
        t = Math.mulDiv(t, Q96, sqrtPa);
        return Math.mulDiv(t, Q96, sqrtPb);
    }

    function _amount1Boundary(
        uint256 sqrtPa,
        uint256 sqrtPb,
        uint128 liquidity
    ) internal pure returns (uint256) {
        return Math.mulDiv(uint256(liquidity), sqrtPb - sqrtPa, Q96);
    }
}
