// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AggregatorV2V3Interface} from "@chainlink/shared/interfaces/AggregatorV2V3Interface.sol";

import {InflexionCore} from "../src/InflexionCore.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {ILVault} from "../src/ILVault.sol";
import {OracleManager} from "../src/OracleManager.sol";
import {ILMath} from "../src/ILMath.sol";
import {ConvexityVault} from "../src/ConvexityVault.sol";
import {FairValueOracle} from "../src/FairValueOracle.sol";
import {VolOracle} from "../src/VolOracle.sol";
import {CvammPricing} from "../src/libraries/CvammPricing.sol";
import {IConvexityVault} from "../src/interfaces/IConvexityVault.sol";
import {IFairValueOracle} from "../src/interfaces/IFairValueOracle.sol";
import {IVolOracle} from "../src/interfaces/IVolOracle.sol";
import {IOracleManager} from "../src/interfaces/IOracleManager.sol";

/// @title  P3.8 — Path-A end-to-end fork test with the REAL cvAMM stack
/// @notice Real Arbitrum One (WETH/USDC, Uniswap v3 NPM + pool, ETH/USD Chainlink,
///         sequencer) + our locally-deployed InflexionCore + ConvexityVault +
///         **REAL** FairValueOracle + VolOracle (no mocks). Path A is the
///         signature-free pooled rail: `createSwapPathA(marketId, tokenId, …)`
///         prices off the on-chain FairPremium and locks MaxIL from the pool.
/// @dev    The sister test `InflexionCore.fork.t.sol` MOCKS the FairValueOracle
///         because a ~$35k / ±2% / 1h position yields a sub-$1 FairPremium
///         (DustPremium). Here we keep the REAL oracle and instead size the
///         position large (~$180k V0) so the real `fairRate·MaxIL` clears
///         MIN_PREMIUM ($1) — sized from `inflexion_quant.cvamm.fair_rate`
///         (±2%, 20min, σ_floor=0.6 ⇒ FairPremium ≈ $31 at V0 ≈ $180k).
///
///         Foundry's revm cannot execute Stylus WASM, so the **Solidity**
///         FairValueOracle is used here; the Stylus port is proven ≡ this exact
///         Φ-sum to machine precision on a Nitro node (see
///         docs/STYLUS_FAIRVALUE_BENCHMARK.md). Run:
///           ARBITRUM_RPC=… ARBITRUM_FORK_BLOCK=… forge test \
///             --match-path 'test/InflexionCorePathA.fork.t.sol' -vvv
contract InflexionCorePathAForkTest is Test {
    // ─── Arbitrum One canonical (deployments/arbitrum-one.json) ────────
    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // 6 dec
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // 18 dec
    address internal constant NPM = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address internal constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant CHAINLINK_ETH_USD = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;
    address internal constant SEQUENCER_UPTIME = 0xFdB631F5EE196F0ed6FAa767959853A9F217697D;
    uint24 internal constant FEE_500 = 500;
    uint256 internal constant STALENESS = 90_000;
    // Fork depth + roll are bounded by the RPC's archive window (~12k blocks ≈
    // 50 min on the provided endpoint). A 20-min test market keeps fork at
    // HEAD-10000 (well inside that window) and rolls to HEAD with ~22 min of
    // settle margin. The protocol's real markets are 7/30/90d — this short
    // duration only exercises the createSwapPathA→settle lifecycle on-fork.
    uint256 internal constant ROLL_BLOCKS = 10_000; // ~42 min @ ~0.25s blocks
    uint32 internal constant DURATION = 20 minutes;

    // ─── Local stack ───────────────────────────────────────────────────
    InflexionCore internal core;
    UnderwriterVault internal vault;
    ILVault internal ilVault;
    OracleManager internal oracle;
    ILMath internal ilMath;
    ConvexityVault internal cVault;
    VolOracle internal vol;
    FairValueOracle internal fvo;

    address internal lp = makeAddr("lp");
    address internal treasury = makeAddr("treasury");
    address internal junior = makeAddr("junior");
    address internal senior = makeAddr("senior");

    bool internal forked;
    uint256 internal forkN1;

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        forkN1 = vm.envOr("ARBITRUM_FORK_BLOCK", uint256(0));
        if (forkN1 == 0) {
            emit log("SKIP: ARBITRUM_FORK_BLOCK not set");
            return;
        }
        vm.createSelectFork(rpc, forkN1);
        forked = true;

        // Core stack.
        oracle = new OracleManager(SEQUENCER_UPTIME);
        oracle.setPriceFeed(WETH, CHAINLINK_ETH_USD, STALENESS);
        ilMath = new ILMath();
        vault = new UnderwriterVault(IERC20(USDC));
        ilVault = new ILVault(NPM);
        core = new InflexionCore(IERC20(USDC), oracle, ilMath, vault, ilVault, NPM, treasury);
        vault.setCore(address(core));
        ilVault.setCore(address(core));

        // REAL cvAMM oracles. VolOracle seeds both EWMA windows at the σ floor on
        // its first poke, so σ_ref = 0.6 deterministically (no price history needed
        // on the frozen fork) — the conservative max(short, long, floor) guard.
        vol = new VolOracle(IOracleManager(address(oracle)), 1 days, 30 days, 6e17, 1 hours, 7 days);
        fvo = new FairValueOracle(IVolOracle(address(vol)));
        cVault = new ConvexityVault(IERC20(USDC), 7 days, 2000);
        cVault.setCore(address(core));

        InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
            token0: WETH,
            token1: USDC,
            fee: FEE_500,
            durationSeconds: DURATION,
            oracleToken: WETH,
            token0Decimals: 18,
            token1Decimals: 6,
            oracleDecimals: 8,
            active: true
        });
        core.registerMarket(cfg);
        core.setCvamm(IConvexityVault(address(cVault)), IFairValueOracle(address(fvo)), IVolOracle(address(vol)));
        core.setLoadParams(
            CvammPricing.LoadParams({
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
            })
        );
        bytes32 marketId = keccak256(abi.encodePacked(WETH, USDC, FEE_500, DURATION));
        core.setCvammEnabled(marketId, true);

        // Pool depositors: junior buffer must cover MaxIL (~$900 here).
        _deposit(junior, IConvexityVault.Tranche.JUNIOR, 50_000e6);
        _deposit(senior, IConvexityVault.Tranche.SENIOR, 50_000e6);

        // LP funds (a ~$180k position so the real FairPremium clears $1).
        deal(WETH, lp, 60 ether);
        deal(USDC, lp, 200_000e6);
    }

    modifier requiresFork() {
        if (!forked) {
            emit log("SKIP: ARBITRUM_RPC / ARBITRUM_FORK_BLOCK not set");
            return;
        }
        _;
    }

    function test_fork_pathA_createSwap_settle() public requiresFork {
        // ── 1. Pool tick → ±2% range (±200 raw ticks, snapped to spacing 10).
        address pool = IV3Factory(V3_FACTORY).getPool(WETH, USDC, FEE_500);
        require(pool != address(0), "WETH/USDC 500 pool absent");
        (, int24 tickCurrent,,,,,) = IV3Pool(pool).slot0();
        int24 base = (tickCurrent / 10) * 10;
        int24 tickLower = base - 200;
        int24 tickUpper = base + 200;

        // ── 2. LP mints a large real v3 NFT (~30 WETH + 90k USDC ≈ $180k V0).
        vm.startPrank(lp);
        IERC20(WETH).approve(NPM, type(uint256).max);
        IERC20(USDC).approve(NPM, type(uint256).max);
        (uint256 tokenId, uint128 liquidity,,) = INPM(NPM)
            .mint(
                INPM.MintParams({
                    token0: WETH,
                    token1: USDC,
                    fee: FEE_500,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    amount0Desired: 30 ether,
                    amount1Desired: 90_000e6,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: lp,
                    deadline: block.timestamp + 60
                })
            );
        emit log_named_uint("position L", uint256(liquidity));
        IERC721(NPM).setApprovalForAll(address(core), true);
        vm.stopPrank();

        // ── 3. Path A: signature-free pooled swap. Premium is the on-chain
        //       FairPremium·(1 + clamped load); collateral = MaxIL from the pool.
        bytes32 marketId = keccak256(abi.encodePacked(WETH, USDC, FEE_500, DURATION));
        vm.prank(lp);
        uint256 swapId = core.createSwapPathA(marketId, tokenId, 100_000e6);

        (
            uint256 tokenIdStored,,
            address mmStored,
            uint128 V0,
            uint128 maxIL,
            uint128 collateral,
            uint128 premium,,,,
            uint64 expiry,,,,
        ) = core.swaps(swapId);

        assertEq(tokenIdStored, tokenId, "tokenId stored");
        assertEq(mmStored, address(cVault), "Path A counterparty is the pool");
        assertGt(V0, 0, "V0 > 0");
        assertGt(maxIL, 0, "MaxIL > 0");
        assertEq(collateral, maxIL, "FULL: collateral == MaxIL");
        assertGe(premium, 1e6, "real FairPremium clears MIN_PREMIUM ($1)");
        // I10: premium <= FairPremium*(1+maxLoad) and the economic cap <= MaxIL.
        assertLe(premium, maxIL, "economic cap: premium <= MaxIL");
        emit log_named_uint("V0 (USDC)", uint256(V0));
        emit log_named_uint("MaxIL (USDC)", uint256(maxIL));
        emit log_named_uint("premium (USDC)", uint256(premium));

        // Pool locked exactly MaxIL; NFT custodied; σ_ref seeded at the floor.
        assertEq(cVault.totalLocked(), maxIL, "pool locked == MaxIL");
        assertEq(IERC721(NPM).ownerOf(tokenId), address(ilVault), "NFT custodied");
        assertEq(vol.sigmaRef(WETH), 6e17, "sigma_ref seeded at floor (0.6)");

        // ── 4. Persist + roll past expiry + settle (real round-at-T).
        vm.makePersistent(address(core));
        vm.makePersistent(address(vault));
        vm.makePersistent(address(ilVault));
        vm.makePersistent(address(oracle));
        vm.makePersistent(address(ilMath));
        vm.makePersistent(address(cVault));
        vm.makePersistent(NPM);
        vm.makePersistent(USDC);
        vm.makePersistent(WETH);

        vm.rollFork(forkN1 + ROLL_BLOCKS);
        if (block.timestamp < uint256(expiry) + 60) {
            vm.warp(uint256(expiry) + 60);
        }

        uint80 hint = _findRoundAt(CHAINLINK_ETH_USD, expiry);
        require(hint > 0, "no bracketing Chainlink round at HEAD");
        core.settle(swapId, hint);

        // ── 5. Post-settle: NFT back, status SETTLED, pool collateral released.
        assertEq(IERC721(NPM).ownerOf(tokenId), lp, "NFT returned to LP");
        (,,,,,,,,,,,,,, InflexionCore.Status statusAfter) = core.swaps(swapId);
        assertEq(uint8(statusAfter), uint8(InflexionCore.Status.SETTLED), "status SETTLED");
        assertEq(cVault.totalLocked(), 0, "pool collateral released");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────
    function _deposit(address who, IConvexityVault.Tranche t, uint256 amt) internal {
        deal(USDC, who, amt);
        vm.startPrank(who);
        IERC20(USDC).approve(address(cVault), amt);
        cVault.deposit(t, amt);
        vm.stopPrank();
    }

    function _findRoundAt(address feed, uint64 T) internal view returns (uint80) {
        AggregatorV2V3Interface f = AggregatorV2V3Interface(feed);
        (uint80 latest,,,,) = f.latestRoundData();
        uint80 max = 500;
        uint80 floor_ = latest > max ? latest - max : 1;
        for (uint80 i = latest; i > floor_; --i) {
            (, int256 px,, uint256 updatedAt,) = f.getRoundData(i);
            if (px <= 0 || updatedAt == 0) continue;
            if (updatedAt <= uint256(T)) {
                if (i == latest) continue;
                (, int256 pxNext,, uint256 nextUpdatedAt,) = f.getRoundData(i + 1);
                if (pxNext > 0 && nextUpdatedAt > uint256(T)) return i;
            }
        }
        return 0;
    }
}

// ─── External interfaces (minimal) ───────────────────────────────────────
interface INPM {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

interface IV3Factory {
    function getPool(address token0, address token1, uint24 fee) external view returns (address);
}
