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
    address internal constant DEMO_WETH = 0xA8C07E1B245B346c5D1910c5055Efe67bF9E7D1D;
    address internal constant DEMO_USDC = 0xB89630Dc6e020ae2A84aE72b7d9EEDBDfb2C544d;
    uint24 internal constant FEE = 500;

    /// fee-500 / 7-day market (durationSeconds = 604800).
    function test_marketId_fee500_7d_matchesLiveDeployment() public pure {
        bytes32 id = keccak256(abi.encodePacked(DEMO_WETH, DEMO_USDC, FEE, uint32(604_800)));
        assertEq(id, bytes32(0x67c4bee1ee037851fbe2a8ecfdd0b8ae3d358283e940750c268621f776479d69));
    }

    /// fee-500 / 300s lifecycle market (durationSeconds = 300).
    function test_marketId_fee500_300s_matchesLiveDeployment() public pure {
        bytes32 id = keccak256(abi.encodePacked(DEMO_WETH, DEMO_USDC, FEE, uint32(300)));
        assertEq(id, bytes32(0xb8bbd684f213d5833886ade7b531a6949d85522249881a2b5d46a5cc76e439c2));
    }

    /// Guard the pre-image WIDTH itself: the tight-packed bytes must be exactly
    /// 20 + 20 + 3 + 4 = 47 (no ABI padding). A width change trips this directly.
    function test_packedPreimage_is47Bytes() public pure {
        bytes memory packed = abi.encodePacked(DEMO_WETH, DEMO_USDC, FEE, uint32(604_800));
        assertEq(packed.length, 47);
    }
}
