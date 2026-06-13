// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { OracleManager } from "../src/OracleManager.sol";

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

/// @title  SeedExtraTiers — seed the 0.30% + 1.00% demo pools + in-range LP NFTs
/// @notice Companion to SeedDemo, which only creates the fee-500 (0.05%) pool +
///         position. The canonical 9 markets are ALREADY registered by SeedDemo
///         across all three fee tiers, but only the 0.05% pool exists on-chain and
///         holds an LP NFT. The Protect UI now treats the fee tier as a FILTER over
///         the owner's positions, so the 0.30% and 1.00% tiers render empty/disabled
///         until positions exist there. This creates + initialises those two pools
///         at the LIVE oracle price and mints one in-range LP NFT in each to the
///         deployer, so all three fee tiers are populated for the demo.
/// @dev    IDEMPOTENT on pool create/init: it skips `initialize` when the pool
///         already has a price, so it is safe to run against the existing
///         deployment (it never touches the already-seeded fee-500 pool or the
///         registered markets). Initialising each new pool at the protocol's exact
///         oracle-derived sqrtP0 and centring the range on the resulting pool tick
///         guarantees the minted positions satisfy the createSwap in-range gate
///         (Pa ≤ P0 ≤ Pb at the oracle price). Touches NO Stylus contract → fully
///         simulatable. Run:
///           forge script script/SeedExtraTiers.s.sol --rpc-url $SEPOLIA_RPC \
///             --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///         Env inputs: CORE, ORACLE_MANAGER, DEMO_WETH, DEMO_USDC.
contract SeedExtraTiers is Script {
    // ── Verified Arbitrum Sepolia externals (deployments/arbitrum-sepolia.json) ──
    address internal constant NPM = 0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65;
    address internal constant V3_FACTORY = 0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e;

    // Any active market for the pair works for the sqrtP0 derivation — the
    // oracle→sqrtP conversion depends only on the (identical) token/oracle decimals,
    // not on fee or duration. 7d is the canonical shortest tenor.
    uint32 internal constant DERIV_DURATION = 7 days;

    // ±~6.2% band. 600 is a clean multiple of BOTH the 0.30% (60) and 1.00% (200)
    // tick spacings, and wide enough to stay in-range across normal oracle drift.
    int24 internal constant RANGE_TICKS = 600;

    uint256 internal constant AMOUNT0_DESIRED = 40 ether; // dWETH side cap (~$74k)
    uint256 internal constant AMOUNT1_DESIRED = 60_000e6; // dUSDC side cap (~$60k)

    function run() external {
        address core = vm.envAddress("CORE");
        address oracleManager = vm.envAddress("ORACLE_MANAGER");
        address weth = vm.envAddress("DEMO_WETH");
        address usdc = vm.envAddress("DEMO_USDC");
        require(usdc > weth, "SeedExtraTiers: dUSDC must sort above dWETH (numeraire=token1)");

        // The two fee tiers SeedDemo did NOT create a pool for (0.05% is seeded).
        uint24[2] memory fees = [uint24(3000), 10_000];
        int24[2] memory spacings = [int24(60), 200];

        // Live oracle price (feed-decimal) — drives each new pool's init price.
        uint256 oraclePrice = OracleManager(oracleManager).getPrice(weth);

        vm.startBroadcast();

        // NFT custody + premium approvals to core, and token approvals to the NPM
        // (idempotent; makes the script standalone-runnable and the new NFTs
        // immediately buy-ready through InflexionCore).
        IERC721(NPM).setApprovalForAll(core, true);
        IERC20(usdc).approve(core, type(uint256).max);
        IERC20(weth).approve(NPM, type(uint256).max);
        IERC20(usdc).approve(NPM, type(uint256).max);

        for (uint256 i; i < fees.length; i++) {
            uint24 fee = fees[i];
            int24 spacing = spacings[i];

            // The protocol's exact sqrtP0 for this pair at the live oracle price.
            bytes32 derivMarketId = keccak256(abi.encodePacked(weth, usdc, fee, DERIV_DURATION));
            uint160 sqrtP = InflexionCore(core).oracleDerivedSqrtPriceX96(derivMarketId, oraclePrice);

            // Create + initialise the pool (idempotent on both).
            address pool = IV3Factory(V3_FACTORY).getPool(weth, usdc, fee);
            if (pool == address(0)) {
                pool = IV3Factory(V3_FACTORY).createPool(weth, usdc, fee);
            }
            (uint160 existing,,,,,,) = IV3Pool(pool).slot0();
            if (existing == 0) {
                IV3Pool(pool).initialize(sqrtP);
            }

            // Centre an in-range band on the pool's current tick (≈ the oracle tick).
            (, int24 tickCurrent,,,,,) = IV3Pool(pool).slot0();
            int24 base = (tickCurrent / spacing) * spacing;
            int24 tickLower = base - RANGE_TICKS;
            int24 tickUpper = base + RANGE_TICKS;

            (uint256 tokenId, uint128 liquidity,,) = INPM(NPM)
                .mint(
                    INPM.MintParams({
                    token0: weth,
                    token1: usdc,
                    fee: fee,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    amount0Desired: AMOUNT0_DESIRED,
                    amount1Desired: AMOUNT1_DESIRED,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: msg.sender,
                    deadline: block.timestamp + 600
                })
                );

            console2.log("fee tier   ", uint256(fee));
            console2.log("  pool     ", pool);
            console2.log("  tokenId  ", tokenId);
            console2.log("  liquidity", uint256(liquidity));
            console2.log("  tickLower", int256(tickLower));
            console2.log("  tickUpper", int256(tickUpper));
        }

        vm.stopBroadcast();
    }
}
