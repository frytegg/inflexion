// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { OracleManager } from "../src/OracleManager.sol";
import { ConvexityVault } from "../src/ConvexityVault.sol";
import { IConvexityVault } from "../src/interfaces/IConvexityVault.sol";
import { MockERC20 } from "../test/mocks/MockERC20.sol";

interface IV3Factory {
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address);
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address);
}

interface IV3Pool {
    function initialize(
        uint160 sqrtPriceX96
    ) external;
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 obsIndex,
            uint16 obsCard,
            uint16 obsCardNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

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

    function mint(
        MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

/// @title  SeedDemo — wire markets + seed the demo dWETH/dUSDC pool + LP position
/// @notice Stage 2 of the Arbitrum-Sepolia demo deploy (after DeployDemoMocks +
///         Deploy.s.sol). Registers the canonical 9 markets against the demo
///         tokens, registers the dWETH price feed (real Chainlink ETH/USD),
///         creates + initialises the fee-500 pool at the live oracle price, mints
///         a ~$100k in-range LP NFT to the deployer, funds the ConvexityVault
///         junior+senior tranches, and approves core to custody the NFT + pull the
///         premium. STOPS before createSwapPathA (that calls the Stylus FVO, which
///         Foundry's revm cannot execute — it is sent live via `cast send`).
/// @dev    Touches NO Stylus contract → fully simulatable. Env inputs:
///           CORE, ORACLE_MANAGER, CONVEXITY_VAULT, DEMO_WETH, DEMO_USDC,
///           SQRT_PRICE_X96 (pool init price ≈ live ETH/USD, decimal-adjusted).
contract SeedDemo is Script {
    // ── Verified Arbitrum Sepolia externals (deployments/arbitrum-sepolia.json) ──
    address internal constant NPM = 0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65;
    address internal constant V3_FACTORY = 0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e;
    address internal constant ETH_USD = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165;
    uint256 internal constant STALENESS = 90_000;

    uint24 internal constant DEMO_FEE = 500; // tickSpacing 10
    int24 internal constant TICK_SPACING = 10;
    int24 internal constant RANGE_TICKS = 200; // ±2% band (in-range with margin)
    uint32 internal constant DEMO_DURATION = 7 days; // shortest canonical market

    function run() external {
        address core = vm.envAddress("CORE");
        address oracleManager = vm.envAddress("ORACLE_MANAGER");
        address cVault = vm.envAddress("CONVEXITY_VAULT");
        address weth = vm.envAddress("DEMO_WETH");
        address usdc = vm.envAddress("DEMO_USDC");
        uint160 sqrtPriceX96 = uint160(vm.envUint("SQRT_PRICE_X96"));
        require(usdc > weth, "SeedDemo: dUSDC must sort above dWETH (numeraire=token1)");

        uint24[3] memory fees = [uint24(500), 3000, 10_000];
        uint32[3] memory durations = [uint32(7 days), 30 days, 90 days];

        vm.startBroadcast();

        // 1. dWETH price feed (real Chainlink ETH/USD) — needed by registerMarket
        //    (feedDecimals) + the createSwap oracle read + the VolOracle poke.
        OracleManager(oracleManager).setPriceFeed(weth, ETH_USD, STALENESS);

        // 2. Register the canonical 9 markets (token0=dWETH, token1=dUSDC,
        //    oracleToken=dWETH) + cvAMM-enable each.
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < 3; j++) {
                InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
                    token0: weth,
                    token1: usdc,
                    fee: fees[i],
                    durationSeconds: durations[j],
                    oracleToken: weth,
                    token0Decimals: 18,
                    token1Decimals: 6,
                    oracleDecimals: 8,
                    active: true
                });
                InflexionCore(core).registerMarket(cfg);
                InflexionCore(core)
                    .setCvammEnabled(keccak256(abi.encodePacked(weth, usdc, fees[i], durations[j])), true);
            }
        }

        // 3. Create + initialise the demo pool (fee 500) at the live oracle price.
        address pool = IV3Factory(V3_FACTORY).getPool(weth, usdc, DEMO_FEE);
        if (pool == address(0)) {
            pool = IV3Factory(V3_FACTORY).createPool(weth, usdc, DEMO_FEE);
        }
        IV3Pool(pool).initialize(sqrtPriceX96);

        // 4. Mint a ~$100k in-range LP NFT to the deployer, centred on pool tick.
        (, int24 tickCurrent,,,,,) = IV3Pool(pool).slot0();
        int24 base = (tickCurrent / TICK_SPACING) * TICK_SPACING;
        int24 tickLower = base - RANGE_TICKS;
        int24 tickUpper = base + RANGE_TICKS;

        IERC20(weth).approve(NPM, type(uint256).max);
        IERC20(usdc).approve(NPM, type(uint256).max);
        (uint256 tokenId, uint128 liquidity,,) = INPM(NPM)
            .mint(
                INPM.MintParams({
                token0: weth,
                token1: usdc,
                fee: DEMO_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: 40 ether, // ~$74k WETH side cap
                amount1Desired: 60_000e6, // ~$60k USDC side cap (range takes the balanced subset → V0 ≈ $100k)
                amount0Min: 0,
                amount1Min: 0,
                recipient: msg.sender,
                deadline: block.timestamp + 600
            })
            );

        // 5. Approvals so core can custody the NFT + pull the Path-A premium (USDC).
        IERC721(NPM).setApprovalForAll(core, true);
        IERC20(usdc).approve(core, type(uint256).max);

        // 6. Fund the ConvexityVault — junior must cover MaxIL (a few hundred $ here);
        //    seed generously so the lock always clears.
        IERC20(usdc).approve(cVault, type(uint256).max);
        ConvexityVault(cVault).deposit(IConvexityVault.Tranche.JUNIOR, 60_000e6);
        ConvexityVault(cVault).deposit(IConvexityVault.Tranche.SENIOR, 60_000e6);

        vm.stopBroadcast();

        bytes32 marketId = keccak256(abi.encodePacked(weth, usdc, DEMO_FEE, DEMO_DURATION));
        console2.log("DEMO_POOL    ", pool);
        console2.log("DEMO_TOKEN_ID", tokenId);
        console2.log("position L   ", uint256(liquidity));
        console2.log("tickLower    ", int256(tickLower));
        console2.log("tickUpper    ", int256(tickUpper));
        console2.log("MARKET_ID (fee500/7d):");
        console2.logBytes32(marketId);
    }
}
