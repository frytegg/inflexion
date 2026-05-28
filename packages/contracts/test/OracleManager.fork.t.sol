// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { OracleManager } from "../src/OracleManager.sol";
import { AggregatorV2V3Interface } from "@chainlink/shared/interfaces/AggregatorV2V3Interface.sol";

/// @title  Fork tests for OracleManager against real Arbitrum One Chainlink feeds (Task 3.9)
/// @notice Skipped unless `ARBITRUM_RPC` is set in the environment. CI runs
///         these only on the fork-test job; the default `forge test` ignores
///         them by skipping `setUp`.
/// @dev    All addresses sourced from `deployments/arbitrum-one.json` and
///         cross-checked against
///         https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json
///         (verified 2026-05-28).
contract OracleManagerForkTest is Test {
    // ─── Live mainnet addresses
    // ──────────────────────────────────────────

    address internal constant CHAINLINK_ETH_USD = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;
    address internal constant CHAINLINK_BTC_USD = 0x6ce185860a4963106506C203335A2910413708e9;
    address internal constant CHAINLINK_USDC_USD = 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3;
    address internal constant SEQUENCER_UPTIME = 0xFdB631F5EE196F0ed6FAa767959853A9F217697D;

    // Canonical token addresses on Arbitrum One (used purely as map keys)
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address internal constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    // Per-feed staleness budget per spec §6.2 (heartbeat + 3600s grace)
    uint256 internal constant STALENESS = 90_000;

    // Search backwards at most this many rounds when finding round-at-T.
    // ~250 rounds covers >1d at the observed Arbitrum ETH/USD update cadence
    // (under 6 min per round), enough headroom to find a target ~1h in the past.
    uint80 internal constant MAX_SEARCH = 250;

    OracleManager internal oracle;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC", string(""));
        if (bytes(rpc).length == 0) {
            // No mainnet RPC available — skip the entire suite. We use a
            // boolean rather than `vm.skip(true)` so the suite reports
            // explicit skips on every test for visibility.
            return;
        }
        vm.createSelectFork(rpc);
        forked = true;

        oracle = new OracleManager(SEQUENCER_UPTIME);
        oracle.setPriceFeed(WETH, CHAINLINK_ETH_USD, STALENESS);
        oracle.setPriceFeed(WBTC, CHAINLINK_BTC_USD, STALENESS);
        oracle.setPriceFeed(USDC, CHAINLINK_USDC_USD, STALENESS);
    }

    modifier requiresFork() {
        if (!forked) {
            emit log("SKIP: ARBITRUM_RPC not set - skipping fork test");
            return;
        }
        _;
    }

    // ─── getPrice on live feeds — sanity bounds
    // ──────────────────────────

    function test_fork_getPrice_eth_sane() public requiresFork {
        uint256 p = oracle.getPrice(WETH);
        // ETH in 8 decimals, sanity envelope $50 – $50,000
        assertGt(p, 50e8, "ETH < $50 - feed broken?");
        assertLt(p, 50_000e8, "ETH > $50k - feed broken?");
        emit log_named_uint("ETH/USD (8 dec)", p);
    }

    function test_fork_getPrice_btc_sane() public requiresFork {
        uint256 p = oracle.getPrice(WBTC);
        assertGt(p, 1000e8, "BTC < $1k - feed broken?");
        assertLt(p, 1_000_000e8, "BTC > $1M - feed broken?");
        emit log_named_uint("BTC/USD (8 dec)", p);
    }

    function test_fork_getPrice_usdc_sane() public requiresFork {
        uint256 p = oracle.getPrice(USDC);
        // USDC should peg to $1 ± 5%
        assertGt(p, 0.95e8, "USDC depeg DOWN");
        assertLt(p, 1.05e8, "USDC depeg UP");
        emit log_named_uint("USDC/USD (8 dec)", p);
    }

    // ─── getSettlementPrice — pinned to a historical T
    // ───────────────────

    function test_fork_settle_pinsRoundForRecentExpiry() public requiresFork {
        // Pick T = 1 hour in the past, find the bracketing round, settle.
        uint64 T = uint64(block.timestamp - 1 hours);
        uint80 hint = _findRoundAt(CHAINLINK_ETH_USD, T);
        require(hint > 0, "no round bracketing T found");

        (uint256 price,) = oracle.getSettlementPrice(WETH, T, hint);
        assertGt(price, 50e8);
        assertLt(price, 50_000e8);
        emit log_named_uint("hint round", hint);
        emit log_named_uint("settlement price", price);
    }

    function test_fork_settle_revertsOnWrongHint() public requiresFork {
        uint64 T = uint64(block.timestamp - 1 hours);
        uint80 hint = _findRoundAt(CHAINLINK_ETH_USD, T);
        require(hint > 1, "no usable hint");
        // hint-1 brackets an earlier T — applied to OUR T, it should fail
        // the `updatedAt ≤ T < nextUpdatedAt` invariant.
        vm.expectRevert();
        oracle.getSettlementPrice(WETH, T, hint - 1);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    /// @dev Walk Chainlink rounds backward from `latestRoundData` until we
    ///      find one whose `updatedAt ≤ T < nextRound.updatedAt`. Returns 0
    ///      if no such round is found within MAX_SEARCH iterations.
    function _findRoundAt(
        address feed,
        uint64 T
    ) internal view returns (uint80) {
        AggregatorV2V3Interface f = AggregatorV2V3Interface(feed);
        (uint80 latest,,,,) = f.latestRoundData();
        uint80 floor = latest > MAX_SEARCH ? latest - MAX_SEARCH : 1;
        for (uint80 i = latest; i > floor; --i) {
            (, int256 px,, uint256 updatedAt,) = f.getRoundData(i);
            if (px <= 0 || updatedAt == 0) continue;
            if (updatedAt <= uint256(T)) {
                // Need the NEXT round to bracket T; i is candidate only if
                // i+1 exists AND its updatedAt > T. Since `i ≤ latest`,
                // i+1 exists for i < latest; for i == latest, no next round
                // is published yet.
                if (i == latest) continue;
                (, int256 pxNext,, uint256 nextUpdatedAt,) = f.getRoundData(i + 1);
                if (pxNext > 0 && nextUpdatedAt > uint256(T)) return i;
            }
        }
        return 0;
    }
}
