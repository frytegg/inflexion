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

    /// @notice Per-position metadata returned by `positions(tokenId)`.
    struct PositionData {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(uint256 => PositionData) public positionData;

    /// @notice Default position metadata applied to NFTs minted via the
    ///         minimal `mint(to, liquidity)` overload, so older tests that
    ///         don't care about market wiring keep working.
    PositionData public defaultPositionData;

    constructor() ERC721("Mock Uniswap V3 Positions NFT", "UNI-V3-POS-MOCK") { }

    /// @notice Set the default position metadata used by the simple
    ///         `mint(to, liquidity)` overload.
    function setDefaultPositionData(
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) external {
        defaultPositionData =
            PositionData({ token0: token0, token1: token1, fee: fee, tickLower: tickLower, tickUpper: tickUpper });
    }

    /// @notice Mint a new position NFT to `to` with initial `liquidity_`,
    ///         using `defaultPositionData` for the market metadata.
    function mint(
        address to,
        uint128 liquidity_
    ) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        liquidity[tokenId] = liquidity_;
        positionData[tokenId] = defaultPositionData;
    }

    /// @notice Mint a position with explicit market metadata.
    function mintPosition(
        address to,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity_
    ) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        liquidity[tokenId] = liquidity_;
        positionData[tokenId] =
            PositionData({ token0: token0, token1: token1, fee: fee, tickLower: tickLower, tickUpper: tickUpper });
    }

    /// @notice Subset of v3-periphery's `positions(tokenId)` return tuple
    ///         that InflexionCore reads.
    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity_,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        PositionData memory p = positionData[tokenId];
        return (0, address(0), p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, liquidity[tokenId], 0, 0, 0, 0);
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
