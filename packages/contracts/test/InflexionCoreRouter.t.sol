// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test, Vm } from "forge-std/Test.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { UnderwriterVault } from "../src/UnderwriterVault.sol";
import { ILVault } from "../src/ILVault.sol";
import { ConvexityVault } from "../src/ConvexityVault.sol";
import { OracleManager } from "../src/OracleManager.sol";
import { IConvexityVault } from "../src/interfaces/IConvexityVault.sol";
import { IFairValueOracle } from "../src/interfaces/IFairValueOracle.sol";
import { IVolOracle } from "../src/interfaces/IVolOracle.sol";
import { CvammPricing } from "../src/libraries/CvammPricing.sol";

import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";
import { MockNonfungiblePositionManager } from "./mocks/MockNonfungiblePositionManager.sol";
import { MockILMath } from "./mocks/MockILMath.sol";
import { MockVolOracle } from "./mocks/MockVolOracle.sol";
import { MockFairValueOracle } from "./mocks/MockFairValueOracle.sol";

/// @title  InflexionCore P3.5 — cheapest-of-{Path A pool, valid MM quote} router
/// @notice Clean 18/18-dec market (oracleToken == token0, feed 1e18 => sqrtP0 = 2^96,
///         ticks ±953 ≈ ±9% in-range). Settable mocks (FairPremium = 0.75·MaxIL,
///         σ = 0.6 => NORMAL regime => pool baseLoad 0.30, util/conc = 0 on the first
///         swap) give EXACT, controllable premiums so cheapest-wins is asserted to
///         the wei:
///           premiumA = 0.75·MaxIL·1.30          (Path A — pool)
///           premiumB = 0.75·MaxIL·(1+loadBps)   (Path B — MM), capped at MaxIL
///         So loadBps < 3000 => B wins; loadBps > 3000 => A wins; == 3000 => tie => A.
contract InflexionCoreRouterTest is Test {
    Vm.Wallet internal mm;
    Vm.Wallet internal poorMm; // no UnderwriterVault collateral
    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal juniorDep = makeAddr("junior");
    address internal seniorDep = makeAddr("senior");
    address internal treasury = makeAddr("treasury");

    MockERC20 internal weth; // token0 = oracleToken
    MockERC20 internal usd; // token1 = numéraire + vault asset (18-dec)
    MockAggregator internal sequencer;
    MockAggregator internal feed;
    OracleManager internal oracle;
    MockNonfungiblePositionManager internal pm;
    MockILMath internal ilMath;
    UnderwriterVault internal uVault;
    ILVault internal ilVault;
    ConvexityVault internal cVault;
    MockVolOracle internal mvol;
    MockFairValueOracle internal mfvo;
    InflexionCore internal core;

    uint24 internal constant FEE = 3000;
    uint32 internal constant DURATION = 30 days;
    int24 internal constant TICK_LO = -953;
    int24 internal constant TICK_HI = 953;
    bytes32 internal MARKET_ID;

    // MaxIL must stay below V0 (≈9e16 for L=1e18) so ratioBps ∈ [0, 10000].
    uint256 internal constant MAX_IL = 1e16;
    // Derived (σ=0.6 NORMAL => load 0.30; FairPremium = 0.75·MaxIL):
    uint256 internal constant FAIR_PREM = (MAX_IL * 75) / 100; // 7.5e15
    uint256 internal constant PREMIUM_A = (FAIR_PREM * 130) / 100; // 9.75e15

    function setUp() public {
        vm.warp(1_800_000_000);
        mm = vm.createWallet("mm");
        poorMm = vm.createWallet("poorMm");

        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usd = new MockERC20("USD", "USD", 18);

        sequencer = new MockAggregator(0, "seq");
        feed = new MockAggregator(18, "WETH/USD");
        oracle = new OracleManager(address(sequencer));
        oracle.setPriceFeed(address(weth), address(feed), 90_000);
        sequencer.setRound(1, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        feed.setRound(1, 1e18, block.timestamp - 100, true); // price 1.0 => sqrtP0 = 2^96

        pm = new MockNonfungiblePositionManager();
        ilVault = new ILVault(address(pm));
        ilMath = new MockILMath();
        ilMath.setMaxIL(MAX_IL);
        uVault = new UnderwriterVault(usd);

        core = new InflexionCore(usd, oracle, ilMath, uVault, ilVault, address(pm), treasury);
        uVault.setCore(address(core));
        ilVault.setCore(address(core));

        // cvAMM stack — settable mocks for exact premiums.
        mvol = new MockVolOracle(6e17); // 0.6 => NORMAL regime
        mfvo = new MockFairValueOracle(); // FairPremium = 0.75·MaxIL
        cVault = new ConvexityVault(usd, 7 days, 2000);
        cVault.setCore(address(core));
        core.setCvamm(IConvexityVault(address(cVault)), IFairValueOracle(address(mfvo)), IVolOracle(address(mvol)));
        core.setLoadParams(_launchParams());

        InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
            token0: address(weth),
            token1: address(usd),
            fee: FEE,
            durationSeconds: DURATION,
            oracleToken: address(weth),
            token0Decimals: 18,
            token1Decimals: 18,
            oracleDecimals: 18,
            active: true
        });
        MARKET_ID = keccak256(abi.encodePacked(cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds));
        core.registerMarket(cfg);
        core.setCvammEnabled(MARKET_ID, true);
        pm.setDefaultPositionData(address(weth), address(usd), FEE, TICK_LO, TICK_HI);

        // Pool: junior buffer ≥ MaxIL so Path A can lock.
        _deposit(juniorDep, IConvexityVault.Tranche.JUNIOR, 2000e18);
        _deposit(seniorDep, IConvexityVault.Tranche.SENIOR, 3000e18);

        // MM collateral for Path B locks.
        usd.mint(mm.addr, 1e18);
        vm.startPrank(mm.addr);
        usd.approve(address(uVault), type(uint256).max);
        uVault.deposit(1e18);
        vm.stopPrank();

        // LP funds.
        usd.mint(lp, 1_000_000e18);
        vm.prank(lp);
        usd.approve(address(core), type(uint256).max);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _launchParams() internal pure returns (CvammPricing.LoadParams memory p) {
        p = CvammPricing.LoadParams({
            baseLoadCalmBps: 2000,
            baseLoadNormalBps: 3000,
            baseLoadStressedBps: 5000,
            regimeCalmBelowWad: 6e17,
            regimeStressedAtWad: 1025e15,
            utilKneeWad: 45e16,
            utilSlopeWad: 6e17,
            utilPowerWad: 2e18,
            utilCapWad: 6e17,
            dispSlopeWad: 5e17,
            dispPowerWad: 15e17,
            dispCapWad: 5e17,
            maxLoadBps: 16_000
        });
    }

    function _deposit(
        address who,
        IConvexityVault.Tranche t,
        uint256 amt
    ) internal {
        usd.mint(who, amt);
        vm.startPrank(who);
        usd.approve(address(cVault), amt);
        cVault.deposit(t, amt);
        vm.stopPrank();
    }

    function _mintNFT() internal returns (uint256 tokenId) {
        tokenId = pm.mint(lp, 1e18);
        vm.prank(lp);
        pm.setApprovalForAll(address(core), true);
    }

    /// @dev A fully-valid quote (signed by `mm`) with the given load + nonce.
    function _quote(
        uint16 loadBps,
        uint256 nonce
    ) internal view returns (InflexionCore.SignedQuote memory q) {
        q = InflexionCore.SignedQuote({
            mm: mm.addr,
            marketId: MARKET_ID,
            loadBps: loadBps,
            minMaxILRatioBps: 0,
            maxMaxILRatioBps: 10_000,
            quotePrice: 1e18, // matches live feed => band check passes
            priceBandBps: 100,
            model: uint8(InflexionCore.CollateralModel.FULL),
            partialRatioBps: 0,
            maxNotionalV0: type(uint128).max,
            validUntil: uint64(block.timestamp + 10),
            quoteId: bytes32(uint256(0xB0B)),
            nonce: nonce
        });
    }

    function _sign(
        InflexionCore.SignedQuote memory q,
        uint256 pk
    ) internal view returns (bytes memory sig) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), core.hashQuote(q)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _emptyQuote() internal view returns (InflexionCore.SignedQuote memory q) {
        // quote.mm == address(0): the "no MM quote" sentinel (pool-only routing).
        q.marketId = MARKET_ID;
    }

    function _mmOf(
        uint256 id
    ) internal view returns (address mm_) {
        (,, mm_,,,,,,,,,,,,) = core.swaps(id);
    }

    function _premiumV0Of(
        uint256 id
    ) internal view returns (uint128 v0, uint128 premium) {
        (,,, v0,,, premium,,,,,,,,) = core.swaps(id);
    }

    // ─── Cheapest-wins
    // ───────────────────────────────────────────────────

    function test_router_pathB_beatsPool_wins() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1); // load 0.15 < pool 0.30
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);

        (uint128 v0, uint128 premium) = _premiumV0Of(id);
        assertEq(_mmOf(id), mm.addr, "Path B counterparty is the MM");
        assertEq(premium, uint128((FAIR_PREM * 11_500) / 10_000), "premium == premiumB");
        assertLt(uint256(premium), PREMIUM_A, "B strictly cheaper than pool");
        assertEq(uVault.locked(mm.addr), MAX_IL, "MM collateral locked");
        assertEq(cVault.totalLocked(), 0, "pool untouched");
        assertTrue(core.isNonceUsed(mm.addr, 1), "nonce consumed on Path B");
        assertEq(core.consumedNotional(q.quoteId), v0, "capacity consumed on Path B");
    }

    function test_router_pool_beatsMM_wins_andQuoteUntouched() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(5000, 1); // load 0.50 > pool 0.30
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);

        assertEq(_mmOf(id), address(cVault), "Path A counterparty is the pool");
        assertEq(_premium(id), uint128(PREMIUM_A), "premium == premiumA");
        assertEq(cVault.totalLocked(), MAX_IL, "pool collateral locked");
        assertEq(uVault.locked(mm.addr), 0, "MM untouched");
        // State purity: the unchosen quote leaves ZERO trace.
        assertFalse(core.isNonceUsed(mm.addr, 1), "MM nonce NOT burned");
        assertEq(core.consumedNotional(q.quoteId), 0, "MM capacity NOT consumed");
    }

    function test_router_tie_prefersPathA() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(3000, 1); // load 0.30 == pool 0.30
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);

        assertEq(_mmOf(id), address(cVault), "tie => Path A");
        assertEq(_premium(id), uint128(PREMIUM_A));
        assertFalse(core.isNonceUsed(mm.addr, 1), "tie did not burn MM nonce");
    }

    function test_router_emitsSwapRouted() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        bytes memory sig = _sign(q, mm.privateKey);

        uint256 expectedId = core.nextSwapId();
        vm.expectEmit(true, false, false, true, address(core));
        emit InflexionCore.SwapRouted(expectedId, true, PREMIUM_A, (FAIR_PREM * 11_500) / 10_000);
        vm.prank(lp);
        core.createSwapRouted(q, sig, tokenId, type(uint256).max);
    }

    // ─── Fallback (no revert) on a bad / absent MM quote ─────────────────

    function test_router_absentQuote_fallsBackToA() public {
        uint256 tokenId = _mintNFT();
        vm.prank(lp);
        uint256 id = core.createSwapRouted(_emptyQuote(), "", tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "absent quote => Path A");
        assertEq(_premium(id), uint128(PREMIUM_A));
    }

    function test_router_expiredQuote_fallsBackToA() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        q.validUntil = uint64(block.timestamp); // expired (<= now)
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp); // MUST NOT revert
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "expired quote => Path A, no revert");
        assertFalse(core.isNonceUsed(mm.addr, 1));
    }

    function test_router_badSignature_fallsBackToA() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        bytes memory sig = _sign(q, mm.privateKey);
        q.loadBps = 1400; // tamper AFTER signing => sig no longer recovers mm

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "bad sig => Path A");
    }

    function test_router_usedNonce_fallsBackToA() public {
        uint256[] memory ns = new uint256[](1);
        ns[0] = 1;
        vm.prank(mm.addr);
        core.cancelNonces(ns);

        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1); // cancelled nonce
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "used nonce => Path A");
        assertTrue(core.isNonceUsed(mm.addr, 1), "cancelled nonce stays cancelled");
    }

    function test_router_loadExceedsMax_fallsBackToA_butCreateSwapReverts() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(16_001, 1); // > maxLoadBps 16000
        bytes memory sig = _sign(q, mm.privateKey);

        // Router: no revert, Path A.
        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "over-load quote => Path A");

        // createSwap: STILL reverts (I10 on direct Path B).
        uint256 tokenId2 = _mintNFT();
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(InflexionCore.LoadExceedsMax.selector, uint16(16_001), uint256(16_000)));
        core.createSwap(q, sig, tokenId2, type(uint256).max);
    }

    function test_router_i9BandViolation_fallsBackToA_butCreateSwapReverts() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        q.quotePrice = 102e16; // 1.02 vs live 1.00 => 200 bps > priceBandBps 100 => I9
        bytes memory sig = _sign(q, mm.privateKey);

        // Router: no revert, falls back to A (Fork-2 stale-quote defense as predicate).
        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "I9 band drift => Path A");

        // createSwap: STILL reverts PriceOutOfBand (I9 preserved on direct Path B).
        uint256 tokenId2 = _mintNFT();
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(InflexionCore.PriceOutOfBand.selector, uint256(1e18), uint128(102e16), uint16(100))
        );
        core.createSwap(q, sig, tokenId2, type(uint256).max);
    }

    function test_router_zeroQuotePrice_fallsBackToA_noRevert() public {
        // A malformed quote (quotePrice == 0, but mm != 0 + valid sig) must NOT
        // revert the router via absBps(AbsBpsNonPositive) — it falls back to A.
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        q.quotePrice = 0;
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "zero-price quote => Path A, no revert");
    }

    function test_router_mmUndercollateralised_fallsBackToA() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        q.mm = poorMm.addr; // no UnderwriterVault deposit => availableBalance 0 < MaxIL
        bytes memory sig = _sign(q, poorMm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "undercollateralised MM => Path A");
    }

    function test_router_dustPremiumB_excluded_noRevert() public {
        // FairPremium just below MIN_PREMIUM so premiumB (load 0) is dust but
        // premiumA (·1.30) clears the floor => B unusable, route to A, NO revert.
        // fairRateWad = 9e7 => FairPremium = MaxIL·9e7/1e18 = 9e5 < MIN_PREMIUM 1e6.
        mfvo.setFairRate(9e7);
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(0, 1);
        bytes memory sig = _sign(q, mm.privateKey);

        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault), "dust premiumB => Path A");
        assertEq(_premium(id), uint128((uint256(9e5) * 130) / 100), "premiumA clears the floor");
    }

    // ─── Protocol-level reverts (path-independent)
    // ───────────────────────

    function test_router_notOwner_reverts() public {
        uint256 tokenId = pm.mint(lp, 1e18); // owned by lp, not msg.sender below
        InflexionCore.SignedQuote memory q = _quote(1500, 1);
        bytes memory sig = _sign(q, mm.privateKey);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(InflexionCore.NotPositionOwner.selector, lp, stranger));
        core.createSwapRouted(q, sig, tokenId, type(uint256).max);
    }

    function test_router_marketNotCvammEnabled_reverts_evenWithGoodQuote() public {
        core.setCvammEnabled(MARKET_ID, false);
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1); // a cheap, valid quote
        bytes memory sig = _sign(q, mm.privateKey);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(InflexionCore.MarketNotCvammEnabled.selector, MARKET_ID));
        core.createSwapRouted(q, sig, tokenId, type(uint256).max);
    }

    function test_router_finalSlippage_reverts() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1); // B wins at premiumB
        bytes memory sig = _sign(q, mm.privateKey);
        uint256 premiumB = (FAIR_PREM * 11_500) / 10_000;
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(InflexionCore.PremiumExceedsSlippage.selector, uint128(premiumB), premiumB - 1)
        );
        core.createSwapRouted(q, sig, tokenId, premiumB - 1);
    }

    // ─── settle dispatch after routing
    // ───────────────────────────────────

    function test_router_settleAfterPathB() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1); // B wins
        bytes memory sig = _sign(q, mm.privateKey);
        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), mm.addr);

        uint256 payout = 4e15; // < MaxIL
        ilMath.setIL(payout);
        (,,,,,,,,,, uint64 expiry,,,,) = core.swaps(id);
        vm.warp(uint256(expiry) + 1);
        sequencer.setRound(2, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        feed.setRound(2, 1e18, uint256(expiry) - 100, true);
        feed.setRound(3, 1e18, uint256(expiry) + 100, true);

        uint256 lpBefore = usd.balanceOf(lp);
        core.settle(id, 2);
        assertEq(usd.balanceOf(lp) - lpBefore, payout, "I2: LP paid min(IL,MaxIL)");
        assertEq(uVault.locked(mm.addr), 0, "MM collateral released");
        assertEq(pm.ownerOf(tokenId), lp, "NFT returned");
    }

    function test_router_settleAfterPathA() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(5000, 1); // A wins
        bytes memory sig = _sign(q, mm.privateKey);
        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);
        assertEq(_mmOf(id), address(cVault));

        uint256 payout = 4e15; // < MaxIL, junior buffer absorbs
        ilMath.setIL(payout);
        (,,,,,,,,,, uint64 expiry,,,,) = core.swaps(id);
        vm.warp(uint256(expiry) + 1);
        sequencer.setRound(2, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        feed.setRound(2, 1e18, uint256(expiry) - 100, true);
        feed.setRound(3, 1e18, uint256(expiry) + 100, true);

        uint256 seniorBefore = cVault.seniorAssets();
        uint256 lpBefore = usd.balanceOf(lp);
        core.settle(id, 2);
        assertEq(usd.balanceOf(lp) - lpBefore, payout, "I2: LP paid min(IL,MaxIL)");
        assertEq(cVault.totalLocked(), 0, "pool collateral released");
        assertEq(cVault.seniorAssets(), seniorBefore, "SENIOR untouched (junior first-loss)");
        assertEq(pm.ownerOf(tokenId), lp, "NFT returned");
    }

    // ─── I10 holds whichever rail wins
    // ───────────────────────────────────

    function testFuzz_router_I10_bothPaths(
        uint16 loadBps
    ) public {
        loadBps = uint16(bound(loadBps, 0, 16_000)); // within the protocol ceiling
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(loadBps, 1);
        bytes memory sig = _sign(q, mm.privateKey);
        vm.prank(lp);
        uint256 id = core.createSwapRouted(q, sig, tokenId, type(uint256).max);

        (, uint128 premium) = _premiumV0Of(id);
        // I10 + cap: premium ≤ FairPremium·(1+maxLoadBps) AND ≤ MaxIL, on either rail.
        uint256 i10Ceiling = (FAIR_PREM * (10_000 + 16_000)) / 10_000;
        assertLe(uint256(premium), i10Ceiling, "I10: premium <= FairPremium*(1+maxLoad)");
        assertLe(uint256(premium), MAX_IL, "economic cap: premium <= MaxIL");
        // Chosen premium is the cheaper of the two candidates.
        assertLe(uint256(premium), PREMIUM_A, "router never charges above the pool floor");
    }

    // ─── I10 on each rail DIRECTLY (createSwapPathA / createSwap), not just routed
    // ───────────────────────────────────────────────────────────────────────────

    /// @dev Path A: for ANY σ (calm/normal/stressed regime ⇒ different baseLoad) the
    ///      pool premium is `FairPremium·(1 + clamp(baseLoad+util+disp, maxLoad))`,
    ///      so I10 holds by construction and the economic cap (≤ MaxIL) is enforced.
    function testFuzz_pathA_I10(
        uint256 sigmaWad
    ) public {
        sigmaWad = bound(sigmaWad, 1e16, 5e18); // 1%..500% vol — spans all three regimes
        mvol.setSigma(sigmaWad);
        uint256 tokenId = _mintNFT();
        vm.prank(lp);
        uint256 id = core.createSwapPathA(MARKET_ID, tokenId, type(uint256).max);

        (, uint128 premium) = _premiumV0Of(id);
        uint256 i10Ceiling = (FAIR_PREM * (10_000 + 16_000)) / 10_000;
        assertLe(uint256(premium), i10Ceiling, "I10 (Path A): premium <= FairPremium*(1+maxLoad)");
        assertLe(uint256(premium), MAX_IL, "economic cap (Path A): premium <= MaxIL");
        assertEq(_mmOf(id), address(cVault), "Path A counterparty is the pool");
    }

    /// @dev Path B: a valid quote with `loadBps ≤ maxLoadBps` yields a premium
    ///      `FairPremium·(1 + loadBps)` capped at MaxIL — I10 holds.
    function testFuzz_pathB_I10(
        uint16 loadBps
    ) public {
        loadBps = uint16(bound(loadBps, 0, 16_000));
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(loadBps, 1);
        bytes memory sig = _sign(q, mm.privateKey);
        vm.prank(lp);
        uint256 id = core.createSwap(q, sig, tokenId, type(uint256).max);

        (, uint128 premium) = _premiumV0Of(id);
        uint256 i10Ceiling = (FAIR_PREM * (10_000 + 16_000)) / 10_000;
        assertLe(uint256(premium), i10Ceiling, "I10 (Path B): premium <= FairPremium*(1+maxLoad)");
        assertLe(uint256(premium), MAX_IL, "economic cap (Path B): premium <= MaxIL");
        assertEq(_mmOf(id), mm.addr, "Path B counterparty is the MM");
    }

    /// @dev Path B: a quote whose `loadBps` exceeds the I10 ceiling is rejected
    ///      (the clamp is enforced as a hard revert on the firm-quote rail).
    function testFuzz_pathB_I10_exceedsReverts(
        uint16 loadBps
    ) public {
        loadBps = uint16(bound(loadBps, 16_001, type(uint16).max));
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(loadBps, 1);
        bytes memory sig = _sign(q, mm.privateKey);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(InflexionCore.LoadExceedsMax.selector, loadBps, uint256(16_000)));
        core.createSwap(q, sig, tokenId, type(uint256).max);
    }

    // ─── Data-moat events: SwapPriced + QuoteFilled
    // ─────────────────────

    /// @notice Path A emits SwapPriced(path=0) with the FULL load breakdown +
    ///         σ_ref. σ=0.6 ⇒ NORMAL regime baseLoad 0.30; util/conc 0 on the
    ///         first swap ⇒ utilSkew/dispSkew 0; totalLoad 0.30; not capped.
    function test_swapPriced_pathA_componentsAndSigma() public {
        uint256 tokenId = _mintNFT();
        uint256 id = core.nextSwapId();
        vm.expectEmit(true, false, false, true, address(core));
        emit InflexionCore.SwapPriced(id, uint8(0), FAIR_PREM, 3e17, 0, 0, 3e17, 6e17, false);
        vm.prank(lp);
        core.createSwapPathA(MARKET_ID, tokenId, type(uint256).max);
    }

    /// @notice Path B emits QuoteFilled (attribution) then SwapPriced(path=1):
    ///         components 0, totalLoad = loadBps·1e14 (1500 ⇒ 1.5e17), σ_ref 6e17.
    function test_swapPriced_and_quoteFilled_pathB() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(1500, 1); // B beats the pool
        bytes memory sig = _sign(q, mm.privateKey);
        uint256 id = core.nextSwapId();
        // Emission order inside the call: SwapCreated, QuoteFilled, SwapPriced, SwapRouted.
        vm.expectEmit(true, true, true, true, address(core));
        emit InflexionCore.QuoteFilled(id, mm.addr, bytes32(uint256(0xB0B)), 1, 1500);
        vm.expectEmit(true, false, false, true, address(core));
        emit InflexionCore.SwapPriced(id, uint8(1), FAIR_PREM, 0, 0, 0, 15e16, 6e17, false);
        vm.prank(lp);
        core.createSwapRouted(q, sig, tokenId, type(uint256).max);
    }

    /// @notice cappedAtMaxIL flags a fill where premium hit the MaxIL cap (zero
    ///         load info — excluded from the clearing-load surface). loadBps 15000
    ///         ⇒ FairPremium·2.5 > MaxIL ⇒ capped; via direct createSwap (a capped
    ///         B can never WIN routing, so route would pick A).
    function test_swapPriced_cappedFlag_directPathB() public {
        uint256 tokenId = _mintNFT();
        InflexionCore.SignedQuote memory q = _quote(15_000, 1);
        bytes memory sig = _sign(q, mm.privateKey);
        uint256 id = core.nextSwapId();
        vm.expectEmit(true, false, false, true, address(core));
        emit InflexionCore.SwapPriced(id, uint8(1), FAIR_PREM, 0, 0, 0, 15e17, 6e17, true);
        vm.prank(lp);
        core.createSwap(q, sig, tokenId, type(uint256).max);
    }

    function _premium(
        uint256 id
    ) internal view returns (uint128 premium) {
        (,,,,,, premium,,,,,,,,) = core.swaps(id);
    }
}
