// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title  SwapMath — pure geometry / price math extracted from InflexionCore
/// @notice Value-in / value-out only: ZERO storage, ZERO external calls. Houses the
///         oracle → Q64.96 conversion (pins entry price P0 at create and settlement
///         price P_T at settle), the Uniswap v3 entry-amount reconstruction, and the
///         amount0 → token1 conversion. This is PURE CODE MOTION from InflexionCore:
///         identical algorithm, rounding (Math.mulDiv 512-bit + Math.sqrt floor) and
///         revert conditions. A `delegatecall` to a public library does not change EVM
///         arithmetic, so every output is bit-identical to the former inline helpers —
///         hence settle() / MaxIL / invariants I1–I9 remain byte-identical in behavior.
/// @dev    The MarketConfig is decomposed into primitives (no struct/type dependency on
///         InflexionCore) so this stays a self-contained pure library.
library SwapMath {
    uint256 private constant _Q192 = 1 << 192;

    error OracleSqrtOutOfRange(uint256 sq);
    error UnsupportedDecimals();

    /// @dev Convert an oracle price (USD per oracleToken, scaled to `oracleDecimals`)
    ///      into the pool's Q64.96 sqrt price. `oracleIsToken0 == (oracleToken == token0)`.
    ///      Pool price (Uniswap convention) is `token1_raw / token0_raw`, so
    ///      `sqrtPriceX96^2 = poolPrice_raw · 2^192`. Reverts identically to the former
    ///      InflexionCore._oracleSqrtPriceX96 (same errors, same bounds).
    function oracleSqrtPriceX96(
        uint256 oraclePrice,
        bool oracleIsToken0,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint8 oracleDecimals
    ) public pure returns (uint160) {
        if (oraclePrice == 0) revert OracleSqrtOutOfRange(0);
        uint256 inner;
        if (oracleIsToken0) {
            // inner = oraclePrice · 2^192 / 10^(t0dec + oracleDec − t1dec)
            uint256 d = uint256(token0Decimals) + uint256(oracleDecimals);
            if (d < uint256(token1Decimals)) revert UnsupportedDecimals();
            inner = Math.mulDiv(oraclePrice, _Q192, 10 ** (d - uint256(token1Decimals)));
        } else {
            // oracleToken == token1: inner = 10^(oracleDec + t1dec − t0dec) · 2^192 / oraclePrice
            uint256 e = uint256(oracleDecimals) + uint256(token1Decimals);
            if (e < uint256(token0Decimals)) revert UnsupportedDecimals();
            inner = Math.mulDiv(10 ** (e - uint256(token0Decimals)), _Q192, oraclePrice);
        }
        uint256 sq = Math.sqrt(inner);
        if (sq == 0 || sq > type(uint160).max) revert OracleSqrtOutOfRange(sq);
        return uint160(sq);
    }

    /// @dev Reconstruct entry amounts from sqrt prices + L (Uniswap v3 §6.30).
    ///        amount0 = L · (sqrtPb − sqrtP0) / (sqrtP0 · sqrtPb / 2^96)
    ///        amount1 = L · (sqrtP0 − sqrtPa) / 2^96
    function entryAmounts(
        uint160 sqrtP0X96,
        uint160 sqrtPaX96,
        uint160 sqrtPbX96,
        uint128 liquidity
    ) public pure returns (uint128 amount0, uint128 amount1) {
        uint256 numer0 = Math.mulDiv(uint256(liquidity), uint256(sqrtPbX96) - uint256(sqrtP0X96), 1 << 96);
        uint256 amt0 = Math.mulDiv(numer0, 1 << 96, uint256(sqrtP0X96));
        amt0 = Math.mulDiv(amt0, 1 << 96, uint256(sqrtPbX96));
        uint256 amt1 = Math.mulDiv(uint256(liquidity), uint256(sqrtP0X96) - uint256(sqrtPaX96), 1 << 96);
        amount0 = uint128(amt0);
        amount1 = uint128(amt1);
    }

    /// @dev Convert `amount0` (token0 wei) to token1-wei at the pool's `sqrtP` (Q64.96):
    ///      `amount0 · sqrtP² / 2^192`, split across two mulDiv to avoid overflow.
    function amount0InToken1(
        uint256 amount0,
        uint160 sqrtPX96
    ) public pure returns (uint256) {
        uint256 step = Math.mulDiv(amount0, uint256(sqrtPX96), 1 << 96);
        return Math.mulDiv(step, uint256(sqrtPX96), 1 << 96);
    }
}
