// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { CvammPricing } from "../src/libraries/CvammPricing.sol";

contract CvammPricingTest is Test {
    using CvammPricing for uint256;

    /// @dev Launch params (cvAMM block): baseLoad 2000/3000/5000 bps, regime
    ///      bands 0.60/1.025, util knee0.45/slope0.6/pow2/cap0.6, disp
    ///      slope0.5/pow1.5/cap0.5, maxLoad 16000 bps.
    function _p() internal pure returns (CvammPricing.LoadParams memory p) {
        p = CvammPricing.LoadParams({
            baseLoadCalmBps: 2000,
            baseLoadNormalBps: 3000,
            baseLoadStressedBps: 5000,
            regimeCalmBelowWad: 6e17,
            regimeStressedAtWad: 1025e15,
            utilKneeWad: 45e16,
            utilSlopeWad: 6e17,
            utilPowerWad: 2e18,
            utilCapWad: 6e17,
            dispSlopeWad: 5e17,
            dispPowerWad: 15e17,
            dispCapWad: 5e17,
            maxLoadBps: 16_000
        });
    }

    function test_util_skew_matches_python() public pure {
        CvammPricing.LoadParams memory p = _p();
        assertEq(CvammPricing.utilSkewWad(0, p), 0);
        assertEq(CvammPricing.utilSkewWad(45e16, p), 0); // at knee → 0
        assertApproxEqAbs(CvammPricing.utilSkewWad(6e17, p), 44_628_099_173_553_696, 1e13); // u=0.6
        assertApproxEqAbs(CvammPricing.utilSkewWad(8e17, p), 242_975_206_611_570_240, 1e13); // u=0.8
        assertApproxEqAbs(CvammPricing.utilSkewWad(1e18, p), 6e17, 1e12); // u=1 → cap 0.6
    }

    function test_disp_skew_matches_python() public pure {
        CvammPricing.LoadParams memory p = _p();
        assertEq(CvammPricing.dispSkewWad(0, p), 0);
        assertApproxEqAbs(CvammPricing.dispSkewWad(2e17, p), 44_721_359_549_995_800, 1e13); // h=0.2
        assertApproxEqAbs(CvammPricing.dispSkewWad(5e17, p), 176_776_695_296_636_896, 1e13); // h=0.5
        assertApproxEqAbs(CvammPricing.dispSkewWad(1e18, p), 5e17, 1e12); // h=1 → cap 0.5
    }

    function test_base_load_regime_selection() public pure {
        CvammPricing.LoadParams memory p = _p();
        assertEq(CvammPricing.baseLoadWad(5e17, p), 2000 * 1e14); // <0.60 → calm
        assertEq(CvammPricing.baseLoadWad(8e17, p), 3000 * 1e14); // [0.60,1.025) → normal
        assertEq(CvammPricing.baseLoadWad(13e17, p), 5000 * 1e14); // ≥1.025 → stressed
    }

    function test_util_and_disp_monotone() public pure {
        CvammPricing.LoadParams memory p = _p();
        assertGe(CvammPricing.utilSkewWad(9e17, p), CvammPricing.utilSkewWad(7e17, p));
        assertGe(CvammPricing.dispSkewWad(8e17, p), CvammPricing.dispSkewWad(3e17, p));
    }

    /// @notice I10 BY CONSTRUCTION: total load ≤ maxLoad and premium ≤
    ///         FairPremium·(1+maxLoad) for ANY inputs.
    function testFuzz_I10_clamp(
        uint256 sigma,
        uint256 u,
        uint256 h,
        uint256 fairPremium
    ) public pure {
        CvammPricing.LoadParams memory p = _p();
        sigma = bound(sigma, 0, 5e18);
        u = bound(u, 0, 1e18);
        h = bound(h, 0, 1e18);
        fairPremium = bound(fairPremium, 0, 1e24); // up to ~1e6 token1 (6-dec)
        uint256 load = CvammPricing.totalLoadWad(sigma, u, h, p);
        uint256 maxLoad = p.maxLoadBps * 1e14;
        assertLe(load, maxLoad, "I10: load exceeds maxLoad");
        uint256 prem = CvammPricing.premiumFromLoad(fairPremium, load);
        // premium ≤ ceil(FairPremium·(1+maxLoad)) + 1 wei rounding
        assertLe(prem, Math_ceil(fairPremium * (1e18 + maxLoad), 1e18) + 1, "I10: premium exceeds cap");
        assertGe(prem, fairPremium, "premium below FairPremium");
    }

    function Math_ceil(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
