// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { TickMath } from "../src/libraries/TickMath.sol";

/// @notice Smoke tests for the Solidity-0.8 port of `TickMath`.
///         Anchors against well-known reference values from Uniswap
///         v3-core's own test suite so we catch any silent divergence
///         introduced by the pragma bump.
contract TickMathTest is Test {
    function test_zeroTick_returnsQ96() public pure {
        // sqrt(1.0001^0) * 2^96 == 1 * 2^96 exactly
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(0);
        assertEq(uint256(sqrtPriceX96), 1 << 96);
    }

    function test_minTick_matchesMinSqrtRatio() public pure {
        assertEq(uint256(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK)), uint256(TickMath.MIN_SQRT_RATIO));
    }

    function test_maxTick_matchesMaxSqrtRatio() public pure {
        assertEq(uint256(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK)), uint256(TickMath.MAX_SQRT_RATIO));
    }

    function test_outOfRange_reverts() public {
        // TickMath is an internal library; calling it directly from the
        // test happens in the test's own frame, so `vm.expectRevert`
        // can't catch it. Wrap via an external thunk.
        TickMathThunk thunk = new TickMathThunk();
        vm.expectRevert(abi.encodeWithSelector(TickMath.TickOutOfRange.selector, int24(TickMath.MAX_TICK + 1)));
        thunk.tryTick(TickMath.MAX_TICK + 1);
    }

    /// @notice Inverse-symmetry property: sqrtPriceAtTick(t) ·
    ///         sqrtPriceAtTick(-t) ≈ 2^192. Exact equality wouldn't hold
    ///         because of rounding in the Q128.128 → Q128.96 downcast;
    ///         we assert agreement to a few wei out of ~2^192.
    function testFuzz_negativeTickIsInverse(
        int24 tick
    ) public pure {
        int24 t = int24(bound(int256(tick), int256(1), int256(TickMath.MAX_TICK)));
        uint256 sUp = uint256(TickMath.getSqrtRatioAtTick(t));
        uint256 sDown = uint256(TickMath.getSqrtRatioAtTick(-t));
        // Product should be very close to 2^192
        uint256 prod = (sUp * sDown) >> 96; // bring back to Q96-scale
        uint256 expected = uint256(1) << 96;
        // Allow ±1e-6 relative drift (rounding accumulates over the
        // 20 bit-chain multiplications). The point is correctness, not
        // perfect inverse symmetry.
        uint256 diff = prod > expected ? prod - expected : expected - prod;
        assertLt(diff, expected / 1_000_000);
    }

    /// @notice Monotonicity: a higher tick → strictly higher sqrt price.
    function testFuzz_monotonicInTick(
        int24 t1,
        int24 t2
    ) public pure {
        int24 a = int24(bound(int256(t1), int256(TickMath.MIN_TICK), int256(TickMath.MAX_TICK - 1)));
        int24 b = int24(bound(int256(t2), int256(a) + 1, int256(TickMath.MAX_TICK)));
        assertLt(
            uint256(TickMath.getSqrtRatioAtTick(a)),
            uint256(TickMath.getSqrtRatioAtTick(b)),
            "TickMath not monotone in tick"
        );
    }
}

/// @notice External thunk that re-exposes TickMath for revert-expectation tests.
contract TickMathThunk {
    function tryTick(
        int24 t
    ) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(t);
    }
}
