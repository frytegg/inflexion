// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IILMath } from "../../src/interfaces/IILMath.sol";

/// @notice Scriptable IL math mock for InflexionCore tests.
///         Returns fixed values configured per-call so contract logic
///         (CEI ordering, caps, vault wiring) can be exercised without
///         depending on the actual Q64.96 math implementation.
/// @dev    The real `IILMath` will be the Stylus contract (Phase 2.2+)
///         or a Solidity reference impl (separate task). This mock just
///         returns scripted values so we can unit-test the surrounding
///         contract architecture in isolation.
contract MockILMath is IILMath {
    uint256 public scriptedMaxIL;
    uint256 public scriptedIL;

    /// @notice When set, `computeIL` returns the `liquidity` argument
    ///         verbatim (echoing it as the IL value). Used by the I6
    ///         invariant test to confirm the contract passed the STORED
    ///         liquidity, not a re-read value.
    /// @dev    `computeMaxIL` is NOT affected — keep echo localised to the
    ///         settle path so createSwap's ratio gate isn't disturbed.
    bool public echoLiquidityIL;

    /// @notice Records the `liquidity` value passed to the most-recent
    ///         `computeIL` call. Used by the I6 invariant test to assert
    ///         the contract forwarded the STORED liquidity (not a re-read
    ///         of the mutable position field).
    uint128 public lastILCallLiquidity;
    bool public lastILCallSeen;

    function setMaxIL(
        uint256 v
    ) external {
        scriptedMaxIL = v;
    }

    function setIL(
        uint256 v
    ) external {
        scriptedIL = v;
    }

    function setEchoLiquidityIL(
        bool on
    ) external {
        echoLiquidityIL = on;
    }

    function computeMaxIL(
        uint256,
        uint256,
        uint256,
        uint128
    ) external view returns (uint256) {
        return scriptedMaxIL;
    }

    function computeIL(
        uint256,
        uint256,
        uint256,
        uint128 liquidity,
        uint256,
        uint256
    ) external returns (uint256) {
        lastILCallLiquidity = liquidity;
        lastILCallSeen = true;
        if (echoLiquidityIL) return uint256(liquidity);
        return scriptedIL;
    }
}
