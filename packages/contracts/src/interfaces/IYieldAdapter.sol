// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  IYieldAdapter — pluggable yield routing for MM collateral
/// @notice The `UnderwriterVault` parks all USDC inside an `IYieldAdapter`.
///         Phase 1 ships a `NoOpYieldAdapter` (zero yield, instantly liquid);
///         Phase 2+ will plug in tokenized-T-bill / sDAI-type wrappers so
///         MMs **earn base yield while their collateral is locked**.
/// @dev    Hard rule (Fork F-#3, spec §7.2): adapters MUST be **instantly
///         redeemable, not utilization-gated**. Never route locked
///         collateral into Aave / Compound / any pool whose `withdraw` can
///         revert under high utilization — in a correlated crash,
///         `releaseAndDistribute` at settlement would fail and silently
///         break the no-bad-debt guarantee through an external dependency.
///
///         The Vault is responsible for never exceeding `balance(mm)` on
///         `withdraw` for a given MM — the adapter just trusts the caller.
interface IYieldAdapter {
    /// @notice Pull `amount` of USDC from `msg.sender` (the Vault) and
    ///         credit it to `mm`'s book.
    /// @return deposited Amount actually accepted (= `amount` for no-op /
    ///                   liquid adapters; may differ if a future adapter
    ///                   has slippage at deposit time).
    function deposit(
        address mm,
        uint256 amount
    ) external returns (uint256 deposited);

    /// @notice Withdraw `amount` of USDC for `mm` and transfer to
    ///         `msg.sender`. MUST succeed if `balance(mm) >= amount`.
    /// @return withdrawn Amount actually returned.
    function withdraw(
        address mm,
        uint256 amount
    ) external returns (uint256 withdrawn);

    /// @notice Current USDC balance attributed to `mm` (principal + any
    ///         accrued yield realised so far).
    function balance(
        address mm
    ) external view returns (uint256);

    /// @notice The USDC token this adapter operates on.
    function underlying() external view returns (address);

    /// @notice True iff this adapter can always honour a full `withdraw`
    ///         of `balance(mm)` in the same block. Required to be `true`
    ///         for any adapter holding *locked* collateral (Fork F-#3).
    function isInstantlyRedeemable() external view returns (bool);
}
