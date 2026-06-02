// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { ConvexityVault } from "../src/ConvexityVault.sol";
import { IConvexityVault } from "../src/interfaces/IConvexityVault.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") { }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract ConvexityVaultTest is Test {
    MockUSDC internal usdc;
    ConvexityVault internal vault;

    address internal alice = address(0xA11CE); // senior depositor
    address internal bob = address(0xB0B); // junior depositor
    address internal lp = address(0x11D);
    bytes32 internal constant MKT = keccak256("ETH/USDC/3000/30d");
    bytes32 internal constant MKT2 = keccak256("ETH/USDC/500/7d");

    IConvexityVault.Tranche internal constant SENIOR = IConvexityVault.Tranche.SENIOR;
    IConvexityVault.Tranche internal constant JUNIOR = IConvexityVault.Tranche.JUNIOR;

    uint256 internal constant COOLDOWN = 7 days;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new ConvexityVault(usdc, COOLDOWN, 2000); // senior gets 20% of premium
        vault.setCore(address(this)); // test acts as Core
        for (uint160 i = 0; i < 3; i++) {
            address u = [alice, bob, address(this)][i];
            usdc.mint(u, 1_000_000e6);
            vm.prank(u);
            usdc.approve(address(vault), type(uint256).max);
        }
        usdc.approve(address(vault), type(uint256).max); // this (Core) for accruePremium
        vm.warp(1_000_000);
    }

    function _depositSenior(
        uint256 amt
    ) internal returns (uint256) {
        vm.prank(alice);
        return vault.deposit(SENIOR, amt);
    }

    function _depositJunior(
        uint256 amt
    ) internal returns (uint256) {
        vm.prank(bob);
        return vault.deposit(JUNIOR, amt);
    }

    // ─── shares / NAV
    // ──────────────────────────────────────────────────────

    function test_first_deposit_is_1to1() public {
        uint256 s = _depositSenior(100e6);
        assertEq(s, 100e6);
        assertEq(vault.seniorAssets(), 100e6);
        assertEq(vault.seniorBalanceOf(alice), 100e6);
        assertEq(vault.totalAssets(), 100e6);
    }

    function test_premium_split_senior_small_junior_most() public {
        _depositSenior(100e6);
        _depositJunior(40e6);
        vault.accruePremium(10e6); // senior 20% = 2, junior 80% = 8
        assertEq(vault.seniorAssets(), 102e6);
        assertEq(vault.juniorAssets(), 48e6);
    }

    // ─── structural senior protection
    // ─────────────────────────────────────

    function test_lock_capped_by_junior_buffer() public {
        _depositSenior(100e6);
        _depositJunior(40e6);
        // free = 140 but junior = 40 → can lock at most 40 (senior protection)
        vault.lockCollateral(MKT, 40e6);
        assertEq(vault.totalLocked(), 40e6);
        vm.expectRevert(abi.encodeWithSelector(ConvexityVault.SeniorProtectionBreached.selector, 40e6 + 1, 40e6));
        vault.lockCollateral(MKT, 1);
    }

    function test_lock_capped_by_free() public {
        _depositJunior(100e6); // junior=100, free=100
        vault.lockCollateral(MKT, 100e6); // junior 100 ≥ 100, free 100 ≥ 100 → ok
        vm.expectRevert(abi.encodeWithSelector(ConvexityVault.InsufficientFree.selector, 1, 0));
        vault.lockCollateral(MKT, 1);
    }

    function test_settlement_full_payout_hits_junior_only() public {
        _depositSenior(100e6);
        _depositJunior(40e6);
        vault.accruePremium(10e6); // senior=102, junior=48
        vault.lockCollateral(MKT, 48e6); // ≤ junior 48
        // worst case: full MaxIL payout
        vault.releaseAndDistribute(MKT, lp, 48e6, 48e6);
        assertEq(vault.juniorAssets(), 0, "junior absorbs the full loss");
        assertEq(vault.seniorAssets(), 102e6, "SENIOR UNTOUCHED");
        assertEq(vault.totalLocked(), 0);
        assertEq(usdc.balanceOf(lp), 48e6, "LP paid in full (no bad debt)");
    }

    function _roundFullPayout() internal {
        _depositJunior(50e6); // top up junior buffer
        vault.accruePremium(5e6);
        uint256 lockAmt = vault.juniorAssets(); // lock the whole junior buffer
        uint256 free = vault.freeAssets();
        if (lockAmt > free) lockAmt = free;
        vault.lockCollateral(MKT, lockAmt);
        vault.releaseAndDistribute(MKT, lp, lockAmt, lockAmt); // full payout every time
    }

    function test_senior_never_loses_across_many_full_payouts() public {
        _depositSenior(500e6);
        uint256 seniorStart = vault.seniorAssets();
        for (uint256 i; i < 12; i++) {
            _roundFullPayout();
            assertGe(vault.seniorAssets(), seniorStart, "senior never decreases");
        }
    }

    function test_no_bad_debt_payout_cannot_exceed_collateral() public {
        _depositJunior(100e6);
        vault.lockCollateral(MKT, 100e6);
        vm.expectRevert(abi.encodeWithSelector(ConvexityVault.PayoutExceedsCollateral.selector, 100e6 + 1, 100e6));
        vault.releaseAndDistribute(MKT, lp, 100e6 + 1, 100e6);
    }

    // ─── run defense / cooldown
    // ───────────────────────────────────────────

    function test_withdraw_requires_cooldown() public {
        _depositSenior(100e6);
        vm.prank(alice);
        vault.requestWithdrawal(SENIOR, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(SENIOR);
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        uint256 got = vault.withdraw(SENIOR);
        assertEq(got, 100e6);
        assertEq(usdc.balanceOf(alice), 1_000_000e6); // back to start
    }

    function test_junior_cannot_withdraw_below_locked() public {
        _depositJunior(100e6);
        vault.lockCollateral(MKT, 60e6); // locked 60 ≤ junior 100
        vm.prank(bob);
        vault.requestWithdrawal(JUNIOR, 50e6); // would leave junior 50 < locked 60
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ConvexityVault.JuniorBelowLocked.selector, 50e6, 60e6));
        vault.withdraw(JUNIOR);
    }

    // ─── inventory (pricing inputs)
    // ───────────────────────────────────────

    function test_utilization_and_concentration() public {
        _depositJunior(100e6);
        vault.lockCollateral(MKT, 40e6);
        vault.lockCollateral(MKT2, 40e6);
        (uint256 total, uint256 locked, uint256 free, uint256 util, uint256 conc) = vault.inventory();
        assertEq(total, 100e6);
        assertEq(locked, 80e6);
        assertEq(free, 20e6);
        assertEq(util, 80e16); // 0.8
        // two equal markets → HHI = 2*(0.5²) = 0.5
        assertApproxEqAbs(conc, 5e17, 1e12);
        // concentrate into one market → HHI rises toward 1
        vault.releaseAndDistribute(MKT2, lp, 0, 40e6); // unlock MKT2, no payout
        assertEq(vault.concentrationWad(), 1e18, "all locked in one market -> HHI=1");
    }

    // ─── access control
    // ───────────────────────────────────────────────────

    function test_onlyCore_gates() public {
        _depositJunior(100e6);
        vm.startPrank(alice);
        vm.expectRevert(ConvexityVault.OnlyCore.selector);
        vault.lockCollateral(MKT, 1e6);
        vm.expectRevert(ConvexityVault.OnlyCore.selector);
        vault.accruePremium(1e6);
        vm.expectRevert(ConvexityVault.OnlyCore.selector);
        vault.releaseAndDistribute(MKT, lp, 0, 0);
        vm.stopPrank();
    }
}
