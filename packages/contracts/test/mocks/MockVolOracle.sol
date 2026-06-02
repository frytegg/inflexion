// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IVolOracle } from "../../src/interfaces/IVolOracle.sol";

/// @notice Settable-sigma IVolOracle stub for InflexionCore / FairValueOracle tests.
contract MockVolOracle is IVolOracle {
    uint256 public sigma;

    constructor(
        uint256 _sigma
    ) {
        sigma = _sigma;
    }

    function setSigma(
        uint256 s
    ) external {
        sigma = s;
    }

    function sigmaRef(
        address
    ) external view returns (uint256) {
        return sigma;
    }

    function poke(
        address
    ) external view returns (uint256) {
        return sigma;
    }

    function sigmaComponents(
        address
    ) external view returns (uint256, uint256, uint256, uint8) {
        return (sigma, sigma, sigma, 0);
    }

    function isInitialized(
        address
    ) external pure returns (bool) {
        return true;
    }
}
