// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @title  IncreaseCardinality — one-shot, idempotent observation-cardinality bump
/// @notice Each Uniswap v3 pool ships with `observationCardinalityNext = 1`,
///         which means `pool.observe(secondsAgos)` can only return a TWAP if
///         the requested window is covered by recent trades. For Inflexion's
///         TWAP advisory (`TWAP_WINDOW = 1800s` per spec §6.2 + the
///         `getSettlementPrice` path in `OracleManager`), every target
///         market pool must have enough slots to cover the window even on
///         quiet days.
/// @dev    Usage:
///           forge script script/IncreaseCardinality.s.sol \
///             --rpc-url sepolia \
///             --sig "run(address)" $POOL_ADDRESS \
///             --broadcast --account deployer
///
///         Or with a batch:
///           forge script script/IncreaseCardinality.s.sol \
///             --rpc-url sepolia \
///             --sig "runMany(address[])" "[$POOL_A,$POOL_B,$POOL_C]" \
///             --broadcast --account deployer
///
///         Idempotency: re-running on a pool that already has
///         `observationCardinalityNext ≥ TARGET_CARDINALITY` is a no-op (no
///         broadcast, no gas). Safe to run repeatedly.
///
///         **Why 200?** Pool observations are stored in a ring keyed by
///         trade events (not time). A high-activity pool may overwrite
///         every observation within minutes; a low-activity pool may span
///         hours per slot. 200 slots empirically covers the 30 min
///         `TWAP_WINDOW` on every Arbitrum One major pair we plan to use.
///         Bump higher if expanding to lower-activity markets.
contract IncreaseCardinality is Script {
    /// @notice Target observation slots per pool. See contract NatSpec.
    uint16 public constant TARGET_CARDINALITY = 200;

    /// @notice Convenience: bump a single pool to `TARGET_CARDINALITY`.
    /// @param  pool  Uniswap v3 pool to bump.
    function run(
        address pool
    ) external {
        _bumpIfBelow(pool, TARGET_CARDINALITY);
    }

    /// @notice Bump many pools in one broadcast transaction.
    /// @dev    Each pool is broadcast under the same signer; failure of one
    ///         pool reverts the whole batch (atomic).
    function runMany(
        address[] calldata pools
    ) external {
        uint256 broadcastCount;
        for (uint256 i = 0; i < pools.length; ++i) {
            if (_needsBump(pools[i], TARGET_CARDINALITY)) {
                if (broadcastCount == 0) vm.startBroadcast();
                IUniswapV3Pool(pools[i]).increaseObservationCardinalityNext(TARGET_CARDINALITY);
                broadcastCount++;
                console2.log("Bumped pool to cardinality", TARGET_CARDINALITY);
                console2.log("  pool", pools[i]);
            } else {
                console2.log("Skipped (already sufficient)");
                console2.log("  pool", pools[i]);
            }
        }
        if (broadcastCount > 0) vm.stopBroadcast();
        console2.log("Pools bumped:", broadcastCount);
        console2.log("Pools skipped:", pools.length - broadcastCount);
    }

    /// @notice Bump `pool` to at least `target` slots if it isn't already.
    /// @dev    Public so tests can call it without broadcast.
    function increaseTo(
        address pool,
        uint16 target
    ) external {
        _bumpIfBelow(pool, target);
    }

    // ─── Internal
    // ─────────────────────────────────────────────────────────

    function _bumpIfBelow(
        address pool,
        uint16 target
    ) internal {
        uint16 current = _currentCardinalityNext(pool);
        if (current >= target) {
            console2.log("Skipped (already sufficient)");
            console2.log("  pool", pool);
            console2.log("  current cardinality", current);
            return;
        }
        vm.startBroadcast();
        IUniswapV3Pool(pool).increaseObservationCardinalityNext(target);
        vm.stopBroadcast();
        console2.log("Bumped pool");
        console2.log("  pool", pool);
        console2.log("  cardinality:", current, "->", target);
    }

    function _needsBump(
        address pool,
        uint16 target
    ) internal view returns (bool) {
        return _currentCardinalityNext(pool) < target;
    }

    function _currentCardinalityNext(
        address pool
    ) internal view returns (uint16) {
        (,,,, uint16 next,,) = IUniswapV3Pool(pool).slot0();
        return next;
    }
}
