// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Uniswap v3 pool mock used by Inflexion tests.
///         Implements only the surface OracleManager and IncreaseCardinality
///         depend on:
///           * `slot0()` — returns the controllable cardinality fields
///           * `increaseObservationCardinalityNext(uint16)` — records calls
///           * `observe(uint32[])` — returns scripted cumulative ticks
///         Other v3-core methods are intentionally omitted; the mock does
///         NOT inherit `IUniswapV3Pool` to keep its interface minimal and
///         the dependency surface explicit.
contract MockUniswapV3Pool {
    uint160 public sqrtPriceX96;
    int24 public tick;
    uint16 public observationIndex;
    uint16 public observationCardinality;
    uint16 public observationCardinalityNext;
    uint8 public feeProtocol;
    bool public unlocked = true;

    /// @notice Recorded list of cardinalities that
    ///         `increaseObservationCardinalityNext` was called with — used
    ///         by tests to assert call counts and arguments.
    uint16[] public bumpHistory;

    /// @notice Test-controllable cumulative ticks returned by `observe`.
    ///         When set, the mock returns this array verbatim (ignoring the
    ///         input `secondsAgos`). When unset (empty), `observe` reverts.
    int56[] private _scriptedCumulativeTicks;
    uint160[] private _scriptedSecondsPerLiquidityX128;

    function setCardinalityNext(
        uint16 next
    ) external {
        observationCardinalityNext = next;
    }

    function setSlot0(
        uint16 cardinality,
        uint16 cardinalityNext
    ) external {
        observationCardinality = cardinality;
        observationCardinalityNext = cardinalityNext;
    }

    function scriptObserve(
        int56[] calldata cumulativeTicks,
        uint160[] calldata spl
    ) external {
        delete _scriptedCumulativeTicks;
        delete _scriptedSecondsPerLiquidityX128;
        for (uint256 i = 0; i < cumulativeTicks.length; ++i) {
            _scriptedCumulativeTicks.push(cumulativeTicks[i]);
        }
        for (uint256 i = 0; i < spl.length; ++i) {
            _scriptedSecondsPerLiquidityX128.push(spl[i]);
        }
    }

    // ─── v3-core surface (subset)
    // ─────────────────────────────────────────

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (
            sqrtPriceX96,
            tick,
            observationIndex,
            observationCardinality,
            observationCardinalityNext,
            feeProtocol,
            unlocked
        );
    }

    function increaseObservationCardinalityNext(
        uint16 next
    ) external {
        bumpHistory.push(next);
        if (next > observationCardinalityNext) {
            observationCardinalityNext = next;
        }
    }

    function observe(
        uint32[] calldata
    ) external view returns (int56[] memory tickCumulatives, uint160[] memory spl) {
        require(_scriptedCumulativeTicks.length > 0, "MockUniswapV3Pool: not scripted");
        return (_scriptedCumulativeTicks, _scriptedSecondsPerLiquidityX128);
    }

    function bumpCount() external view returns (uint256) {
        return bumpHistory.length;
    }
}
