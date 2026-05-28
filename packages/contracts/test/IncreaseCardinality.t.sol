// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { IncreaseCardinality } from "../script/IncreaseCardinality.s.sol";
import { MockUniswapV3Pool } from "./mocks/MockUniswapV3Pool.sol";

/// @notice Unit tests for the cardinality-bump deploy script (Task 3.7).
///         Forge-script broadcast wrappers are no-ops in test mode, so the
///         underlying `increaseObservationCardinalityNext` call still runs
///         and is recorded by the mock pool's `bumpHistory`.
contract IncreaseCardinalityTest is Test {
    IncreaseCardinality internal script;
    MockUniswapV3Pool internal pool;

    function setUp() public {
        script = new IncreaseCardinality();
        pool = new MockUniswapV3Pool();
    }

    function test_bumps_freshPool_toTarget() public {
        // Default cardinalityNext = 0 (uninitialised in the mock)
        script.run(address(pool));
        assertEq(pool.observationCardinalityNext(), script.TARGET_CARDINALITY());
        assertEq(pool.bumpCount(), 1);
        assertEq(pool.bumpHistory(0), script.TARGET_CARDINALITY());
    }

    function test_idempotent_skipsAtTarget() public {
        // Pool already at target — bump should be a no-op
        pool.setCardinalityNext(script.TARGET_CARDINALITY());
        script.run(address(pool));
        assertEq(pool.bumpCount(), 0); // never called
    }

    function test_idempotent_skipsAboveTarget() public {
        pool.setCardinalityNext(script.TARGET_CARDINALITY() + 100);
        script.run(address(pool));
        assertEq(pool.bumpCount(), 0);
    }

    function test_bumps_underTarget() public {
        pool.setCardinalityNext(50); // 50 < 200
        script.run(address(pool));
        assertEq(pool.observationCardinalityNext(), script.TARGET_CARDINALITY());
        assertEq(pool.bumpCount(), 1);
    }

    function test_runMany_mixed() public {
        MockUniswapV3Pool a = new MockUniswapV3Pool();
        MockUniswapV3Pool b = new MockUniswapV3Pool();
        MockUniswapV3Pool c = new MockUniswapV3Pool();

        a.setCardinalityNext(0); // needs bump
        b.setCardinalityNext(script.TARGET_CARDINALITY()); // already at target → skip
        c.setCardinalityNext(50); // needs bump

        address[] memory pools = new address[](3);
        pools[0] = address(a);
        pools[1] = address(b);
        pools[2] = address(c);

        script.runMany(pools);

        assertEq(a.bumpCount(), 1);
        assertEq(b.bumpCount(), 0);
        assertEq(c.bumpCount(), 1);
    }

    function test_increaseTo_customTarget() public {
        pool.setCardinalityNext(10);
        script.increaseTo(address(pool), 500);
        assertEq(pool.observationCardinalityNext(), 500);
        assertEq(pool.bumpCount(), 1);
    }
}
