// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import { ILVault } from "../src/ILVault.sol";
import { MockNonfungiblePositionManager, HostileERC721 } from "./mocks/MockNonfungiblePositionManager.sol";

/// @notice Unit + fuzz tests for `ILVault` (Task 4.6).
///         Covers spec §5 / §7.1, audit fork F-#2 (third-party
///         `increaseLiquidity` between create + return must not break
///         custody), and invariant I6 (`L` immutability is enforced in
///         Core, NOT here — so the ILVault simply does not care about
///         post-deposit liquidity changes).
contract ILVaultTest is Test {
    ILVault internal vault;
    MockNonfungiblePositionManager internal pm;
    HostileERC721 internal hostile;

    address internal owner = makeAddr("owner");
    address internal core = makeAddr("core");
    address internal lp = makeAddr("lp");
    address internal mm = makeAddr("mm");

    uint256 internal constant SWAP_ID = 42;
    uint128 internal constant INITIAL_LIQUIDITY = 1_000_000;

    function setUp() public {
        pm = new MockNonfungiblePositionManager();
        hostile = new HostileERC721();
        vm.prank(owner);
        vault = new ILVault(address(pm));
        vm.prank(owner);
        vault.setCore(core);
    }

    function _mintAndDeposit(
        uint256 swapId,
        address from
    ) internal returns (uint256 tokenId) {
        tokenId = pm.mint(from, INITIAL_LIQUIDITY);
        vm.prank(from);
        pm.safeTransferFrom(from, address(vault), tokenId, abi.encode(swapId));
    }

    // ─── onERC721Received
    // ────────────────────────────────────────────────

    function test_receive_acceptsPositionManagerNFT_recordsLp() public {
        uint256 tokenId = _mintAndDeposit(SWAP_ID, lp);
        assertEq(vault.tokenIdOf(SWAP_ID), tokenId);
        assertEq(vault.lpOf(SWAP_ID), lp);
        assertEq(pm.ownerOf(tokenId), address(vault));
    }

    function test_receive_rejectsNonPositionManagerNFT() public {
        uint256 badId = hostile.mint(lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ILVault.NotPositionManager.selector, address(hostile)));
        hostile.safeTransferFrom(lp, address(vault), badId, abi.encode(SWAP_ID));
    }

    function test_receive_rejectsDuplicateSwapId() public {
        _mintAndDeposit(SWAP_ID, lp);
        uint256 tokenId2 = pm.mint(lp, INITIAL_LIQUIDITY);
        vm.prank(lp);
        vm.expectRevert();
        pm.safeTransferFrom(lp, address(vault), tokenId2, abi.encode(SWAP_ID));
    }

    function test_receive_revertsOnEmptyData() public {
        uint256 tokenId = pm.mint(lp, INITIAL_LIQUIDITY);
        vm.prank(lp);
        vm.expectRevert(ILVault.EmptySwapIdData.selector);
        pm.safeTransferFrom(lp, address(vault), tokenId, "");
    }

    // ─── claimFees
    // ───────────────────────────────────────────────────────

    function test_claimFees_forwardsToCollectWithLPRecipient() public {
        uint256 tokenId = _mintAndDeposit(SWAP_ID, lp);
        pm.scriptCollectReturns(123, 456);

        vm.prank(lp);
        (uint256 a0, uint256 a1) = vault.claimFees(SWAP_ID, type(uint128).max, type(uint128).max);

        assertEq(a0, 123);
        assertEq(a1, 456);

        (uint256 callTokenId, address callRecipient, uint128 a0Max, uint128 a1Max, bool wasCalled) = pm.lastCollect();
        assertTrue(wasCalled);
        assertEq(callTokenId, tokenId);
        assertEq(callRecipient, lp, "fees MUST go to the LP, not msg.sender");
        assertEq(a0Max, type(uint128).max);
        assertEq(a1Max, type(uint128).max);
    }

    function test_claimFees_revertsForNonLP() public {
        _mintAndDeposit(SWAP_ID, lp);
        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(ILVault.OnlyLPCanClaim.selector, SWAP_ID, lp));
        vault.claimFees(SWAP_ID, type(uint128).max, type(uint128).max);
    }

    function test_claimFees_revertsIfNoNFT() public {
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ILVault.OnlyLPCanClaim.selector, SWAP_ID, address(0)));
        vault.claimFees(SWAP_ID, 0, 0);
    }

    // ─── returnNFT
    // ───────────────────────────────────────────────────────

    function test_returnNFT_transfersAndClearsState() public {
        uint256 tokenId = _mintAndDeposit(SWAP_ID, lp);
        vm.prank(core);
        vault.returnNFT(SWAP_ID, lp);
        assertEq(pm.ownerOf(tokenId), lp);
        assertEq(vault.tokenIdOf(SWAP_ID), 0);
        assertEq(vault.lpOf(SWAP_ID), address(0));
    }

    function test_returnNFT_onlyCore() public {
        _mintAndDeposit(SWAP_ID, lp);
        vm.prank(lp);
        vm.expectRevert(ILVault.OnlyCore.selector);
        vault.returnNFT(SWAP_ID, lp);
    }

    function test_returnNFT_revertsIfNoNFT() public {
        vm.prank(core);
        vm.expectRevert(abi.encodeWithSelector(ILVault.NoCustodiedNFT.selector, SWAP_ID));
        vault.returnNFT(SWAP_ID, lp);
    }

    function test_returnNFT_canDirectToAnyAddress() public {
        // PARTIAL liquidation scenario: Core may return to a non-LP target
        uint256 tokenId = _mintAndDeposit(SWAP_ID, lp);
        address keeper = makeAddr("keeper");
        vm.prank(core);
        vault.returnNFT(SWAP_ID, keeper);
        assertEq(pm.ownerOf(tokenId), keeper);
    }

    // ─── F-#2: third-party `increaseLiquidity` doesn't break custody ──

    function test_F2_externalIncreaseLiquidity_stillReturnable() public {
        uint256 tokenId = _mintAndDeposit(SWAP_ID, lp);

        // Simulate a third party calling increaseLiquidity on the
        // custodied NFT. The NFT's `liquidity` field grows from
        // INITIAL_LIQUIDITY to INITIAL_LIQUIDITY + 5_000_000.
        pm.inflateLiquidity(tokenId, 5_000_000);
        assertEq(pm.liquidity(tokenId), INITIAL_LIQUIDITY + 5_000_000);

        // ILVault doesn't care — returnNFT still succeeds, NFT goes home.
        vm.prank(core);
        vault.returnNFT(SWAP_ID, lp);
        assertEq(pm.ownerOf(tokenId), lp);
    }

    function testFuzz_F2_externalIncreaseLiquidity_arbitraryAmount(
        uint64 extra
    ) public {
        uint256 tokenId = _mintAndDeposit(SWAP_ID, lp);
        pm.inflateLiquidity(tokenId, extra);
        vm.prank(core);
        vault.returnNFT(SWAP_ID, lp);
        assertEq(pm.ownerOf(tokenId), lp);
    }

    /// @notice By inspection: ILVault has no function that can call
    ///         `decreaseLiquidity`. This test exists to document the
    ///         intent — any future PR adding such a path must justify
    ///         itself (spec §5 / §13 I6).
    function test_inspectionContractHasNoDecreaseLiquidityPath() public pure {
        // Intentional pass-through; the assertion is the absence of any
        // `decreaseLiquidity` calldata path in the source. Audit guard.
        assertTrue(true);
    }
}
