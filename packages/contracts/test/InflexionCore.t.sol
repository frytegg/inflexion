// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { InflexionCore } from "../src/InflexionCore.sol";
import { UnderwriterVault } from "../src/UnderwriterVault.sol";
import { ILVault } from "../src/ILVault.sol";

import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";
import { MockNonfungiblePositionManager } from "./mocks/MockNonfungiblePositionManager.sol";
import { MockILMath } from "./mocks/MockILMath.sol";

import { OracleManager } from "../src/OracleManager.sol";

/// @title  InflexionCore smoke tests (Tasks 5.1 – 5.9)
/// @notice Covers EIP-712 signing, bitmap nonces, capacity tracking,
///         settlePreview view, and createSwap + settle happy paths +
///         the key revert branches. The full I1-I9 invariant fuzz
///         suite is Task 5.10 (separate session).
/// @dev    IL math is mocked (`MockILMath`) so we can test the contract
///         architecture without depending on the real Q64.96 formulas.
///         Q64.96 sqrt-price inputs use placeholder values — the mock
///         ignores them.
contract InflexionCoreTest is Test {
    // ─── Players
    // ─────────────────────────────────────────────────────────

    Vm.Wallet internal mmWallet;
    address internal lp = makeAddr("lp");
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");

    // ─── Contracts
    // ───────────────────────────────────────────────────────

    InflexionCore internal core;
    UnderwriterVault internal vault;
    ILVault internal ilVault;
    MockERC20 internal usdc;
    OracleManager internal oracle;
    MockAggregator internal sequencer;
    MockAggregator internal ethFeed;
    MockNonfungiblePositionManager internal pm;
    MockILMath internal ilMath;

    address internal constant WETH = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);
    address internal constant USDC_TOKEN = address(0x1111111111111111111111111111111111111111);
    uint24 internal constant FEE = 3000;
    uint32 internal constant DURATION = 30 days;
    bytes32 internal MARKET_ID;

    // V0 scales linearly with L. With our placeholder sqrt prices (sqrt(2)
    // entry, geometric mid of [1, 2]), L = 1e10 gives V0 ≈ $8,283 — well
    // above MIN_POSITION_V0 ($100). Production builds use real Q64.96.
    uint128 internal constant POSITION_LIQUIDITY = 1e10;
    uint256 internal constant USDC_BANKROLL = 1_000_000e6;

    // Placeholder sqrt prices — MockILMath ignores them. Real values come
    // from the off-chain SDK in production.
    uint160 internal constant SQRT_PA = uint160(uint256(1) << 96); // arbitrary > 0
    uint160 internal constant SQRT_PB = uint160((uint256(1) << 96) * 2);
    uint160 internal constant SQRT_P0 = uint160((uint256(1) << 96) * 1414 / 1000); // ~sqrt(2)
    uint160 internal constant SQRT_PT = uint160((uint256(1) << 96) * 12 / 10); // ~sqrt(1.44)

    function setUp() public {
        mmWallet = vm.createWallet("mm");

        vm.warp(1_800_000_000);

        // Tokens
        vm.prank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Oracle stack
        vm.prank(owner);
        sequencer = new MockAggregator(0, "L2 Sequencer");
        vm.prank(owner);
        ethFeed = new MockAggregator(8, "ETH / USD");
        vm.prank(owner);
        oracle = new OracleManager(address(sequencer));
        vm.prank(owner);
        oracle.setPriceFeed(WETH, address(ethFeed), 90_000);
        sequencer.setRound(1, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        ethFeed.setRound(1, 3000e8, block.timestamp - 100, true);

        // Vaults
        vm.prank(owner);
        vault = new UnderwriterVault(usdc);
        pm = new MockNonfungiblePositionManager();
        vm.prank(owner);
        ilVault = new ILVault(address(pm));

        // IL math (mocked)
        ilMath = new MockILMath();

        // Core
        vm.prank(owner);
        core = new InflexionCore(usdc, oracle, ilMath, vault, ilVault, address(pm), treasury);

        // Wire Core into both vaults
        vm.prank(owner);
        vault.setCore(address(core));
        vm.prank(owner);
        ilVault.setCore(address(core));

        // Register the test market (WETH/USDC pool simulated by the mock PM)
        InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
            token0: USDC_TOKEN, token1: WETH, fee: FEE, durationSeconds: DURATION, oracleToken: WETH, active: true
        });
        MARKET_ID = keccak256(abi.encodePacked(cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds));
        vm.prank(owner);
        core.registerMarket(cfg);

        // Make the MM solvent in the vault
        usdc.mint(mmWallet.addr, USDC_BANKROLL);
        vm.prank(mmWallet.addr);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(mmWallet.addr);
        vault.deposit(USDC_BANKROLL);

        // LP gets USDC to pay premium + a v3 position NFT
        usdc.mint(lp, USDC_BANKROLL);
        vm.prank(lp);
        usdc.approve(address(core), type(uint256).max);

        // Wire the mock PM's default position metadata to match MARKET_ID
        pm.setDefaultPositionData(USDC_TOKEN, WETH, FEE, -887_220, 887_220);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _mintLPNFT() internal returns (uint256 tokenId) {
        // The mock PM doesn't track per-position market data — for these
        // tests we just need ownership + a `liquidity` value. Real
        // production builds use the canonical Uniswap v3 NPM.
        tokenId = pm.mint(lp, POSITION_LIQUIDITY);
        // Approve InflexionCore to take the NFT (createSwap uses
        // safeTransferFrom from the LP).
        vm.prank(lp);
        pm.setApprovalForAll(address(core), true);
    }

    function _signQuote(
        InflexionCore.SignedQuote memory q
    ) internal view returns (bytes memory sig) {
        bytes32 digest = MessageHashUtils_v5.toEip712Digest(core.domainSeparator(), core.hashQuote(q));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(mmWallet.privateKey, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _defaultQuote() internal view returns (InflexionCore.SignedQuote memory q) {
        q = InflexionCore.SignedQuote({
            mm: mmWallet.addr,
            marketId: MARKET_ID,
            premiumRateOfMaxIL: 7500, // 75% of MaxIL
            minMaxILRatioBps: 0,
            maxMaxILRatioBps: 10_000,
            quotePrice: 3000e8, // matches the live ETH feed
            priceBandBps: 100,
            model: uint8(InflexionCore.CollateralModel.FULL),
            partialRatioBps: 0,
            maxNotionalV0: 10_000_000e6,
            validUntil: uint64(block.timestamp + 10),
            quoteId: bytes32(uint256(0xdead)),
            nonce: 1 // word 0, bit 1
        });
    }

    // ─── EIP-712 (Task 5.1)
    // ──────────────────────────────────────────────

    function test_domainSeparator_isStable() public view {
        bytes32 d = core.domainSeparator();
        assertTrue(d != bytes32(0));
    }

    function test_hashQuote_isDeterministic() public view {
        InflexionCore.SignedQuote memory q = _defaultQuote();
        assertEq(core.hashQuote(q), core.hashQuote(q));
    }

    function test_recoverSigner_returnsMM() public view {
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        assertEq(core.recoverSigner(q, sig), mmWallet.addr);
    }

    function test_recoverSigner_failsOnTampering() public view {
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        q.premiumRateOfMaxIL = 9999; // tamper post-sign
        assertTrue(core.recoverSigner(q, sig) != mmWallet.addr);
    }

    // ─── Bitmap nonces (Task 5.2 + 5.3)
    // ──────────────────────────────────

    function test_nonce_initiallyUnused() public view {
        assertFalse(core.isNonceUsed(mmWallet.addr, 42));
    }

    function test_cancelNonces_marksUsed() public {
        uint256[] memory ns = new uint256[](2);
        ns[0] = 42;
        ns[1] = 99;
        vm.prank(mmWallet.addr);
        core.cancelNonces(ns);
        assertTrue(core.isNonceUsed(mmWallet.addr, 42));
        assertTrue(core.isNonceUsed(mmWallet.addr, 99));
        assertFalse(core.isNonceUsed(mmWallet.addr, 100));
    }

    function test_nonce_perMM_isolated() public {
        address other = makeAddr("other");
        uint256[] memory ns = new uint256[](1);
        ns[0] = 42;
        vm.prank(other);
        core.cancelNonces(ns);
        assertFalse(core.isNonceUsed(mmWallet.addr, 42));
        assertTrue(core.isNonceUsed(other, 42));
    }

    // ─── createSwap happy path + key reverts (Task 5.7) ──────────────────

    function test_createSwap_happyPath() public {
        uint256 tokenId = _mintLPNFT();

        // MaxIL = $100 (in our pretend token1=USDC units, 6 decimals)
        ilMath.setMaxIL(100e6);

        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);

        uint256 lpUsdcBefore = usdc.balanceOf(lp);
        uint256 mmUsdcBefore = usdc.balanceOf(mmWallet.addr);

        vm.prank(lp);
        uint256 swapId = core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);

        // Premium = ceil(7500 * 100e6 / 10000) = 75e6 = $75
        uint128 expectedPremium = 75e6;

        // Sanity: swap stored, NFT in custody, premium split
        (uint256 storedTokenId, address storedLp, address storedMm,,,, uint128 premium,,,,,,,,) = _readSwap(swapId);
        assertEq(storedTokenId, tokenId);
        assertEq(storedLp, lp);
        assertEq(storedMm, mmWallet.addr);
        assertEq(premium, expectedPremium);
        assertEq(pm.ownerOf(tokenId), address(ilVault));
        // 99% to MM (74.25 USDC), 1% to treasury (0.75 USDC)
        assertEq(usdc.balanceOf(mmWallet.addr) - mmUsdcBefore, (expectedPremium * 99) / 100);
        assertEq(usdc.balanceOf(treasury), expectedPremium - (expectedPremium * 99) / 100);
        assertEq(lpUsdcBefore - usdc.balanceOf(lp), expectedPremium);
        // Vault locked the collateral
        assertEq(vault.locked(mmWallet.addr), 100e6);
    }

    function test_createSwap_rejectsBadSignature() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory badSig = new bytes(65); // empty / zero sig
        vm.prank(lp);
        vm.expectRevert();
        core.createSwap(q, badSig, tokenId, type(uint256).max, SQRT_P0);
    }

    function test_createSwap_rejectsUsedNonce() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();

        // MM cancels the nonce before the LP can use it
        uint256[] memory ns = new uint256[](1);
        ns[0] = q.nonce;
        vm.prank(mmWallet.addr);
        core.cancelNonces(ns);

        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(InflexionCore.NonceAlreadyUsed.selector, mmWallet.addr, q.nonce));
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);
    }

    function test_createSwap_rejectsExpiredQuote() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        q.validUntil = uint64(block.timestamp - 1); // already expired
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        vm.expectRevert();
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);
    }

    function test_createSwap_rejectsBandViolation() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        q.quotePrice = 4000e8; // ~33% off from live $3,000; bands at 100 bp
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        vm.expectRevert();
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);
    }

    function test_createSwap_consumedNotional_tracked() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);
        // consumedNotional[quoteId] should be > 0 after the swap
        assertGt(core.consumedNotional(q.quoteId), 0);
    }

    function test_createSwap_unsupportedModelReverts() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        q.model = uint8(InflexionCore.CollateralModel.PARTIAL);
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(
                InflexionCore.UnsupportedModel.selector, uint8(InflexionCore.CollateralModel.PARTIAL)
            )
        );
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);
    }

    // ─── settle happy path (Task 5.8)
    // ────────────────────────────────────

    function test_settle_happyPath() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        uint256 swapId = core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);

        // Warp past expiry
        vm.warp(block.timestamp + DURATION + 1);

        // Sequencer + Chainlink: seed a settlement round bracketing expiry
        uint64 expiry = uint64(block.timestamp - 1);
        sequencer.setRound(2, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        // Round 1 already at $3000 well before expiry; add round 2 after
        ethFeed.setRound(2, 3000e8, uint256(expiry) - 100, true);
        ethFeed.setRound(3, 3000e8, uint256(expiry) + 100, true);

        // Mock realized IL = $30 (below MaxIL $100 → payout = $30, no cap)
        ilMath.setIL(30e6);

        uint256 lpUsdcBefore = usdc.balanceOf(lp);
        core.settle(swapId, 2, SQRT_PT);

        // LP got $30 payout
        assertEq(usdc.balanceOf(lp) - lpUsdcBefore, 30e6);
        // NFT returned to LP
        assertEq(pm.ownerOf(tokenId), lp);
        // MM's vault: collateral fully released (lock cleared)
        assertEq(vault.locked(mmWallet.addr), 0);
        // MM's vault deposit debited by exactly the payout
        assertEq(vault.deposited(mmWallet.addr), USDC_BANKROLL - 30e6);
    }

    function test_settle_payoutCappedAtMaxIL() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        uint256 swapId = core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);

        vm.warp(block.timestamp + DURATION + 1);
        uint64 expiry = uint64(block.timestamp - 1);
        sequencer.setRound(2, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        ethFeed.setRound(2, 3000e8, uint256(expiry) - 100, true);
        ethFeed.setRound(3, 3000e8, uint256(expiry) + 100, true);

        // Realised IL = $500 (way over MaxIL $100) → payout MUST cap at $100 (invariant I1 + I2)
        ilMath.setIL(500e6);

        uint256 lpUsdcBefore = usdc.balanceOf(lp);
        core.settle(swapId, 2, SQRT_PT);
        assertEq(usdc.balanceOf(lp) - lpUsdcBefore, 100e6, "I1/I2: payout MUST cap at MaxIL");
    }

    function test_settle_rejectsBeforeExpiry() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        uint256 swapId = core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);

        // Don't warp past expiry — settle should revert
        vm.expectRevert();
        core.settle(swapId, 2, SQRT_PT);
    }

    // ─── settlePreview view (Task 5.9)
    // ───────────────────────────────────

    function test_settlePreview_returnsExpectedPayout() public {
        uint256 tokenId = _mintLPNFT();
        ilMath.setMaxIL(100e6);
        InflexionCore.SignedQuote memory q = _defaultQuote();
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        uint256 swapId = core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_P0);

        // Preview at IL=$30 → payout=$30
        ilMath.setIL(30e6);
        (uint256 il, uint128 payout) = core.settlePreview(swapId, SQRT_PT);
        assertEq(il, 30e6);
        assertEq(payout, 30e6);

        // Preview at IL=$500 → payout=$100 (capped)
        ilMath.setIL(500e6);
        (uint256 il2, uint128 payout2) = core.settlePreview(swapId, SQRT_PT);
        assertEq(il2, 500e6);
        assertEq(payout2, 100e6);
    }

    // ─── Tuple unpacker helper
    // ───────────────────────────────────────────

    function _readSwap(
        uint256 swapId
    )
        internal
        view
        returns (
            uint256 tokenId,
            address lp_,
            address mm,
            uint128 V0,
            uint128 maxIL,
            uint128 collateral,
            uint128 premium,
            uint8 model,
            uint8 settlement,
            uint64 createdAt,
            uint64 expiry,
            uint128 a0,
            uint128 a1,
            uint128 liquidity,
            InflexionCore.Status status
        )
    {
        return core.swaps(swapId);
    }
}

/// @notice EIP-712 digest helper (mirrors OZ MessageHashUtils.toTypedDataHash).
///         Inline so the test file is self-contained.
library MessageHashUtils_v5 {
    function toEip712Digest(
        bytes32 domainSeparator_,
        bytes32 structHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator_, structHash));
    }
}
