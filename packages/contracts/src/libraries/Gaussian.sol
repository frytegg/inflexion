// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FixedPointMathLib } from "solady/utils/FixedPointMathLib.sol";

/// @title  Gaussian — standard normal CDF Φ via the Abramowitz–Stegun erf (7.1.26)
/// @notice WAD-scaled (1e18 = 1.0). `Φ(x) = ½·(1 + erf(x/√2))`. A&S 7.1.26 gives
///         |erf − truth| ≤ ~1.5e-7, so the CDF is accurate to ~1e-7 absolute —
///         the bounded-tolerance approximation for the Solidity `FairValueOracle`
///         (P2.2). The Rust/Stylus cross-check (latent sub-task) uses a
///         higher-precision erf to drive the "exact" property; the Solidity
///         tolerance is asserted against the Python closed form in tests.
/// @dev    Pure, no storage. Built on solady `expWad` (for `exp(−x²)`) +
///         signed/fixed-point helpers.
library Gaussian {
    using FixedPointMathLib for int256;
    using FixedPointMathLib for uint256;

    int256 internal constant WAD = 1e18;
    /// @dev √2 · 1e18.
    uint256 internal constant SQRT2_WAD = 1_414_213_562_373_095_048;
    /// @dev A&S 7.1.26 constant p = 0.3275911.
    uint256 internal constant AS_P = 327_591_100_000_000_000;
    // A&S 7.1.26 polynomial coefficients (WAD, signed).
    int256 internal constant A1 = 254_829_592_000_000_000;
    int256 internal constant A2 = -284_496_736_000_000_000;
    int256 internal constant A3 = 1_421_413_741_000_000_000;
    int256 internal constant A4 = -1_453_152_027_000_000_000;
    int256 internal constant A5 = 1_061_405_429_000_000_000;

    /// @notice `erf(x)` in WAD, for `x` in WAD.
    function erf(
        int256 x
    ) internal pure returns (int256) {
        bool neg = x < 0;
        uint256 ax = uint256(neg ? -x : x); // |x| (WAD)
        // t = 1 / (1 + p·|x|)
        uint256 t = uint256(WAD).divWad(uint256(WAD) + AS_P.mulWad(ax));
        int256 ts = int256(t);
        // Horner: poly = t·(a1 + t·(a2 + t·(a3 + t·(a4 + t·a5))))
        int256 acc = A5;
        acc = acc.sMulWad(ts) + A4;
        acc = acc.sMulWad(ts) + A3;
        acc = acc.sMulWad(ts) + A2;
        acc = acc.sMulWad(ts) + A1;
        int256 poly = acc.sMulWad(ts);
        // exp(−x²): for large |x| this underflows to 0 (erf → ±1), which is correct.
        uint256 x2 = ax.mulWad(ax);
        int256 e = FixedPointMathLib.expWad(-int256(x2));
        int256 res = WAD - poly.sMulWad(e); // erf(|x|) = 1 − poly·exp(−x²)
        return neg ? -res : res;
    }

    /// @notice Standard normal CDF `Φ(x)` in WAD (∈ [0, 1e18]) for `x` in WAD.
    function stdNormalCdf(
        int256 x
    ) internal pure returns (uint256) {
        int256 e = erf(x.sDivWad(int256(SQRT2_WAD)));
        int256 cdf = (WAD + e) / 2;
        if (cdf < 0) return 0;
        if (cdf > WAD) return uint256(WAD);
        return uint256(cdf);
    }
}
