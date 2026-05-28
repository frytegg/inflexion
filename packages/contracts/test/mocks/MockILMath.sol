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
        uint128,
        uint256,
        uint256
    ) external view returns (uint256) {
        return scriptedIL;
    }
}
