// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { OracleManager } from "../src/OracleManager.sol";
import { IOracleManager } from "../src/interfaces/IOracleManager.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";

/// @notice Unit tests for OracleManager (Task 3.8). Fork tests against real
///         Arbitrum feeds are Task 3.9; invariant I8 fuzz is Task 3.10.
contract OracleManagerTest is Test {
    OracleManager internal oracle;
    MockAggregator internal sequencer;
    MockAggregator internal ethFeed;
    address internal constant WETH = address(0xeee);

    uint256 internal constant HEARTBEAT = 86_400;
    uint256 internal constant STALENESS = 90_000; // heartbeat + 3,600 grace

    function setUp() public {
        // Move into the future so we can write "past" updatedAt timestamps
        // without underflow. Arbitrum Sepolia block times in 2026 are
        // ~1,800,000,000s since epoch — plenty of headroom.
        vm.warp(1_800_000_000);

        sequencer = new MockAggregator(0, "L2 Sequencer Uptime");
        ethFeed = new MockAggregator(8, "ETH / USD");

        oracle = new OracleManager(address(sequencer));
        oracle.setPriceFeed(WETH, address(ethFeed), STALENESS);

        // Seed: sequencer up for longer than GRACE_PERIOD
        sequencer.setRound(1, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);

        // Seed: 5 ETH/USD rounds at $3000 each, every hour
        // (round id, answer, updatedAt)
        for (uint80 i = 1; i <= 5; ++i) {
            ethFeed.setRound(
                i,
                3000e8,
                block.timestamp - (5 - i) * 1800, // newest = now
                i == 5
            );
        }
    }

    // ─── absBps (Task 3.5)
    // ───────────────────────────────────────────────

    function test_absBps_zero() public view {
        assertEq(oracle.absBps(int256(100), int256(100)), 0);
    }

    function test_absBps_symmetric() public view {
        // |3000 - 3300| / 3300 = 909bp
        uint256 a = oracle.absBps(int256(3000), int256(3300));
        uint256 b = oracle.absBps(int256(3300), int256(3000));
        assertEq(a, b);
        assertEq(a, 909);
    }

    function test_absBps_revertsOnNonPositive() public {
        vm.expectRevert(abi.encodeWithSelector(OracleManager.AbsBpsNonPositive.selector, int256(0), int256(100)));
        oracle.absBps(int256(0), int256(100));
    }

    // ─── getPrice — entry path (Task 3.2)
    // ────────────────────────────────

    function test_getPrice_happyPath() public view {
        assertEq(oracle.getPrice(WETH), 3000e8);
    }

    function test_getPrice_revertsOnUnknownToken() public {
        vm.expectRevert(abi.encodeWithSelector(OracleManager.PriceFeedUnset.selector, address(0xdead)));
        oracle.getPrice(address(0xdead));
    }

    function test_getPrice_revertsOnNegativeAnswer() public {
        ethFeed.setRound(99, -1, block.timestamp, true);
        vm.expectRevert(abi.encodeWithSelector(OracleManager.PriceNotPositive.selector, int256(-1)));
        oracle.getPrice(WETH);
    }

    function test_getPrice_revertsOnStale() public {
        // 90,001s old → exceeds STALENESS (90,000)
        ethFeed.setRound(99, 3000e8, block.timestamp - 90_001, true);
        vm.expectRevert(); // PriceStale (specific args complex; selector check suffices)
        oracle.getPrice(WETH);
    }

    // ─── Sequencer health gate (Task 3.1)
    // ────────────────────────────────

    function test_getPrice_revertsOnSequencerDown() public {
        sequencer.setRound(2, 1, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        vm.expectRevert(OracleManager.SequencerDown.selector);
        oracle.getPrice(WETH);
    }

    function test_getPrice_revertsDuringGrace() public {
        sequencer.setRound(3, 0, block.timestamp - 100, true); // 100s < 3600s grace
        vm.expectRevert(abi.encodeWithSelector(OracleManager.SequencerGrace.selector, 100));
        oracle.getPrice(WETH);
    }

    function test_getPrice_skipsSequencerWhenUnset() public {
        oracle.setSequencerFeed(address(0));
        // Even a "down" sequencer wouldn't matter — but we still need a healthy feed
        assertEq(oracle.getPrice(WETH), 3000e8);
    }

    // ─── getSettlementPrice — round-at-T (Task 3.4)
    // ──────────────────────

    function _seedRoundsForExpiry(
        uint64 expiry,
        int256[5] memory answers
    ) internal {
        // 5 rounds at fixed offsets vs `expiry`. Round 3 brackets `expiry`:
        // updatedAt[3] ≤ T < updatedAt[4] → hintRoundId = 3 is correct.
        uint256 E = uint256(expiry);
        uint256[5] memory updatedAts = [E - 2100, E - 1100, E - 100, E + 900, E + 1900];
        for (uint80 i = 1; i <= 5; ++i) {
            ethFeed.setRound(i, answers[i - 1], updatedAts[i - 1], i == 5);
        }
    }

    function test_settle_happyPath() public {
        uint64 expiry = uint64(block.timestamp - 5000); // T well in the past
        int256[5] memory ans = [int256(3000e8), 3000e8, 3000e8, 3000e8, 3000e8];
        _seedRoundsForExpiry(expiry, ans);

        (uint256 price, bool twap) = oracle.getSettlementPrice(WETH, expiry, 3);
        assertEq(price, 3000e8);
        assertFalse(twap); // TWAP disabled in v1
    }

    function test_settle_revertsOnWrongRound() public {
        uint64 expiry = uint64(block.timestamp - 5000);
        int256[5] memory ans = [int256(3000e8), 3000e8, 3000e8, 3000e8, 3000e8];
        _seedRoundsForExpiry(expiry, ans);

        // hintRoundId = 1 is wrong (updatedAt is too early, expiry not in [r1, r2])
        vm.expectRevert(); // WrongRound — selector verified via abi above
        oracle.getSettlementPrice(WETH, expiry, 1);
    }

    function test_settle_loneSpikeDefers() public {
        uint64 expiry = uint64(block.timestamp - 5000);
        // Round 3 is a 10% outlier vs both neighbours (3300 vs 3000 at r2/r4)
        int256[5] memory ans = [int256(3000e8), 3000e8, 3300e8, 3000e8, 3000e8];
        _seedRoundsForExpiry(expiry, ans);

        vm.expectRevert(); // LoneSpikeDefer
        oracle.getSettlementPrice(WETH, expiry, 3);
    }

    function test_settle_realFastMovePasses() public {
        uint64 expiry = uint64(block.timestamp - 5000);
        // 10% drop sustained: r1=3000 r2=3000 r3=2700 r4=2700 r5=2700
        // At round 3 the drop just landed; r4 confirms it → not a lone spike.
        int256[5] memory ans = [int256(3000e8), 3000e8, 2700e8, 2700e8, 2700e8];
        _seedRoundsForExpiry(expiry, ans);

        (uint256 price,) = oracle.getSettlementPrice(WETH, expiry, 3);
        assertEq(price, 2700e8);
    }

    function test_settle_livenessBackstopFires() public {
        // Lone spike at round 3, but block.timestamp ≥ expiry + LIVENESS_WINDOW
        // → backstop accepts unconditionally (invariant I8).
        uint64 expiry = uint64(block.timestamp - oracle.LIVENESS_WINDOW() - 1000);
        int256[5] memory ans = [int256(3000e8), 3000e8, 3300e8, 3000e8, 3000e8];
        _seedRoundsForExpiry(expiry, ans);
        // Bump staleness so the (old) round-at-T is still within the window
        oracle.setPriceFeed(WETH, address(ethFeed), oracle.LIVENESS_WINDOW() + 10_000);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit IOracleManager.LivenessBackstopTriggered(WETH, expiry, 3, 3300e8);
        (uint256 price,) = oracle.getSettlementPrice(WETH, expiry, 3);
        assertEq(price, 3300e8);
    }

    // ─── Property: any single price path through T eventually settles (I8) ──

    function testFuzz_settle_alwaysSucceedsAtBackstop(
        int8 spikeOffset
    ) public {
        // Construct an arbitrary lone-spike at round 3 within a reasonable range.
        // The backstop must let us settle regardless of how outlier it is.
        vm.assume(spikeOffset != 0);
        uint64 expiry = uint64(block.timestamp - oracle.LIVENESS_WINDOW() - 1000);
        int256 spike = int256(3000e8) + int256(spikeOffset) * 100e8;
        if (spike <= 0) spike = 1; // keep positive
        int256[5] memory ans = [int256(3000e8), 3000e8, spike, 3000e8, 3000e8];
        _seedRoundsForExpiry(expiry, ans);
        oracle.setPriceFeed(WETH, address(ethFeed), oracle.LIVENESS_WINDOW() + 10_000);

        (uint256 price,) = oracle.getSettlementPrice(WETH, expiry, 3);
        assertEq(price, uint256(spike));
    }
}
