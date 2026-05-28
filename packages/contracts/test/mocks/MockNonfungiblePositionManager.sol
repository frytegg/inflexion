// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal mock NonfungiblePositionManager for ILVault tests:
///         mints ERC721 tokens, exposes a `collect()` that records call
///         args + returns scripted fee amounts, plus per-position
///         `liquidity` storage so the F-#2 test can simulate a third-party
///         `increaseLiquidity` mutation while a position is custodied.
contract MockNonfungiblePositionManager is ERC721 {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct LastCollectCall {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
        bool wasCalled;
    }

    /// @notice Records the most-recent collect() call so tests can assert
    ///         the vault forwarded the right tokenId / recipient / caps.
    LastCollectCall public lastCollect;

    /// @notice Scripted return values for the NEXT collect() call.
    uint256 public scriptedAmount0;
    uint256 public scriptedAmount1;

    /// @notice Per-position liquidity (mutable from outside — simulates the
    ///         F-#2 third-party `increaseLiquidity` mutation).
    mapping(uint256 => uint128) public liquidity;

    uint256 public nextTokenId = 1;

    constructor() ERC721("Mock Uniswap V3 Positions NFT", "UNI-V3-POS-MOCK") { }

    /// @notice Mint a new position NFT to `to` with initial `liquidity_`.
    function mint(
        address to,
        uint128 liquidity_
    ) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        liquidity[tokenId] = liquidity_;
    }

    /// @notice Set the scripted return values for the next collect() call.
    function scriptCollectReturns(
        uint256 amount0,
        uint256 amount1
    ) external {
        scriptedAmount0 = amount0;
        scriptedAmount1 = amount1;
    }

    /// @notice Simulate a third-party `increaseLiquidity` mutation on a
    ///         custodied position (F-#2 scenario). Real users could call
    ///         this on-chain via the real PositionManager; we expose it
    ///         directly so tests can verify ILVault doesn't care.
    function inflateLiquidity(
        uint256 tokenId,
        uint128 extra
    ) external {
        liquidity[tokenId] += extra;
    }

    function collect(
        CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        lastCollect = LastCollectCall({
            tokenId: params.tokenId,
            recipient: params.recipient,
            amount0Max: params.amount0Max,
            amount1Max: params.amount1Max,
            wasCalled: true
        });
        amount0 = scriptedAmount0;
        amount1 = scriptedAmount1;
        // Clear scripted values so a second call without re-scripting yields 0.
        scriptedAmount0 = 0;
        scriptedAmount1 = 0;
    }
}

/// @notice A non-PositionManager ERC721 used to test that ILVault rejects
///         NFTs from anywhere except the canonical PositionManager.
contract HostileERC721 is ERC721 {
    uint256 public nextId = 1;

    constructor() ERC721("Hostile", "HOSTILE") { }

    function mint(
        address to
    ) external returns (uint256 id) {
        id = nextId++;
        _safeMint(to, id);
    }
}
