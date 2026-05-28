// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AggregatorV2V3Interface } from "@chainlink/shared/interfaces/AggregatorV2V3Interface.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import { IOracleManager } from "./interfaces/IOracleManager.sol";

/// @title  OracleManager — Chainlink-anchored pricing for Inflexion
/// @notice Wraps Chainlink (entry + settlement) + Uniswap v3 TWAP (advisory,
///         disabled in v1) behind a sequencer-aware contract. Settlement uses
///         the Fork-1 / Option-B design (round-at-T pinning + lone-spike +
///         liveness backstop) per spec §6.1.
/// @dev    `sequencerFeed == address(0)` skips the sequencer health gate.
///         This is the documented testnet/local path; **must be set before
///         any mainnet deploy**. See `deployments/arbitrum-*.json`.
contract OracleManager is IOracleManager, Ownable {
    // ─── Constants (spec §6.2; do not edit without bumping the deploy) ────

    /// @notice Chainlink-recommended sequencer recovery grace.
    uint256 public constant GRACE_PERIOD = 3600;
    /// @notice Max deferral by the lone-spike check; past this the round-at-T
    ///         is accepted unconditionally (invariant I8).
    uint256 public constant LIVENESS_WINDOW = 86_400;
    /// @notice Uniswap TWAP window when used (currently unused — see header).
    uint32 public constant TWAP_WINDOW = 1800;
    /// @notice Lone-spike threshold (basis points). A glitched print differs
    ///         from BOTH neighbours by ≥ this; real fast moves persist and pass.
    uint256 public constant LONE_SPIKE_BPS = 500;
    /// @notice Advisory-only deviation threshold for the (disabled in v1) TWAP.
    uint256 public constant MAX_DEVIATION_BPS = 200;

    uint256 private constant _BPS = 10_000;

    // ─── Configurable state
    // ───────────────────────────────────────────────

    /// @notice L2 sequencer uptime feed. `address(0)` skips the check
    ///         (testnet-only path).
    AggregatorV2V3Interface public sequencerFeed;

    /// @notice Per-token Chainlink price feeds.
    mapping(address => AggregatorV2V3Interface) public priceFeed;

    /// @notice Per-token max staleness (seconds). MUST be ≥ feed heartbeat.
    ///         Spec §6.2 recommends `heartbeat + 3600` (90,000 for Arbitrum
    ///         majors).
    mapping(address => uint256) public maxStaleness;

    /// @notice Per-token Uniswap v3 pool used for the TWAP advisory.
    ///         May be unset; if so, `uniswapTWAPat` reverts on read but
    ///         `getSettlementPrice` proceeds (TWAP is advisory).
    mapping(address => IUniswapV3Pool) public uniswapPool;

    // ─── Errors
    // ───────────────────────────────────────────────────────────

    error SequencerDown();
    error SequencerGrace(uint256 secondsSinceUp);
    error PriceFeedUnset(address token);
    error PoolUnset(address token);
    error PriceNotPositive(int256 answer);
    error PriceStale(address token, uint256 updatedAt, uint256 maxAllowed);
    error WrongRound(uint80 hintRoundId, uint256 updatedAt, uint256 nextUpdatedAt, uint64 expiry);
    error LoneSpikeDefer(uint80 hintRoundId, uint256 prevDevBps, uint256 nextDevBps);
    error MissingNeighborRound(uint80 missingRoundId);
    error AnchorInFuture(uint64 anchor, uint256 nowTs);
    error WindowZero();
    error AbsBpsNonPositive(int256 a, int256 b);

    // ─── Constructor
    // ──────────────────────────────────────────────────────

    /// @param _sequencerFeed Sequencer uptime feed (0 to skip on testnet).
    constructor(
        address _sequencerFeed
    ) Ownable(msg.sender) {
        sequencerFeed = AggregatorV2V3Interface(_sequencerFeed);
    }

    // ─── Admin
    // ────────────────────────────────────────────────────────────

    function setSequencerFeed(
        address feed
    ) external onlyOwner {
        sequencerFeed = AggregatorV2V3Interface(feed);
    }

    /// @notice Register a Chainlink price feed for `token` with its staleness
    ///         budget. Spec §6.2 recommends `heartbeat + 3600` (= 90,000s
    ///         for Arbitrum majors).
    function setPriceFeed(
        address token,
        address feed,
        uint256 maxStaleness_
    ) external onlyOwner {
        priceFeed[token] = AggregatorV2V3Interface(feed);
        maxStaleness[token] = maxStaleness_;
    }

    /// @notice Register the Uniswap v3 pool used for the TWAP advisory.
    ///         Pass `address(0)` to disable TWAP reads for `token`.
    function setUniswapPool(
        address token,
        address pool
    ) external onlyOwner {
        uniswapPool[token] = IUniswapV3Pool(pool);
    }

    // ─── Sequencer health gate (Task 3.1)
    // ────────────────────────────────

    /// @dev Reverts if the L2 sequencer is down or still in the recovery
    ///      grace window. Skipped entirely when `sequencerFeed` is unset
    ///      (testnet path).
    function _requireSequencerHealthy() internal view {
        if (address(sequencerFeed) == address(0)) return;
        (, int256 up,, uint256 updatedAt,) = sequencerFeed.latestRoundData();
        // Chainlink convention: 0 = up, 1 = down.
        if (up != 0) revert SequencerDown();
        // Defensive: future-dated updatedAt would underflow the subtraction.
        // Treat that as "no grace observed" → fail closed.
        if (updatedAt > block.timestamp) revert SequencerGrace(0);
        unchecked {
            uint256 elapsed = block.timestamp - updatedAt;
            if (elapsed < GRACE_PERIOD) revert SequencerGrace(elapsed);
        }
    }

    // ─── getPrice — entry price (Task 3.2)
    // ───────────────────────────────

    function getPrice(
        address token
    ) external view returns (uint256) {
        _requireSequencerHealthy();
        AggregatorV2V3Interface f = priceFeed[token];
        if (address(f) == address(0)) revert PriceFeedUnset(token);
        (, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
        if (answer <= 0) revert PriceNotPositive(answer);
        uint256 maxAllowed = maxStaleness[token];
        // `updatedAt` should always be ≤ block.timestamp for honest feeds;
        // a future-dated answer would underflow → fail closed.
        if (updatedAt > block.timestamp) {
            revert PriceStale(token, updatedAt, maxAllowed);
        }
        unchecked {
            if (block.timestamp - updatedAt > maxAllowed) {
                revert PriceStale(token, updatedAt, maxAllowed);
            }
        }
        return uint256(answer);
    }

    // ─── absBps pure helper (Task 3.5)
    // ───────────────────────────────────

    function absBps(
        int256 a,
        int256 b
    ) public pure returns (uint256) {
        if (a <= 0 || b <= 0) revert AbsBpsNonPositive(a, b);
        uint256 ua = uint256(a);
        uint256 ub = uint256(b);
        (uint256 lo, uint256 hi) = ua < ub ? (ua, ub) : (ub, ua);
        // hi > 0 (since both > 0), no div-by-zero
        return ((hi - lo) * _BPS) / hi;
    }

    // ─── uniswapTWAPat — average tick over window (Task 3.3) ─────────────

    /// @inheritdoc IOracleManager
    function uniswapTWAPat(
        address token,
        uint32 window,
        uint64 anchor
    ) public view returns (int256 avgTick) {
        if (window == 0) revert WindowZero();
        IUniswapV3Pool pool = uniswapPool[token];
        if (address(pool) == address(0)) revert PoolUnset(token);
        if (uint256(anchor) > block.timestamp) {
            revert AnchorInFuture(anchor, block.timestamp);
        }

        // pool.observe wants seconds-ago from NOW. The window is
        // [anchor − window, anchor], so:
        //   secondsAgo_left  = (now − anchor) + window  // older
        //   secondsAgo_right = (now − anchor)           // newer
        uint32 nowU = uint32(block.timestamp);
        uint32 secondsAgoRight = nowU - uint32(anchor);
        uint32 secondsAgoLeft = secondsAgoRight + window;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgoLeft;
        secondsAgos[1] = secondsAgoRight;

        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
        // (right − left) is the cumulative tick over `window` seconds.
        // Average tick = delta / window. Mirrors v3-periphery OracleLibrary.consult.
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        avgTick = int256(delta) / int256(uint256(window));
    }

    // ─── getSettlementPrice — round-at-T + lone-spike + backstop (Task 3.4) ──

    function getSettlementPrice(
        address token,
        uint64 expiry,
        uint80 hintRoundId
    ) external returns (uint256 price, bool twapAdvisory) {
        // 1. Sequencer + grace
        _requireSequencerHealthy();
        AggregatorV2V3Interface f = priceFeed[token];
        if (address(f) == address(0)) revert PriceFeedUnset(token);

        // 2. Round at expiry T (the pinned round)
        (, int256 px,, uint256 updatedAt,) = f.getRoundData(hintRoundId);
        (, int256 pxNext,, uint256 nextUpdatedAt,) = f.getRoundData(hintRoundId + 1);

        // Caller-supplied hintRoundId MUST satisfy: updatedAt ≤ T < nextUpdatedAt
        if (!(updatedAt <= uint256(expiry) && uint256(expiry) < nextUpdatedAt)) {
            revert WrongRound(hintRoundId, updatedAt, nextUpdatedAt, expiry);
        }
        if (px <= 0) revert PriceNotPositive(px);
        if (pxNext <= 0) revert PriceNotPositive(pxNext);

        // 2b. Staleness — the pinned round's updatedAt must not be too old
        uint256 maxAllowed = maxStaleness[token];
        if (updatedAt > block.timestamp) revert PriceStale(token, updatedAt, maxAllowed);
        unchecked {
            if (block.timestamp - updatedAt > maxAllowed) {
                revert PriceStale(token, updatedAt, maxAllowed);
            }
        }

        // 3. Lone-spike sanity check — outlier vs BOTH neighbours
        //    is a Chainlink glitch (real fast moves persist across rounds).
        //    Backstop: past expiry + LIVENESS_WINDOW, accept px unconditionally
        //    so funds can never lock indefinitely (invariant I8).
        bool backstop = block.timestamp >= uint256(expiry) + LIVENESS_WINDOW;

        // hintRoundId − 1 may not exist for the very first round of a feed.
        // We tolerate a missing prev round by treating it as "not lone-spike".
        // For Chainlink feeds in production this never happens (every feed
        // has a long history); we still guard against the degenerate case.
        if (hintRoundId == 0) {
            // Cannot compute prev neighbour — accept the round (with backstop
            // tracking still emitted if applicable).
        } else {
            (, int256 pxPrev,,,) = f.getRoundData(hintRoundId - 1);
            if (pxPrev > 0) {
                uint256 prevBps = absBps(px, pxPrev);
                uint256 nextBps = absBps(px, pxNext);
                if (prevBps >= LONE_SPIKE_BPS && nextBps >= LONE_SPIKE_BPS) {
                    if (!backstop) {
                        emit LoneSpikeDeferred(token, expiry, hintRoundId, uint256(px), prevBps, nextBps);
                        revert LoneSpikeDefer(hintRoundId, prevBps, nextBps);
                    }
                    // Backstop fired — accept anyway, emit so monitoring sees it.
                    emit LivenessBackstopTriggered(token, expiry, hintRoundId, uint256(px));
                }
            }
        }

        // 4. Uniswap TWAP advisory — currently a no-op (see contract header).
        //    Spec-compliant because the advisory is non-blocking by design.
        //    Wiring it requires per-market tick→price scaling (Task 3.7).
        twapAdvisory = false;

        return (uint256(px), twapAdvisory);
    }
}
