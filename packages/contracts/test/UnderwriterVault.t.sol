// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { UnderwriterVault } from "../src/UnderwriterVault.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

/// @notice Unit + invariant tests for `UnderwriterVault` (Task 4.4).
///         Spec §7.1 / invariant **I5** (`locked ≤ deposited` per MM).
contract UnderwriterVaultTest is Test {
    UnderwriterVault internal vault;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal core = makeAddr("core");
    address internal mm = makeAddr("mm");
    address internal lp = makeAddr("lp");
    address internal otherMM = makeAddr("otherMM");

    uint256 internal constant DEPOSIT = 100_000e6; // $100k USDC

    function setUp() public {
        vm.prank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        vault = new UnderwriterVault(usdc);
        vm.prank(owner);
        vault.setCore(core);

        // Mint + approve so the MM can deposit
        usdc.mint(mm, DEPOSIT * 10);
        vm.prank(mm);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Deposit / withdraw
    // ──────────────────────────────────────────────

    function test_deposit_increasesDepositedAndPullsTokens() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        assertEq(vault.deposited(mm), DEPOSIT);
        assertEq(vault.availableBalance(mm), DEPOSIT);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT);
    }

    function test_withdraw_happy_returnsTokens() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(mm);
        vault.withdraw(DEPOSIT / 2);
        assertEq(vault.deposited(mm), DEPOSIT / 2);
        assertEq(usdc.balanceOf(mm), DEPOSIT * 10 - DEPOSIT / 2);
    }

    function test_withdraw_overAvailable_reverts() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(mm);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwriterVault.InsufficientAvailable.selector, mm, DEPOSIT + 1, DEPOSIT)
        );
        vault.withdraw(DEPOSIT + 1);
    }

    function test_withdraw_oversLocked_reverts() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(core);
        vault.lockCollateral(mm, DEPOSIT / 2);
        // Available is DEPOSIT/2 now
        vm.prank(mm);
        vm.expectRevert();
        vault.withdraw(DEPOSIT / 2 + 1);
    }

    // ─── lockCollateral
    // ──────────────────────────────────────────────────

    function test_lock_happy() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(core);
        vault.lockCollateral(mm, 30_000e6);
        assertEq(vault.locked(mm), 30_000e6);
        assertEq(vault.availableBalance(mm), 70_000e6);
    }

    function test_lock_overAvailable_reverts() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(core);
        vm.expectRevert();
        vault.lockCollateral(mm, DEPOSIT + 1);
    }

    function test_lock_onlyCore() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(mm);
        vm.expectRevert(UnderwriterVault.OnlyCore.selector);
        vault.lockCollateral(mm, 1);
    }

    function test_lock_emitsCapitalLow_belowThreshold() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        // Lock 85% → available 15% < 20% threshold → CapitalLow fires
        uint256 lockAmt = (DEPOSIT * 85) / 100;
        vm.expectEmit(true, false, false, true, address(vault));
        emit UnderwriterVault.CapitalLow(mm, DEPOSIT - lockAmt);
        vm.prank(core);
        vault.lockCollateral(mm, lockAmt);
    }

    function test_lock_doesNotEmitCapitalLow_aboveThreshold() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        // Lock 50% → available 50% > 20% threshold → no event
        vm.recordLogs();
        vm.prank(core);
        vault.lockCollateral(mm, DEPOSIT / 2);
        // We expect exactly one event: CollateralLocked. CapitalLow not emitted.
        // (More robust: assertFalse any `CapitalLow` topic seen.)
        bytes32 capitalLowTopic = keccak256("CapitalLow(address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != capitalLowTopic, "unexpected CapitalLow");
        }
    }

    // ─── releaseAndDistribute
    // ────────────────────────────────────────────

    function test_release_payoutBelowCollateral_lpGetsPayout_mmKeepsRest() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(core);
        vault.lockCollateral(mm, 10_000e6);

        uint256 lpBalBefore = usdc.balanceOf(lp);
        vm.prank(core);
        vault.releaseAndDistribute(mm, lp, 3000e6, 10_000e6);

        assertEq(usdc.balanceOf(lp) - lpBalBefore, 3000e6, "lp payout");
        assertEq(vault.locked(mm), 0, "lock released");
        assertEq(vault.deposited(mm), DEPOSIT - 3000e6, "mm balance debited");
        assertEq(vault.availableBalance(mm), DEPOSIT - 3000e6);
    }

    function test_release_payoutExceedsCollateral_reverts() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(core);
        vault.lockCollateral(mm, 10_000e6);
        vm.prank(core);
        vm.expectRevert(abi.encodeWithSelector(UnderwriterVault.PayoutExceedsCollateral.selector, 10_001e6, 10_000e6));
        vault.releaseAndDistribute(mm, lp, 10_001e6, 10_000e6);
    }

    function test_release_onlyCore() public {
        vm.prank(mm);
        vm.expectRevert(UnderwriterVault.OnlyCore.selector);
        vault.releaseAndDistribute(mm, lp, 0, 0);
    }

    function test_release_zeroPayout_skipsTransfer() public {
        vm.prank(mm);
        vault.deposit(DEPOSIT);
        vm.prank(core);
        vault.lockCollateral(mm, 10_000e6);
        vm.prank(core);
        vault.releaseAndDistribute(mm, lp, 0, 10_000e6);
        assertEq(usdc.balanceOf(lp), 0);
        assertEq(vault.deposited(mm), DEPOSIT);
        assertEq(vault.locked(mm), 0);
    }

    // ─── Invariant I5 fuzz: locked ≤ deposited per MM, always ───────────

    function testFuzz_I5_lockedNeverExceedsDeposited(
        uint64 depositAmt,
        uint64 lockAmt
    ) public {
        // Bound to realistic-USDC sizes; can't lock more than deposit.
        uint64 dep = depositAmt < 100 ? 100 : depositAmt;
        uint64 lck = lockAmt > dep ? dep : lockAmt;

        usdc.mint(otherMM, dep);
        vm.prank(otherMM);
        usdc.approve(address(vault), dep);
        vm.prank(otherMM);
        vault.deposit(dep);

        vm.prank(core);
        vault.lockCollateral(otherMM, lck);

        // I5: locked ≤ deposited
        assertLe(vault.locked(otherMM), vault.deposited(otherMM), "I5 violated");
        assertEq(
            vault.availableBalance(otherMM), vault.deposited(otherMM) - vault.locked(otherMM), "available accounting"
        );
    }

    // ─── Core wiring
    // ─────────────────────────────────────────────────────

    function test_setCore_onlyOwner() public {
        vm.prank(mm);
        vm.expectRevert();
        vault.setCore(makeAddr("badCore"));
    }

    function test_freezeCore_blocksFurtherChanges() public {
        vm.prank(owner);
        vault.freezeCore();
        vm.prank(owner);
        vm.expectRevert(UnderwriterVault.CoreAlreadyFrozen.selector);
        vault.setCore(makeAddr("differentCore"));
    }
}

// Re-import Vm for log filtering (Foundry exposes via cheats.Vm).
// Note: forge-std/Test.sol already imports Vm; we just need the type here.
import { Vm } from "forge-std/Vm.sol";
