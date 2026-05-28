// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { ILMath } from "../src/ILMath.sol";

/// @notice Tests for the Solidity ref impl of IL math.
///         Mirrors `quant/tests/test_il.py` fixtures (P0=100, Pa=80,
///         Pb=125, L scaled to 1e18) — the same Python values translated
///         to Q64.96 inputs.
contract ILMathTest is Test {
    ILMath internal il;

    // Q64.96 sqrt prices for P ∈ {80, 100, 125}. Computed at test runtime
    // via Math.sqrt(P * 2^192) so the test is self-contained — no magic
    // numbers from outside.
    uint256 internal sqrtPa;
    uint256 internal sqrtP0;
    uint256 internal sqrtPb;

    /// @dev 1e18 "ETH-scale" L → amount0 / amount1 readable as 18-decimal
    ///      token wei, comparable to the Python fixtures × 1e18.
    uint128 internal constant L = 1e18;

    function setUp() public {
        il = new ILMath();
        sqrtPa = _sqrtPriceX96(80);
        sqrtP0 = _sqrtPriceX96(100);
        sqrtPb = _sqrtPriceX96(125);
    }

    /// @dev sqrt(P) * 2^96 = sqrt(P * 2^192). Lossless for P expressible
    ///      as a perfect square × 10^k; otherwise rounds down to integer.
    function _sqrtPriceX96(
        uint256 price
    ) internal pure returns (uint256) {
        return Math.sqrt(price << 192);
    }

    // ─── At-entry property: IL == 0 (no drift, no loss) ────────────────

    function test_il_atEntryIsZero() public view {
        (uint256 a0, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 ilAt = il.computeIL(sqrtP0, sqrtPa, sqrtPb, L, a0, a1);
        // Within 1 wei of zero (rounding can accumulate ~1 wei across the chain)
        assertLe(ilAt, 1, "IL at entry must be ~0");
    }

    // ─── MaxIL = max(IL(Pa), IL(Pb)); both positive for off-centred P0 ─

    function test_maxIL_isBoundaryMax() public view {
        uint256 maxIL = il.computeMaxIL(sqrtP0, sqrtPa, sqrtPb, L);

        // IL at each boundary (recomputed with entry amounts)
        (uint256 a0, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 ilAtPa = il.computeIL(sqrtPa, sqrtPa, sqrtPb, L, a0, a1);
        uint256 ilAtPb = il.computeIL(sqrtPb, sqrtPa, sqrtPb, L, a0, a1);

        assertEq(maxIL, ilAtPa > ilAtPb ? ilAtPa : ilAtPb, "MaxIL must equal boundary max");
        assertGt(maxIL, 0, "MaxIL must be positive for off-centred range");
    }

    /// @notice Hand-calc fixture: Pb dominates over Pa for the
    ///         asymmetric range [80, 125] entered at P0=100. Python:
    ///         IL(Pa) ≈ 111.456 < IL(Pb) ≈ 139.320 = MaxIL.
    function test_maxIL_atPb_forUpwardAsymmetry() public view {
        (uint256 a0, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 ilAtPa = il.computeIL(sqrtPa, sqrtPa, sqrtPb, L, a0, a1);
        uint256 ilAtPb = il.computeIL(sqrtPb, sqrtPa, sqrtPb, L, a0, a1);
        assertGt(ilAtPb, ilAtPa, "Pb should dominate for [80,125] entered at 100");
    }

    // ─── Hand-calc fixtures: Python il.py values for L = 1e18 ──────────

    /// @notice Python: amount0 = 10.557280900008417 (× 1e18). Allow ±100 wei
    ///         tolerance (the lossiest mulDiv chain rounds at this scale).
    function test_fixture_amount0Entry_matchesPython() public view {
        (uint256 a0,) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 expected = 10_557_280_900_008_417; // 10.557... × 1e18
        _assertWithinAbs(a0, expected, 100);
    }

    /// @notice Python (L=1000): amount1 = 1055.728090000841.
    ///         With L=1e18 scales to 1.055728... × 1e18 wei.
    function test_fixture_amount1Entry_matchesPython() public view {
        (, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 expected = 1_055_728_090_000_841_200;
        _assertWithinAbs(a1, expected, 100);
    }

    /// @notice Python (L=1000): MaxIL = 139.32022500210132 at Pb.
    ///         With L=1e18 scales to 1.3932... × 1e17 wei.
    function test_fixture_maxIL_matchesPython() public view {
        uint256 maxIL = il.computeMaxIL(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 expected = 139_320_225_002_101_320;
        // Q64.96 mulDiv chain accumulates a few thousand wei of rounding
        // out of 1.4e17 — well within the spec's ~1-wei cross-check
        // tolerance after normalisation.
        _assertWithinAbs(maxIL, expected, 10_000);
    }

    // ─── Convexity property — MaxIL bounds interior IL ─────────────────

    function testFuzz_convexity_MaxILBoundsInteriorIL(
        uint256 sqrtPTSeed
    ) public view {
        // Sample sqrtP_T uniformly in [sqrtPa, sqrtPb]
        uint256 sqrtPT = bound(sqrtPTSeed, sqrtPa, sqrtPb);

        (uint256 a0, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 maxIL = il.computeMaxIL(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 interiorIL = il.computeIL(sqrtPT, sqrtPa, sqrtPb, L, a0, a1);

        // Allow tiny rounding overshoot
        assertLe(interiorIL, maxIL + 100, "IL exceeded MaxIL bound (convexity)");
    }

    // ─── Non-negativity (invariant I3 sketch — formula correctness) ────

    function testFuzz_I3_ilNonNegative(
        uint256 sqrtPTSeed
    ) public view {
        // Allow PT outside the entry range; IL is still bounded below by 0
        // by construction (max(0, V_hold - V_lp)).
        uint256 sqrtPT = bound(sqrtPTSeed, sqrtPa / 2, sqrtPb * 2);
        (uint256 a0, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 ilAt = il.computeIL(sqrtPT, sqrtPa, sqrtPb, L, a0, a1);
        // Trivially non-negative (uint256); the real I3 is "no underflow
        // even though V_hold can be < V_lp", which the contract enforces
        // via the guarded subtraction in `_ilAt`. The fact that this
        // function does not revert for any sqrtPT proves it.
        assertGe(ilAt, 0); // tautological — point is just that the call survived
    }

    // ─── Monotonicity in L: doubling L doubles IL
    // ────────────────────────

    function test_monotonicity_ilScalesLinearlyInL() public view {
        (uint256 a0, uint256 a1) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L);
        uint256 ilAtPb1 = il.computeIL(sqrtPb, sqrtPa, sqrtPb, L, a0, a1);

        (uint256 a0_2, uint256 a1_2) = il.getAmountsForLiquidity(sqrtP0, sqrtPa, sqrtPb, L * 2);
        uint256 ilAtPb2 = il.computeIL(sqrtPb, sqrtPa, sqrtPb, L * 2, a0_2, a1_2);

        _assertWithinAbs(ilAtPb2, ilAtPb1 * 2, 50);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _assertWithinAbs(
        uint256 actual,
        uint256 expected,
        uint256 tol
    ) internal pure {
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        if (diff > tol) {
            // Surface the mismatch with context so debugging the fixture
            // is fast.
            revert(
                string.concat(
                    "diff > tol: actual=",
                    Strings.toString(actual),
                    " expected=",
                    Strings.toString(expected),
                    " diff=",
                    Strings.toString(diff)
                )
            );
        }
    }
}

// Tiny inline Strings (used only in the assertion error). OZ's Strings would
// work too, but importing it here is overkill for one toString call.
library Strings {
    function toString(
        uint256 v
    ) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (v != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(v - (v / 10) * 10));
            bstr[k] = bytes1(temp);
            v /= 10;
        }
        return string(bstr);
    }
}
