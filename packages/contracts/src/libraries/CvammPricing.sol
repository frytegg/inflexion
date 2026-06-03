// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FixedPointMathLib } from "solady/utils/FixedPointMathLib.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title  CvammPricing — the on-chain cvAMM load stack + I10 clamp (P3.3)
/// @notice `premium = FairPremium · (1 + clamp(baseLoad + util_skew + dispersion_skew, maxLoad))`.
///         Mirrors the Python `inflexion_quant.cvamm` (util_skew / dispersion_skew
///         / clamp_load / base_load_from_envelope). All curve params come from
///         `quant/params.json` (cvAMM block) — **no primitive hardcoded**.
/// @dev    **Invariant I10, BY CONSTRUCTION:** the load sum is clamped to
///         `maxLoad`, so `premium ≤ FairPremium·(1 + maxLoad)` holds for ANY
///         inputs — both paths, upstream of settle (never touches settle / MaxIL
///         / I1–I9). WAD-scaled (1e18 = 1.0 = 100% load). σ_ref drives the
///         baseLoad regime; utilization (locked/total) drives util_skew; the
///         per-market coverage HHI drives dispersion_skew.
library CvammPricing {
    using FixedPointMathLib for uint256;

    uint256 internal constant WAD = 1e18;
    /// @dev 1 basis point = 1e-4 = 1e14 WAD.
    uint256 internal constant BPS_TO_WAD = 1e14;

    /// @notice Load-stack parameters (injected from params.json cvAMM block).
    struct LoadParams {
        // baseLoad by σ_ref regime (bps over FairPremium)
        uint256 baseLoadCalmBps;
        uint256 baseLoadNormalBps;
        uint256 baseLoadStressedBps;
        uint256 regimeCalmBelowWad; // σ_ref < this → calm
        uint256 regimeStressedAtWad; // σ_ref ≥ this → stressed; between → normal
        // util_skew(u) = min(cap, slope·((max(0,u−knee)/(1−knee))^power))
        uint256 utilKneeWad;
        uint256 utilSlopeWad;
        uint256 utilPowerWad;
        uint256 utilCapWad;
        // dispersion_skew(h) = min(cap, slope·h^power), h = coverage HHI
        uint256 dispSlopeWad;
        uint256 dispPowerWad;
        uint256 dispCapWad;
        // I10 clamp ceiling (bps): baseLoad + util + dispersion ≤ maxLoadBps
        uint256 maxLoadBps;
    }

    /// @notice baseLoad (WAD) for `sigmaRefWad` by regime band.
    function baseLoadWad(
        uint256 sigmaRefWad,
        LoadParams memory p
    ) internal pure returns (uint256) {
        uint256 bps = sigmaRefWad < p.regimeCalmBelowWad
            ? p.baseLoadCalmBps
            : (sigmaRefWad >= p.regimeStressedAtWad ? p.baseLoadStressedBps : p.baseLoadNormalBps);
        return bps * BPS_TO_WAD;
    }

    /// @notice util_skew(u) (WAD). Flat below the knee; convex above; capped.
    function utilSkewWad(
        uint256 uWad,
        LoadParams memory p
    ) internal pure returns (uint256) {
        if (uWad <= p.utilKneeWad) return 0;
        uint256 x = (uWad - p.utilKneeWad).divWad(WAD - p.utilKneeWad); // (u−knee)/(1−knee)
        if (x > WAD) x = WAD;
        uint256 v = p.utilSlopeWad.mulWad(_powWad(x, p.utilPowerWad));
        return v > p.utilCapWad ? p.utilCapWad : v;
    }

    /// @notice dispersion_skew(h) (WAD), h = normalised coverage HHI. Capped.
    function dispSkewWad(
        uint256 hWad,
        LoadParams memory p
    ) internal pure returns (uint256) {
        if (hWad == 0) return 0;
        uint256 v = p.dispSlopeWad.mulWad(_powWad(hWad, p.dispPowerWad));
        return v > p.dispCapWad ? p.dispCapWad : v;
    }

    /// @notice Total load (WAD) = min(baseLoad + util + dispersion, maxLoad). **I10.**
    function totalLoadWad(
        uint256 sigmaRefWad,
        uint256 uWad,
        uint256 hWad,
        LoadParams memory p
    ) public pure returns (uint256) {
        uint256 total = baseLoadWad(sigmaRefWad, p) + utilSkewWad(uWad, p) + dispSkewWad(hWad, p);
        uint256 maxLoad = p.maxLoadBps * BPS_TO_WAD;
        return total > maxLoad ? maxLoad : total;
    }

    /// @notice `premium = ceil(FairPremium · (1 + totalLoad))` (round up, F-#8).
    function premiumFromLoad(
        uint256 fairPremium,
        uint256 totalLoad
    ) public pure returns (uint256) {
        return Math.ceilDiv(fairPremium * (WAD + totalLoad), WAD);
    }

    /// @dev `x^y` for WAD `x ∈ [0,1]`, `y ≥ 0`; `x = 0 ⇒ 0`.
    function _powWad(
        uint256 x,
        uint256 y
    ) private pure returns (uint256) {
        if (x == 0) return 0;
        int256 r = FixedPointMathLib.powWad(int256(x), int256(y));
        return r < 0 ? 0 : uint256(r);
    }
}
