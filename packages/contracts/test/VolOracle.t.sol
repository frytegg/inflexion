// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { VolOracle } from "../src/VolOracle.sol";
import { IOracleManager } from "../src/interfaces/IOracleManager.sol";

/// @notice Minimal IOracleManager stub — VolOracle only uses getPrice + feedDecimals.
contract MockOracleManager is IOracleManager {
    uint256 public price; // in `dec` decimals
    uint8 public dec;

    constructor(
        uint256 _price,
        uint8 _dec
    ) {
        price = _price;
        dec = _dec;
    }

    function setPrice(
        uint256 p
    ) external {
        price = p;
    }

    function getPrice(
        address
    ) external view returns (uint256) {
        return price;
    }

    function feedDecimals(
        address
    ) external view returns (uint8) {
        return dec;
    }

    // ─ unused interface members (VolOracle never calls these) ─
    function getSettlementPrice(
        address,
        uint64,
        uint80
    ) external pure returns (uint256, bool) {
        revert("n/a");
    }

    function uniswapTWAPat(
        address,
        uint32,
        uint64
    ) external pure returns (int256) {
        revert("n/a");
    }

    function absBps(
        int256 a,
        int256 b
    ) external pure returns (uint256) {
        int256 d = a > b ? a - b : b - a;
        int256 m = a > b ? a : b;
        return uint256(d) * 10_000 / uint256(m);
    }
}

contract VolOracleTest is Test {
    MockOracleManager internal mock;
    VolOracle internal vol;

    address internal constant ETH = address(0xE7);
    uint256 internal constant WAD = 1e18;
    uint256 internal constant FLOOR = 5e17; // 50% annualised
    uint256 internal t;

    function setUp() public {
        mock = new MockOracleManager(3000e8, 8); // $3000, 8-dec Chainlink USD feed
        // short 1d, long 30d, floor 50%, min 1h, max 7d
        vol = new VolOracle(IOracleManager(address(mock)), 1 days, 30 days, FLOOR, 1 hours, 7 days);
        t = 1_000_000;
        vm.warp(t);
    }

    /// @dev Explicit accumulating clock — `vm.warp(block.timestamp + dt)` in a
    ///      tight loop does not chain reliably here, so we track `t` ourselves.
    function _advance(
        uint256 dt
    ) internal {
        t += dt;
        vm.warp(t);
    }

    function test_init_seeds_at_floor() public {
        assertFalse(vol.isInitialized(ETH));
        uint256 s = vol.poke(ETH);
        assertTrue(vol.isInitialized(ETH));
        assertApproxEqRel(s, FLOOR, 1e15); // within 0.1%
        assertApproxEqRel(vol.sigmaRef(ETH), FLOOR, 1e15);
    }

    function test_uninitialized_reverts() public {
        vm.expectRevert(bytes("VolOracle: not initialized"));
        vol.sigmaRef(ETH);
    }

    function test_too_soon_is_noop() public {
        vol.poke(ETH);
        mock.setPrice(3300e8); // +10% move
        _advance(30 minutes); // < minSampleInterval (1h)
        uint256 s = vol.poke(ETH); // must NOT revert, must NOT fold the sample
        assertApproxEqRel(s, FLOOR, 1e15); // still floor — sample ignored
    }

    function test_calm_market_stays_at_floor() public {
        vol.poke(ETH);
        for (uint256 i = 0; i < 40; i++) {
            _advance(1 days);
            vol.poke(ETH); // price unchanged → realized vol →0, floor binds
        }
        assertApproxEqRel(vol.sigmaRef(ETH), FLOOR, 1e15);
    }

    function test_recovers_known_sigma() public {
        // Constant |daily log-return| = sigma_annual/sqrt(365) recovers sigma_annual.
        // up=+4.277%, down=-4.10% (ln ~ ±0.0419 = 0.80/sqrt(365)); alternate to bound price.
        vol.poke(ETH);
        uint256 p = 3000e8;
        for (uint256 i = 0; i < 60; i++) {
            p = (i % 2 == 0) ? (p * 104_277) / 100_000 : (p * 95_900) / 100_000;
            mock.setPrice(p);
            _advance(1 days);
            vol.poke(ETH);
        }
        (uint256 ss, uint256 sl,, uint8 binding) = vol.sigmaComponents(ETH);
        // short window (halflife 1d, dt 1d) converges to ~80%; long (30d) lags lower.
        assertApproxEqRel(ss, 80e16, 12e16); // 0.80 ± 12%
        assertGt(ss, FLOOR);
        assertGt(ss, sl); // short reacts faster than the long window
        assertEq(binding, 0); // short window binds
        assertEq(vol.sigmaRef(ETH), ss);
    }

    function test_jump_spikes_short_then_long_is_sticky() public {
        vol.poke(ETH);
        // one violent +50% jump
        mock.setPrice(4500e8);
        _advance(1 days);
        uint256 spiked = vol.poke(ETH);
        assertGt(spiked, 2e18); // short window spikes hard (>200%)

        // ~30 calm days: the FAST (1d) window recovers to ~floor...
        for (uint256 i = 0; i < 30; i++) {
            _advance(1 days);
            vol.poke(ETH);
        }
        (uint256 ssMid, uint256 slMid,,) = vol.sigmaComponents(ETH);
        assertLt(ssMid, FLOOR); // the FAST (1d) window has decayed below the floor...
        assertGt(slMid, FLOOR); // ...but the 30d window is STICKY — still elevated (conservative)
        assertEq(vol.sigmaRef(ETH), slMid); // sigma_ref = max(...) is driven by the long window here
        assertLt(vol.sigmaRef(ETH), spiked); // decayed from the spike

        // only after MANY long-halflives does sigma_ref fully return to the floor
        for (uint256 i = 0; i < 250; i++) {
            _advance(1 days);
            vol.poke(ETH);
        }
        assertApproxEqRel(vol.sigmaRef(ETH), FLOOR, 5e15);
    }
}
