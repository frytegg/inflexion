// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { UnderwriterVault } from "../src/UnderwriterVault.sol";
import { ILVault } from "../src/ILVault.sol";
import { ConvexityVault } from "../src/ConvexityVault.sol";
import { VolOracle } from "../src/VolOracle.sol";
import { FairValueOracle } from "../src/FairValueOracle.sol";
import { OracleManager } from "../src/OracleManager.sol";
import { IOracleManager } from "../src/interfaces/IOracleManager.sol";
import { IConvexityVault } from "../src/interfaces/IConvexityVault.sol";
import { IVolOracle } from "../src/interfaces/IVolOracle.sol";
import { IFairValueOracle } from "../src/interfaces/IFairValueOracle.sol";
import { CvammPricing } from "../src/libraries/CvammPricing.sol";

import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";
import { MockNonfungiblePositionManager } from "./mocks/MockNonfungiblePositionManager.sol";
import { MockILMath } from "./mocks/MockILMath.sol";

/// @title  InflexionCore Path-A (cvAMM) integration (P3.3 / P3.6 / P3.8)
/// @notice Clean 18/18-dec market with oracleToken == token0 and feed price 1e18,
///         so `_oracleSqrtPriceX96` gives `sqrtP0 = 2^96` (price 1.0). Ticks
///         ±953 ≈ ±10% bracket it (in-range). Proves the signature-free Path-A
///         createSwap (FairPremium + I10 load + pooled lock + premium accrual)
///         and that `settle` dispatches to the ConvexityVault with the junior
///         tranche absorbing the payout (senior protected).
contract InflexionCorePathATest is Test {
    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal seniorDep = makeAddr("senior");
    address internal juniorDep = makeAddr("junior");
    address internal treasury = makeAddr("treasury");

    MockERC20 internal weth; // token0 = oracleToken (volatile)
    MockERC20 internal usd; // token1 = numéraire + vault asset (18-dec "USDC")
    MockAggregator internal sequencer;
    MockAggregator internal feed;
    OracleManager internal oracle;
    MockNonfungiblePositionManager internal pm;
    MockILMath internal ilMath;
    UnderwriterVault internal uVault;
    ILVault internal ilVault;
    ConvexityVault internal cVault;
    VolOracle internal vol;
    FairValueOracle internal fvo;
    InflexionCore internal core;

    uint24 internal constant FEE = 3000;
    uint32 internal constant DURATION = 30 days;
    int24 internal constant TICK_LO = -953; // ~ -9.1%
    int24 internal constant TICK_HI = 953; // ~ +9.6%
    bytes32 internal MARKET_ID;

    uint256 internal constant MAX_IL = 1000e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usd = new MockERC20("USD", "USD", 18);

        sequencer = new MockAggregator(0, "seq");
        feed = new MockAggregator(18, "WETH/USD");
        oracle = new OracleManager(address(sequencer));
        oracle.setPriceFeed(address(weth), address(feed), 90_000);
        sequencer.setRound(1, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        feed.setRound(1, 1e18, block.timestamp - 100, true); // price 1.0 -> sqrtP0 = 2^96

        pm = new MockNonfungiblePositionManager();
        ilVault = new ILVault(address(pm));
        ilMath = new MockILMath();
        ilMath.setMaxIL(MAX_IL);
        uVault = new UnderwriterVault(usd);

        core = new InflexionCore(usd, oracle, ilMath, uVault, ilVault, address(pm), treasury);
        uVault.setCore(address(core));
        ilVault.setCore(address(core));

        // cvAMM stack
        vol = new VolOracle(IOracleManager(address(oracle)), 1 days, 30 days, 5e17, 1 hours, 7 days);
        fvo = new FairValueOracle(IVolOracle(address(vol)));
        cVault = new ConvexityVault(usd, 7 days, 2000); // senior gets 20% of premium
        cVault.setCore(address(core));
        core.setCvamm(IConvexityVault(address(cVault)), IFairValueOracle(address(fvo)), IVolOracle(address(vol)));
        core.setLoadParams(_launchParams());

        // register market: token0=WETH (oracleToken), token1=USD numéraire
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

        // Fund the pool: junior 2000, senior 3000 (junior buffer >= MaxIL).
        _deposit(juniorDep, IConvexityVault.Tranche.JUNIOR, 2000e18);
        _deposit(seniorDep, IConvexityVault.Tranche.SENIOR, 3000e18);

        // Seed the vol oracle (sigma_ref = floor 50%).
        vol.poke(address(weth));

        // LP: USD for premium + a v3 NFT.
        usd.mint(lp, 1_000_000e18);
        vm.prank(lp);
        usd.approve(address(core), type(uint256).max);
    }

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

    function test_createSwapPathA_prices_locks_and_accrues() public {
        uint256 tokenId = pm.mint(lp, 1e18);
        vm.prank(lp);
        pm.setApprovalForAll(address(core), true);

        uint256 seniorBefore = cVault.seniorAssets();
        uint256 juniorBefore = cVault.juniorAssets();

        vm.prank(lp);
        uint256 swapId = core.createSwapPathA(MARKET_ID, tokenId, MAX_IL); // maxPremium = MaxIL ceiling

        (, // tokenId
            address swapLp,
            address swapMm,, // V0
            uint128 maxIl,
            uint128 collateral,
            uint128 premium,, // model
            , // settlement
            , // createdAt
            , // expiry
            , // amount0Entry
            , // amount1Entry
            , // liquidity
            // status
        ) = core.swaps(swapId);
        assertEq(swapLp, lp);
        assertEq(swapMm, address(cVault), "Path A counterparty is the pool");
        assertEq(maxIl, uint128(MAX_IL));
        assertEq(collateral, uint128(MAX_IL));
        assertGt(premium, 0);
        assertLe(premium, uint128(MAX_IL), "I10/economic: premium <= MaxIL");

        // collateral locked from the pool
        assertEq(cVault.totalLocked(), MAX_IL);
        // NFT in custody
        assertEq(pm.ownerOf(tokenId), address(ilVault));
        // premium split: 99% pool (accrued senior+junior), 1% treasury
        uint256 poolCut = (uint256(premium) * 9900) / 10_000;
        uint256 treasuryCut = uint256(premium) - poolCut;
        assertEq(usd.balanceOf(treasury), treasuryCut);
        uint256 accrued = (cVault.seniorAssets() - seniorBefore) + (cVault.juniorAssets() - juniorBefore);
        assertEq(accrued, poolCut, "underwriter share accrued to the pool");
    }

    function test_pathA_settle_pays_lp_junior_absorbs_senior_protected() public {
        uint256 tokenId = pm.mint(lp, 1e18);
        vm.prank(lp);
        pm.setApprovalForAll(address(core), true);
        vm.prank(lp);
        uint256 swapId = core.createSwapPathA(MARKET_ID, tokenId, MAX_IL);

        uint256 seniorAfterCreate = cVault.seniorAssets();
        uint256 juniorAfterCreate = cVault.juniorAssets();

        // settle at expiry with a realised IL of 600 (< MaxIL 1000)
        uint256 payout = 600e18;
        ilMath.setIL(payout);
        (
            ,,,,,,,,,, // tokenId..createdAt (1-10)
            uint64 expiry, // 11
            ,,, // amount0Entry, amount1Entry, liquidity
            // status
        ) = core.swaps(swapId);
        vm.warp(uint256(expiry) + 1);
        sequencer.setRound(2, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        feed.setRound(2, 1e18, uint256(expiry) - 100, true);
        feed.setRound(3, 1e18, uint256(expiry) + 100, true);

        uint256 lpBefore = usd.balanceOf(lp);
        core.settle(swapId, 2);

        assertEq(usd.balanceOf(lp) - lpBefore, payout, "LP paid the realised IL");
        assertEq(cVault.totalLocked(), 0, "collateral released");
        assertEq(cVault.juniorAssets(), juniorAfterCreate - payout, "junior absorbed the payout");
        assertEq(cVault.seniorAssets(), seniorAfterCreate, "SENIOR UNTOUCHED");
        assertEq(pm.ownerOf(tokenId), lp, "NFT returned to LP");
    }
}
