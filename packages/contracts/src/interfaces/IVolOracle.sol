// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  IVolOracle — conservative reference volatility for the cvAMM (Pillar 1 input)
/// @notice Publishes `sigma_ref = max(sigma_short, sigma_long, floor)`, a
///         time-aware EWMA of Chainlink log-returns, consumed by the
///         `FairValueOracle` to price `FairPremium = fairRate(sigma_ref) * MaxIL`.
/// @dev    **Mandatory caveat (spec §6.5):** NEVER price off raw realized
///         sigma — a single fast window understates risk right before a regime
///         change. The `max(short, long, floor)` is the conservative guard. This
///         oracle is **load-bearing for the I10 cap + depositor solvency, NOT for
///         the FULL no-bad-debt invariant (I1)**, which is structural and
///         oracle-independent. Mirrors the Python reference
///         `inflexion_quant.prices.sigma_ref` (P1 deliverable 2). All sigma
///         values are annualised, WAD-scaled (1e18 = 1.0 = 100% vol).
interface IVolOracle {
    /// @notice Emitted on each successful `poke` that folds a new sample in.
    event Poked(
        address indexed token, uint256 priceWad, uint256 dtSeconds, uint256 sigmaShortWad, uint256 sigmaLongWad
    );

    /// @notice Emitted on the first `poke` for a token (EWMA seeded at the floor).
    event Initialized(address indexed token, uint256 priceWad, uint256 floorWad);

    /// @notice Fold the latest Chainlink price for `token` into its EWMA state.
    /// @dev    Permissionless (a keeper or `createSwap` calls it). Reads
    ///         `OracleManager.getPrice` (sequencer-gated, staleness-checked) and
    ///         normalises by `feedDecimals` to WAD. The per-sample variance is
    ///         `ln(p/p_prev)^2 / dt` (per-second), decayed by `0.5^(dt/halflife)`
    ///         on a short and a long window. `dt` is clamped to
    ///         `[minSampleInterval, maxSampleInterval]`; samples inside the min
    ///         interval are rejected (anti-spam, avoids divide-by-tiny-dt blow-up).
    /// @return sigmaRefWad The conservative reference vol after this update.
    function poke(
        address token
    ) external returns (uint256 sigmaRefWad);

    /// @notice `sigma_ref = max(sigma_short, sigma_long, floor)` for `token` (WAD, annualised).
    /// @dev    View. Reverts if `token` has never been poked (no EWMA state).
    function sigmaRef(
        address token
    ) external view returns (uint256 sigmaRefWad);

    /// @notice The component windows + floor behind `sigmaRef` (WAD), for the
    ///         data surface / provenance. `binding` is 0=short, 1=long, 2=floor.
    function sigmaComponents(
        address token
    ) external view returns (uint256 sigmaShortWad, uint256 sigmaLongWad, uint256 floorWad, uint8 binding);

    /// @notice Whether `token` has EWMA state (has been poked at least once).
    function isInitialized(
        address token
    ) external view returns (bool);
}
