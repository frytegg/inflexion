// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Slim local subset of Uniswap v3 NonfungiblePositionManager -
///         only the `collect` call we forward to. We avoid importing
///         v3-periphery's full `INonfungiblePositionManager` because it
///         pulls in OZ v4 paths (`token/ERC721/IERC721Metadata.sol`) that
///         were moved to `extensions/` in OZ v5. Keeping a local subset
///         bounds the dependency surface to exactly what we use.
interface INonfungiblePositionManagerCollect {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(
        CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1);
}

/// @title  ILVault — custodies Uniswap v3 position NFTs during a swap
/// @notice The LP transfers their position NFT into this vault at swap
///         creation (`createSwap` in InflexionCore) using
///         `safeTransferFrom(... bytes(swapId))`. `onERC721Received` pins
///         the (swapId → tokenId, lp) mapping. At settlement, Core calls
///         `returnNFT(swapId, to)` to release the NFT back to the LP.
/// @dev    Critical:
///         - Accepts NFTs ONLY from the canonical `NonfungiblePositionManager`
///           configured at deploy (per chain).
///         - **Never calls `decreaseLiquidity`** on a custodied NFT — that
///           power belongs to the LP, after `returnNFT`.
///         - `claimFees` forwards to `NonfungiblePositionManager.collect`,
///           with `recipient` forced to the registered LP address so
///           accumulated swap fees flow to them, not to anyone with calldata
///           access (spec §5 / §7.1).
///         - F-#2: a third-party `increaseLiquidity` on a custodied NFT
///           does NOT break vault custody invariants. The IL math uses
///           `L` *stored in Core at swap creation* (invariant I6), so any
///           later inflation of the NFT's `liquidity` is ignored at
///           settlement — the LP cannot enrich themselves by minting more
///           liquidity mid-swap.
contract ILVault is IERC721Receiver, Ownable {
    /// @notice The canonical Uniswap v3 NonfungiblePositionManager for
    ///         this network. NFTs from any other contract are rejected.
    address public immutable nonfungiblePositionManager;

    /// @notice `InflexionCore` — only address allowed to call `returnNFT`.
    ///         Settable once, then freezable.
    address public core;
    bool public coreFrozen;

    /// @notice `swapId → tokenId` of the custodied NFT (0 means "no NFT").
    mapping(uint256 => uint256) public tokenIdOf;

    /// @notice `swapId → original LP address` (who deposited the NFT).
    ///         The only address allowed to call `claimFees(swapId, ...)`.
    mapping(uint256 => address) public lpOf;

    // ─── Events
    // ───────────────────────────────────────────────────────────

    event NFTReceived(uint256 indexed swapId, uint256 indexed tokenId, address indexed lp);
    event NFTReturned(uint256 indexed swapId, uint256 indexed tokenId, address indexed to);
    event FeesClaimed(uint256 indexed swapId, address indexed lp, uint256 amount0, uint256 amount1);
    event CoreSet(address indexed core);
    event CoreFrozen(address indexed core);

    // ─── Errors
    // ───────────────────────────────────────────────────────────

    error NotPositionManager(address sender);
    error EmptySwapIdData();
    error SwapAlreadyHasNFT(uint256 swapId, uint256 existingTokenId);
    error OnlyLPCanClaim(uint256 swapId, address lp);
    error NoCustodiedNFT(uint256 swapId);
    error OnlyCore();
    error CoreAlreadyFrozen();
    error CoreNotSet();
    error ZeroAddress();

    // ─── Modifiers
    // ────────────────────────────────────────────────────────

    modifier onlyCore() {
        if (msg.sender != core) revert OnlyCore();
        _;
    }

    // ─── Constructor + wiring
    // ─────────────────────────────────────────────

    constructor(
        address _nonfungiblePositionManager
    ) Ownable(msg.sender) {
        if (_nonfungiblePositionManager == address(0)) revert ZeroAddress();
        nonfungiblePositionManager = _nonfungiblePositionManager;
    }

    function setCore(
        address _core
    ) external onlyOwner {
        if (coreFrozen) revert CoreAlreadyFrozen();
        if (_core == address(0)) revert ZeroAddress();
        core = _core;
        emit CoreSet(_core);
    }

    function freezeCore() external onlyOwner {
        if (core == address(0)) revert CoreNotSet();
        coreFrozen = true;
        emit CoreFrozen(core);
    }

    // ─── ERC-721 receiver hook
    // ────────────────────────────────────────────

    /// @notice Called when an NFT is `safeTransferFrom`-ed into this vault.
    ///         The `data` payload MUST be `abi.encode(uint256 swapId)`.
    /// @dev    Rejects any NFT not from the canonical PositionManager (kills
    ///         spam / dust NFTs and ensures fee collection has a real target).
    function onERC721Received(
        address, /* operator */
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4) {
        if (msg.sender != nonfungiblePositionManager) {
            revert NotPositionManager(msg.sender);
        }
        if (data.length < 32) revert EmptySwapIdData();
        uint256 swapId = abi.decode(data, (uint256));
        if (tokenIdOf[swapId] != 0) {
            revert SwapAlreadyHasNFT(swapId, tokenIdOf[swapId]);
        }
        tokenIdOf[swapId] = tokenId;
        lpOf[swapId] = from;
        emit NFTReceived(swapId, tokenId, from);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── LP-facing
    // ────────────────────────────────────────────────────────

    /// @notice Forward the swap fees to the registered LP via
    ///         `NonfungiblePositionManager.collect`. ONLY the LP who
    ///         deposited the NFT can call.
    /// @dev    `recipient` is forced to the registered LP — calldata cannot
    ///         redirect the fees.
    function claimFees(
        uint256 swapId,
        uint128 amount0Max,
        uint128 amount1Max
    ) external returns (uint256 amount0, uint256 amount1) {
        address lp = lpOf[swapId];
        if (msg.sender != lp) revert OnlyLPCanClaim(swapId, lp);
        uint256 tokenId = tokenIdOf[swapId];
        if (tokenId == 0) revert NoCustodiedNFT(swapId);

        INonfungiblePositionManagerCollect.CollectParams memory params = INonfungiblePositionManagerCollect.CollectParams({
            tokenId: tokenId, recipient: lp, amount0Max: amount0Max, amount1Max: amount1Max
        });
        (amount0, amount1) = INonfungiblePositionManagerCollect(nonfungiblePositionManager).collect(params);
        emit FeesClaimed(swapId, lp, amount0, amount1);
    }

    // ─── Core-facing
    // ──────────────────────────────────────────────────────

    /// @notice Return the custodied NFT to `to`. Called by Inflexion Core
    ///         at settlement — typically `to == lpOf[swapId]`, but Core
    ///         may direct elsewhere (e.g. liquidation in PARTIAL mode).
    function returnNFT(
        uint256 swapId,
        address to
    ) external onlyCore {
        uint256 tokenId = tokenIdOf[swapId];
        if (tokenId == 0) revert NoCustodiedNFT(swapId);
        delete tokenIdOf[swapId];
        delete lpOf[swapId];
        IERC721(nonfungiblePositionManager).safeTransferFrom(address(this), to, tokenId);
        emit NFTReturned(swapId, tokenId, to);
    }
}
