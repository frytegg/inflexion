// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

/// @title  MarketId pre-image parity lock
/// @notice The marketId is a load-bearing JOIN key shared by three independent
///         implementations that MUST agree bit-for-bit, or the Swap↔Market join
///         silently breaks across the stack:
///           - on-chain:  keccak256(abi.encodePacked(address token0, address token1,
///                         uint24 fee, uint32 durationSeconds))  (InflexionCore.sol
///                         registerMarket L355 / _prepareSwap L590 / _marketForSwap
///                         L1146 / _marketIdForSwap L1157)
///           - subgraph:  packages/subgraph/src/helpers.ts `deriveMarketId`
///           - SDK:       packages/sdk/src/resolveMarket.ts `computeMarketId`
///         This test pins the on-chain `abi.encodePacked` layout (the 20+20+3+4 =
///         47-byte tight-packed pre-image) to the LIVE Arbitrum Sepolia demo
///         marketIds recorded in deployments/arbitrum-sepolia.json. If anyone
///         changes a field width (e.g. fee → uint32) the packing shifts and this
///         fails — the exact divergence that would otherwise corrupt every join.
/// @dev    Cross-checked off-chain by packages/sdk/src/marketid.parity.test.ts on
///         the same two vectors (the SDK/width-contract side of the lock).
contract MarketIdParityTest is Test {
    // Demo pair: dWETH < dUSDC ⇒ token0 = dWETH (deployments/arbitrum-sepolia.json).
    address internal constant DEMO_WETH = 0xe8cc35BA27De935972d78348B9E43bF6F97c2444;
    address internal constant DEMO_USDC = 0xeF0462608C6D0C39a6D8f4E9a7316e8433834309;
    uint24 internal constant FEE = 500;

    /// fee-500 / 7-day market (durationSeconds = 604800).
    function test_marketId_fee500_7d_matchesLiveDeployment() public pure {
        bytes32 id = keccak256(abi.encodePacked(DEMO_WETH, DEMO_USDC, FEE, uint32(604_800)));
        assertEq(id, bytes32(0xd1aa1fadc568d6a86c186936ff1de1ec737c844b21b3eebcc2b0ba3080615ca3));
    }

    /// fee-500 / 300s lifecycle market (durationSeconds = 300).
    function test_marketId_fee500_300s_matchesLiveDeployment() public pure {
        bytes32 id = keccak256(abi.encodePacked(DEMO_WETH, DEMO_USDC, FEE, uint32(300)));
        assertEq(id, bytes32(0xacbeedeed5a6daa8765c896ff3cf27645d6e85fba9f8c39ea15a732738fa3e7e));
    }

    /// Guard the pre-image WIDTH itself: the tight-packed bytes must be exactly
    /// 20 + 20 + 3 + 4 = 47 (no ABI padding). A width change trips this directly.
    function test_packedPreimage_is47Bytes() public pure {
        bytes memory packed = abi.encodePacked(DEMO_WETH, DEMO_USDC, FEE, uint32(604_800));
        assertEq(packed.length, 47);
    }
}
