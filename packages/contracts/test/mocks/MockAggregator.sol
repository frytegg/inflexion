// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AggregatorV2V3Interface } from "@chainlink/shared/interfaces/AggregatorV2V3Interface.sol";

/// @notice Controllable Chainlink aggregator mock for OracleManager tests.
///         Supports arbitrary per-round answers + `updatedAt` timestamps so
///         we can simulate round-at-T pinning, lone-spike windows, staleness,
///         and missing rounds (`getRoundData(roundId)` reverts if unset).
contract MockAggregator is AggregatorV2V3Interface {
    struct Round {
        int256 answer;
        uint256 updatedAt;
        bool set;
    }

    uint8 private immutable _decimals;
    string private _description;
    uint80 public latestRound_;
    mapping(uint80 => Round) public rounds;

    error RoundNotSet(uint80 roundId);

    constructor(
        uint8 dec,
        string memory desc
    ) {
        _decimals = dec;
        _description = desc;
    }

    // ── Test setters
    // ──────────────────────────────────────────────────────

    /// @notice Set round data and (optionally) bump latestRound to it.
    function setRound(
        uint80 roundId,
        int256 answer,
        uint256 updatedAt,
        bool bumpLatest
    ) external {
        rounds[roundId] = Round({ answer: answer, updatedAt: updatedAt, set: true });
        if (bumpLatest) latestRound_ = roundId;
    }

    function setLatest(
        uint80 roundId
    ) external {
        require(rounds[roundId].set, "MockAggregator: round not set");
        latestRound_ = roundId;
    }

    // ── AggregatorV3Interface
    // ─────────────────────────────────────────────

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(
        uint80 roundId
    ) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[roundId];
        if (!r.set) revert RoundNotSet(roundId);
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint80 rid = latestRound_;
        Round memory r = rounds[rid];
        if (!r.set) revert RoundNotSet(rid);
        return (rid, r.answer, r.updatedAt, r.updatedAt, rid);
    }

    // ── AggregatorInterface (v2 — unused by OracleManager but required by ABI) ──

    function latestAnswer() external view returns (int256) {
        return rounds[latestRound_].answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return rounds[latestRound_].updatedAt;
    }

    function latestRound() external view returns (uint256) {
        return uint256(latestRound_);
    }

    function getAnswer(
        uint256 roundId
    ) external view returns (int256) {
        return rounds[uint80(roundId)].answer;
    }

    function getTimestamp(
        uint256 roundId
    ) external view returns (uint256) {
        return rounds[uint80(roundId)].updatedAt;
    }
}
