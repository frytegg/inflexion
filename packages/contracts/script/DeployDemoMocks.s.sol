// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { MockERC20 } from "../test/mocks/MockERC20.sol";

/// @title  DeployDemoMocks — numéraire-correct demo token pair for Arbitrum Sepolia
/// @notice The protocol numéraire is token1 (the stable, USDC), and a Uniswap v3
///         pool sorts token0 < token1 by address. Real Sepolia USDC(0x75fa) <
///         WETH(0x980B), which would make token1 = WETH (wrong numéraire). This
///         deploys a fresh demo pair where dWETH (18 dec, the volatile / oracle
///         token) sorts BELOW dUSDC (6 dec, the stable / numéraire), so any
///         pool/market built on them has token1 = dUSDC. Ordering is engineered
///         by redeploying the dUSDC mock until its CREATE address > dWETH's
///         (~50% per attempt; the discarded mocks are harmless on testnet).
/// @dev    All-mock strategy (no bridged-WETH dependency); the demo still uses the
///         REAL Chainlink ETH/USD feed for price (wired in SeedDemo). Run:
///           forge script script/DeployDemoMocks.s.sol --rpc-url $SEPOLIA_RPC \
///             --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract DeployDemoMocks is Script {
    function run() external {
        vm.startBroadcast();

        // dWETH first (fixed address); then mine dUSDC > dWETH so dUSDC = token1.
        MockERC20 weth = new MockERC20("Inflexion Demo WETH", "dWETH", 18);
        MockERC20 usdc;
        bool ordered;
        for (uint256 i; i < 40; i++) {
            usdc = new MockERC20("Inflexion Demo USDC", "dUSDC", 6);
            if (address(usdc) > address(weth)) {
                ordered = true;
                break;
            }
        }
        require(ordered, "DeployDemoMocks: could not order dUSDC > dWETH");

        // Generous demo supply to the deployer (acts as LP + pool LP + tranches).
        weth.mint(msg.sender, 1000 ether); // 1,000 dWETH
        usdc.mint(msg.sender, 10_000_000e6); // 10,000,000 dUSDC

        vm.stopBroadcast();

        console2.log("DEMO_WETH", address(weth)); // token0 / oracleToken (18 dec)
        console2.log("DEMO_USDC", address(usdc)); // token1 / numeraire   (6 dec)
        require(address(usdc) > address(weth), "DeployDemoMocks: ordering invariant");
    }
}
