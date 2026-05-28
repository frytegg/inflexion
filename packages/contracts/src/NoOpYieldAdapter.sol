// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";

/// @title  NoOpYieldAdapter — Phase 1 default adapter (zero yield)
/// @notice Just holds USDC and gives it back on withdraw. Per-MM accounting
///         is identity bookkeeping; no external venue, no yield, no risk of
///         a utilization-gated withdraw revert. This is the **only adapter
///         used during the hackathon demo** — yield wrappers come in Phase 2+
///         once we have audit-grade adapters for the locked-collateral path.
/// @dev    Anyone can call `deposit` / `withdraw`. The `UnderwriterVault`
///         is the intended caller; that contract enforces per-MM
///         accounting before delegating here.
contract NoOpYieldAdapter is IYieldAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    mapping(address => uint256) public balanceOf;

    error InsufficientBalance(address mm, uint256 requested, uint256 available);

    constructor(
        IERC20 _usdc
    ) {
        usdc = _usdc;
    }

    /// @inheritdoc IYieldAdapter
    function deposit(
        address mm,
        uint256 amount
    ) external returns (uint256) {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[mm] += amount;
        return amount;
    }

    /// @inheritdoc IYieldAdapter
    function withdraw(
        address mm,
        uint256 amount
    ) external returns (uint256) {
        uint256 bal = balanceOf[mm];
        if (bal < amount) revert InsufficientBalance(mm, amount, bal);
        unchecked {
            balanceOf[mm] = bal - amount;
        }
        usdc.safeTransfer(msg.sender, amount);
        return amount;
    }

    /// @inheritdoc IYieldAdapter
    function balance(
        address mm
    ) external view returns (uint256) {
        return balanceOf[mm];
    }

    /// @inheritdoc IYieldAdapter
    function underlying() external view returns (address) {
        return address(usdc);
    }

    /// @inheritdoc IYieldAdapter
    function isInstantlyRedeemable() external pure returns (bool) {
        return true; // pure storage, never gated
    }
}
