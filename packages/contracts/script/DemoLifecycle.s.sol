// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { MockERC20 } from "../test/mocks/MockERC20.sol";

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

/// @title  DemoLifecycle — deployer-side setup for the Path-A-settle + Path-B-routing demos
/// @notice Registers a SHORT-duration (settle-able) market on the existing dWETH/dUSDC
///         fee-500 pool, mints two in-range LP NFTs (one per demo), and funds a fresh MM
///         with gas + dUSDC. Stylus-free → fully simulatable. The Stylus-touching opens
///         (createSwapPathA / createSwapRouted) + the MM deposit + settle run afterwards.
/// @dev    Env: CORE, DEMO_WETH, DEMO_USDC, TICK_LOWER, TICK_UPPER, MM_ADDR, DURATION.
contract DemoLifecycle is Script {
    address internal constant NPM = 0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65;
    uint24 internal constant FEE = 500;

    function run() external {
        address core = vm.envAddress("CORE");
        address weth = vm.envAddress("DEMO_WETH");
        address usdc = vm.envAddress("DEMO_USDC");
        int24 tickLower = int24(vm.envInt("TICK_LOWER"));
        int24 tickUpper = int24(vm.envInt("TICK_UPPER"));
        address mm = vm.envAddress("MM_ADDR");
        uint32 duration = uint32(vm.envUint("DURATION"));

        vm.startBroadcast();

        // 1. Register the short-duration market on the existing fee-500 pool.
        InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
            token0: weth,
            token1: usdc,
            fee: FEE,
            durationSeconds: duration,
            oracleToken: weth,
            token0Decimals: 18,
            token1Decimals: 6,
            oracleDecimals: 8,
            active: true
        });
        InflexionCore(core).registerMarket(cfg);
        bytes32 marketId = keccak256(abi.encodePacked(weth, usdc, FEE, duration));
        InflexionCore(core).setCvammEnabled(marketId, true);

        // 2. Mint two in-range LP NFTs (A = Path-A demo, B = Path-B demo).
        IERC20(weth).approve(NPM, type(uint256).max);
        IERC20(usdc).approve(NPM, type(uint256).max);
        uint256 tokenIdA = _mint(weth, usdc, tickLower, tickUpper);
        uint256 tokenIdB = _mint(weth, usdc, tickLower, tickUpper);
        IERC721(NPM).setApprovalForAll(core, true);
        IERC20(usdc).approve(core, type(uint256).max); // LP pays Path-A/B premium

        // 3. Fund the fresh MM: gas + dUSDC (so it can collateralise a Path-B quote).
        (bool ok,) = mm.call{ value: 0.006 ether }("");
        require(ok, "MM gas fund failed");
        MockERC20(usdc).mint(mm, 50_000e6);

        vm.stopBroadcast();

        console2.log("MARKET_ID:");
        console2.logBytes32(marketId);
        console2.log("TOKEN_ID_A", tokenIdA);
        console2.log("TOKEN_ID_B", tokenIdB);
    }

    function _mint(
        address weth,
        address usdc,
        int24 tickLower,
        int24 tickUpper
    ) internal returns (uint256 tokenId) {
        (tokenId,,,) = INPM(NPM)
            .mint(
                INPM.MintParams({
                token0: weth,
                token1: usdc,
                fee: FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: 80 ether,
                amount1Desired: 150_000e6,
                amount0Min: 0,
                amount1Min: 0,
                recipient: msg.sender,
                deadline: block.timestamp + 600
            })
            );
    }
}
