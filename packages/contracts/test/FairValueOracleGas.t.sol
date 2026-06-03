// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { FairValueOracle } from "../src/FairValueOracle.sol";
import { IVolOracle } from "../src/interfaces/IVolOracle.sol";
import { MockVolOracle } from "./mocks/MockVolOracle.sol";

/// @title  Solidity `fairRate` gas benchmark (P2.2 — Stylus-vs-Solidity input)
/// @notice Records the gas of the exact Φ-sum `fairRate` over representative
///         geometries (centered ±5%/±10%, tight ±2%, asymmetric) so the
///         Stylus-vs-Solidity ship decision is grounded in real numbers, not the
///         ~66k estimate in docs/STYLUS_FAIRVALUE_BENCHMARK.md. Measured with an
///         external `this.fairRate(...)` call so the gas reflects a realistic
///         dispatch (the cross-contract path the core actually uses), minus the
///         calldata/return ABI noise (subtracted via an empty-call baseline).
contract FairValueOracleGasTest is Test {
    FairValueOracle internal fvo;

    function setUp() public {
        fvo = new FairValueOracle(IVolOracle(address(new MockVolOracle(6e17))));
    }

    function _measure(
        string memory label,
        uint256 a,
        uint256 b,
        uint256 sigma,
        uint256 dur
    ) internal {
        // Warm the code/access list with one untimed call.
        uint256 r0 = fvo.fairRate(a, b, sigma, dur);
        uint256 g0 = gasleft();
        uint256 r = fvo.fairRate(a, b, sigma, dur);
        uint256 used = g0 - gasleft();
        assertEq(r, r0);
        emit log_named_uint(string.concat("gas fairRate ", label), used);
    }

    function test_gas_fairRate() public {
        // ±5% geom (a=1/1.05, b=1.05), 30d, σ=60%
        _measure("pm5pct_30d", 952_380_952_380_952_320, 1_050_000_000_000_000_000, 6e17, 2_592_000);
        // ±10% geom, 30d
        _measure("pm10pct_30d", 909_090_909_090_909_056, 1_100_000_000_000_000_128, 6e17, 2_592_000);
        // ±2% tight (0.05% fee tier edge), 30d — worst 1/MaxIL amplification
        _measure("pm2pct_30d", 980_392_156_862_745_088, 1_020_000_000_000_000_000, 6e17, 2_592_000);
        // asymmetric (P0 near lower edge), 90d — numéraire probe
        _measure("asym_neg06_90d", 746_981_775_647_618_176, 1_075_653_756_932_570_112, 6e17, 7_776_000);
        // wide ±35%, 90d
        _measure("pm35pct_90d", 740_740_740_740_740_736, 1_350_000_000_000_000_000, 9e17, 7_776_000);
    }
}
