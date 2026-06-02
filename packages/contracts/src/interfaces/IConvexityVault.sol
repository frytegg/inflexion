// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  IConvexityVault — pooled passive cvAMM underwriter (Pillar 2, Path A)
/// @notice The core-facing + inventory surface of the dual-tranche ConvexityVault.
///         `createSwap` (Path A) reads inventory for pricing and locks pooled
///         collateral; `settle` releases it and distributes the payout.
interface IConvexityVault {
    enum Tranche {
        SENIOR,
        JUNIOR
    }

    // ─── Core-facing (onlyCore)
    // ───────────────────────────────────────────

    /// @notice Accrue the underwriter's premium share into the pool, split
    ///         senior/junior (senior takes the small base-yield slice). Pulls
    ///         `amount` USDC from the caller (Core).
    function accruePremium(
        uint256 amount
    ) external;

    /// @notice Lock `amount` of pooled USDC as FULL collateral (= MaxIL) for a
    ///         swap in `marketId`. Reverts unless `free ≥ amount` AND
    ///         `totalLocked + amount ≤ juniorAssets` (the structural
    ///         senior-protection invariant — junior absorbs all underwriting
    ///         loss). Updates the per-market concentration accumulator.
    function lockCollateral(
        bytes32 marketId,
        uint256 amount
    ) external;

    /// @notice Settle a Path-A swap: pay `payout` (≤ `lockedAmount`) to `lp`,
    ///         unlock `lockedAmount`, and apply the `payout` loss junior-first.
    function releaseAndDistribute(
        bytes32 marketId,
        address lp,
        uint256 payout,
        uint256 lockedAmount
    ) external;

    // ─── Inventory (for Path-A pricing)
    // ───────────────────────────────────

    /// @notice `(totalAssets, locked, free, utilizationWad, concentrationWad)`.
    ///         `utilizationWad = locked/total` feeds `util_skew`;
    ///         `concentrationWad` (normalised HHI over per-market locked) feeds
    ///         `dispersion_skew`.
    function inventory()
        external
        view
        returns (uint256 totalAssets, uint256 locked, uint256 free, uint256 utilizationWad, uint256 concentrationWad);

    function totalAssets() external view returns (uint256);
    function freeAssets() external view returns (uint256);
    function utilizationWad() external view returns (uint256);
    function seniorAssets() external view returns (uint256);
    function juniorAssets() external view returns (uint256);
}
