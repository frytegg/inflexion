// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  IOracleManager — pricing surface for Inflexion settlement
/// @notice Wraps Chainlink (entry + settlement price) + Uniswap v3 TWAP
///         (advisory) behind a single sequencer-aware contract. The
///         settlement-price path is deadlock-free per spec §6.1 (Fork 1 —
///         Option B): a lone-spike check defers suspicious rounds, with a
///         hard liveness backstop that accepts the round at expiry
///         unconditionally past `LIVENESS_WINDOW` so funds cannot lock
///         indefinitely (invariant **I8**).
/// @dev    Spec references:
///           * `spec.md` §6.1 — `getSettlementPrice` round-at-T logic
///           * `spec.md` §6.2 — parameter table (heartbeats, LONE_SPIKE_BPS)
///           * `spec.md` §6.3 — edge cases
///           * `spec.md` §13  — invariants I8 (settlement liveness)
interface IOracleManager {
    // ─── Events
    // ───────────────────────────────────────────────────────────

    /// @notice Emitted by `getSettlementPrice` when the Uniswap TWAP deviates
    ///         from the Chainlink round-at-T by more than `MAX_DEVIATION_BPS`.
    /// @dev    **Advisory only** — does NOT block settlement (spec §6.1).
    ///         Consumed by the off-chain data surface + guardian alerts.
    event TWAPAdvisory(
        address indexed token, uint64 indexed expiry, uint256 chainlinkPrice, uint256 twapPrice, uint256 deviationBps
    );

    /// @notice Emitted when `getSettlementPrice` defers due to a lone-spike
    ///         outlier vs both neighbouring rounds. Settlement may retry.
    event LoneSpikeDeferred(
        address indexed token,
        uint64 indexed expiry,
        uint80 hintRoundId,
        uint256 price,
        uint256 prevDeviationBps,
        uint256 nextDeviationBps
    );

    /// @notice Emitted once the `LIVENESS_WINDOW` past `expiry` has elapsed
    ///         and a previously-deferred round-at-T is now accepted
    ///         unconditionally — the no-permanent-lock backstop (I8).
    event LivenessBackstopTriggered(address indexed token, uint64 indexed expiry, uint80 hintRoundId, uint256 price);

    // ─── Reads
    // ────────────────────────────────────────────────────────────

    /// @notice Current entry price for `token`, denominated against the
    ///         feed's quote asset (USD for our majors). Used at `createSwap`.
    /// @dev    Runs the sequencer health gate (uptime + grace) and staleness
    ///         check. Reverts on any failure (spec §6.1 step 1 + 2 without
    ///         the round-pinning of settlement).
    /// @param  token  Underlying token to price.
    /// @return price  Latest Chainlink answer cast to `uint256` (already
    ///                positive after the underflow check).
    function getPrice(
        address token
    ) external view returns (uint256 price);

    /// @notice Settlement price for `token` pinned to expiry `T` per spec §6.1.
    /// @dev    Caller supplies `hintRoundId` — the Chainlink round whose
    ///         `updatedAt ≤ T < nextUpdatedAt`. Off-chain matchmaker /
    ///         keeper computes this; the contract verifies the bound, then
    ///         runs the lone-spike sanity check (vs prev + next rounds).
    ///         Deferral: reverts with `"lone-spike: defer"` unless we are
    ///         past `expiry + LIVENESS_WINDOW` (backstop, invariant I8).
    /// @param  token        Underlying token.
    /// @param  expiry       Settlement timestamp `T`.
    /// @param  hintRoundId  Chainlink round id active at `T`.
    /// @return price        Pinned settlement price.
    /// @return twapAdvisory `true` iff the Uniswap TWAP over
    ///                      `[T-TWAP_WINDOW, T]` deviates by more than
    ///                      `MAX_DEVIATION_BPS` from the pinned price.
    ///                      Informational only (event-emitted); never blocks.
    /// @dev    **TWAP advisory is currently a no-op** (always `false`) —
    ///         emitting it requires per-market tick→price scaling, which is
    ///         Phase 3.7 follow-up work. Skipping it is spec-compliant
    ///         because the advisory is non-blocking by design (§6.1).
    function getSettlementPrice(
        address token,
        uint64 expiry,
        uint80 hintRoundId
    ) external returns (uint256 price, bool twapAdvisory);

    /// @notice Historical Uniswap v3 time-weighted average **tick** for
    ///         `token`'s designated pool, over a `window` ending at `anchor`.
    /// @dev    Returns the raw average tick (not a normalized price).
    ///         Converting a tick to a feed-comparable price requires the
    ///         pool's `token0` / `token1` decimals — out of scope for this
    ///         primitive. Use OracleLibrary.getQuoteAtTick from
    ///         v3-periphery in the caller for normalization. Requires the
    ///         pool's observation cardinality to cover
    ///         `[anchor-window, anchor]` — call
    ///         `script/IncreaseCardinality.s.sol` per market at deploy.
    /// @param  token   Token whose pool we read.
    /// @param  window  Seconds of TWAP window (`TWAP_WINDOW` = 1800 by default).
    /// @param  anchor  Timestamp to anchor the window's RIGHT edge.
    ///                 `anchor - window` is the LEFT edge.
    /// @return avgTick Time-weighted average tick over the window.
    function uniswapTWAPat(
        address token,
        uint32 window,
        uint64 anchor
    ) external view returns (int256 avgTick);

    // ─── Pure helper
    // ──────────────────────────────────────────────────────

    /// @notice `|a - b| / max(a, b)` in basis points (1 bp = 0.01%).
    /// @dev    Both inputs must be positive; the function works on `int256`
    ///         so it can be reused for signed Chainlink answers.
    function absBps(
        int256 a,
        int256 b
    ) external pure returns (uint256 bps);
}
