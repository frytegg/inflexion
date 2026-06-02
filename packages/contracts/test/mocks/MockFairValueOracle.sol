// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IFairValueOracle } from "../../src/interfaces/IFairValueOracle.sol";

/// @notice Geometry-independent IFairValueOracle stub: `fairPremium = maxIL ·
///         fairRate` with a settable `fairRate` (default 0.75) — like MockILMath,
///         so Path-B premium tests don't depend on the real Φ-sum geometry. With
///         the default 0.75 + a quote `loadBps = 0`, Path-B premium reproduces the
///         pre-P3.4 `0.75·maxIL`, keeping legacy assertions intact.
contract MockFairValueOracle is IFairValueOracle {
    uint256 public fairRateWad = 75e16; // 0.75
    uint256 public sigmaWad = 6e17; // 60%

    function setFairRate(
        uint256 r
    ) external {
        fairRateWad = r;
    }

    function setSigma(
        uint256 s
    ) external {
        sigmaWad = s;
    }

    /// @dev `pure` per the interface; unused by InflexionCore (which only calls
    ///      `fairPremium`), so it returns the default rate literal, not the
    ///      settable `fairRateWad`.
    function fairRate(
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure returns (uint256) {
        return 75e16;
    }

    function fairRateFromPrices(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure returns (uint256) {
        return 75e16;
    }

    function fairPremium(
        address,
        uint256,
        uint256,
        uint256,
        uint256 maxIL
    ) external view returns (uint256 premium, uint256 fr, uint256 sig) {
        fr = fairRateWad;
        sig = sigmaWad;
        premium = (maxIL * fairRateWad) / 1e18;
    }

    function volOracle() external pure returns (address) {
        return address(0);
    }
}
