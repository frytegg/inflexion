// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IILMath } from "./interfaces/IILMath.sol";
import { IOracleManager } from "./interfaces/IOracleManager.sol";
import { UnderwriterVault } from "./UnderwriterVault.sol";
import { ILVault } from "./ILVault.sol";

/// @notice Slim local subset of Uniswap v3 NonfungiblePositionManager that
///         we read (`positions`) during `createSwap`. v3-periphery's full
///         interface pulls in OZ v4 paths broken under OZ v5.
interface INonfungiblePositionManagerView {
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
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

/// @title  InflexionCore — state machine for FULL / EUROPEAN swaps
/// @notice Wires together OracleManager (entry + settlement price),
///         UnderwriterVault (MM collateral), ILVault (NFT custody),
///         IILMath (Q64.96 IL formulas), and the NonfungiblePositionManager.
///         Verifies MM-signed EIP-712 quotes, enforces the spec §5.2 CEI
///         ordering on `createSwap`, and runs the §5.4 settlement path.
/// @dev    Spec invariants enforced here:
///           * **I1** (no bad debt, FULL): `payout ≤ collateral == MaxIL`
///             by `min(IL, MaxIL)` at settle.
///           * **I2** (cap correctness): `payout == min(IL, MaxIL)`.
///           * **I6** (L immutability): settle uses `swap.liquidity` stored
///             at creation, NEVER `positions(tokenId).liquidity` re-read.
///           * **I7** (capacity authority): `consumedNotional[quoteId] +
///             V0 ≤ maxNotionalV0`; cancelled-nonce bit cannot fill.
///           * **I9** (band enforcement): `absBps(P_live, quotePrice) ≤
///             priceBandBps` at createSwap (Fork 2).
///
///         The IL math itself (`IILMath`) is delegated to an external
///         contract — Stylus in production (Phase 2.2+), a Solidity
///         reference impl as the v1 fallback (separate task). This contract
///         doesn't care which.
contract InflexionCore is EIP712, Ownable {
    using SafeERC20 for IERC20;

    // ─── Constants (Task 5.6; governance-tunable in v2)
    // ────────────────────

    /// @notice Minimum position value (USDC, 6 decimals) — blocks dust
    ///         swaps that would grief MM capacity (spec §5.2 F-#13).
    uint128 public constant MIN_POSITION_V0 = 100e6; // $100

    /// @notice Minimum premium (USDC) — closes the integer-division
    ///         free-coverage edge (spec §5.2 F-#8).
    uint128 public constant MIN_PREMIUM = 1e6; // $1

    /// @notice Lower bound of MM-set `priceBandBps` (Fork 2; spec §4.3.3).
    uint16 public constant PRICE_BAND_MIN_BPS = 25; // 0.25%
    uint16 public constant PRICE_BAND_MAX_BPS = 500; // 5%

    /// @notice Bounds on `validUntil - block.timestamp` (spec §4.3.1).
    uint64 public constant VALIDITY_MIN_S = 5;
    uint64 public constant VALIDITY_MAX_S = 15;

    /// @notice FULL-mode premium split. MM keeps 99%, treasury takes 1%.
    uint256 public constant FULL_MM_BPS = 9900;
    uint256 public constant FULL_TREASURY_BPS = 100;

    uint256 private constant _BPS = 10_000;

    // ─── Enums
    // ────────────────────────────────────────────────────────────

    enum CollateralModel {
        FULL,
        PARTIAL // Phase 2 — not yet supported
    }

    enum SettlementStyle {
        EUROPEAN,
        ASIAN, // reserved
        AMERICAN // reserved
    }

    enum Status {
        UNINITIALIZED,
        ACTIVE,
        SETTLED
    }

    // ─── SignedQuote
    // ─────────────────────────────────────────────────────

    /// @notice MM-signed quote (spec §4.3). EIP-712 hashed.
    struct SignedQuote {
        address mm;
        bytes32 marketId; // keccak(token0, token1, fee, durationSeconds)
        uint16 premiumRateOfMaxIL; // bps of MaxIL
        uint16 minMaxILRatioBps; // ratio band lower bound
        uint16 maxMaxILRatioBps; // ratio band upper bound
        uint128 quotePrice; // oracle price the MM saw at signing
        uint16 priceBandBps; // ± band around quotePrice
        uint8 model; // CollateralModel
        uint16 partialRatioBps; // 0 in FULL
        uint128 maxNotionalV0; // capacity (in V0 units)
        uint64 validUntil; // absolute expiry ts
        bytes32 quoteId; // capacity + replay tracking key
        uint256 nonce; // Permit2-style bitmap encoding (word<<8 | bit)
    }

    /// @dev EIP-712 type-hash for SignedQuote (signature excluded — that's
    ///      the recovered field). Computed via `keccak256` of the type
    ///      string with all fields in struct order.
    bytes32 public constant SIGNED_QUOTE_TYPEHASH = keccak256(
        "SignedQuote(address mm,bytes32 marketId,uint16 premiumRateOfMaxIL,uint16 minMaxILRatioBps,uint16 maxMaxILRatioBps,uint128 quotePrice,uint16 priceBandBps,uint8 model,uint16 partialRatioBps,uint128 maxNotionalV0,uint64 validUntil,bytes32 quoteId,uint256 nonce)"
    );

    // ─── Market registry
    // ──────────────────────────────────────────────────

    /// @notice Per-market configuration. The `marketId` in a quote must
    ///         match `keccak(token0, token1, fee, durationSeconds)` and the
    ///         entry corresponding to that hash must be `active`.
    struct MarketConfig {
        address token0;
        address token1;
        uint24 fee; // pool fee tier (e.g. 500, 3000, 10000)
        uint32 durationSeconds; // swap duration
        address oracleToken; // token whose USD price is used for the band check
        bool active;
    }

    mapping(bytes32 => MarketConfig) public markets;

    // ─── SwapRecord
    // ──────────────────────────────────────────────────────

    /// @notice Storage for an active or settled swap (spec §5.1).
    struct SwapRecord {
        uint256 tokenId;
        address lp;
        address mm;
        uint128 V0;
        uint128 maxIL; // collateral unit; coverage cap
        uint128 collateral; // FULL: == maxIL
        uint128 premium;
        uint8 model;
        uint8 settlement;
        uint64 createdAt;
        uint64 expiry;
        uint160 sqrtP0X96;
        uint128 amount0Entry;
        uint128 amount1Entry;
        uint128 liquidity; // I6: stored once; never re-read at settle
        Status status;
    }

    mapping(uint256 => SwapRecord) public swaps;
    uint256 public nextSwapId = 1;

    /// @notice Bitmap nonces per MM (Permit2-style). Encoding:
    ///         `nonce = (wordIndex << 8) | bitIndex`. Spec §4.3.2 / F-#7.
    mapping(address => mapping(uint256 => uint256)) public nonces;

    /// @notice Per-quote consumed notional (capacity authority, F-#6).
    mapping(bytes32 => uint128) public consumedNotional;

    // ─── External wiring
    // ─────────────────────────────────────────────────

    IERC20 public immutable usdc;
    IOracleManager public immutable oracle;
    IILMath public immutable ilMath;
    UnderwriterVault public immutable underwriterVault;
    ILVault public immutable ilVault;
    address public immutable nonfungiblePositionManager;

    /// @notice Treasury for protocol fees (1% of premium in FULL).
    address public treasury;

    // ─── Events
    // ───────────────────────────────────────────────────────────

    event MarketRegistered(
        bytes32 indexed marketId,
        address token0,
        address token1,
        uint24 fee,
        uint32 durationSeconds,
        address oracleToken
    );
    event MarketDeactivated(bytes32 indexed marketId);
    event TreasurySet(address indexed treasury);
    event NoncesCancelled(address indexed mm, uint256[] nonces);
    event SwapCreated(
        uint256 indexed swapId,
        address indexed lp,
        address indexed mm,
        uint256 tokenId,
        uint128 V0,
        uint128 maxIL,
        uint128 premium
    );
    event SwapSettled(uint256 indexed swapId, uint256 realisedIL, uint128 payout, uint256 settlementPrice);

    // ─── Errors
    // ───────────────────────────────────────────────────────────

    error MarketNotRegistered(bytes32 marketId);
    error MarketMismatch(bytes32 expected, bytes32 actual);
    error NotPositionOwner(address actual, address expected);
    error PositionOutOfRange(int24 tickLower, int24 currentTick, int24 tickUpper);
    error InvalidSignature(address recovered, address expected);
    error QuoteExpired(uint64 validUntil, uint256 nowTs);
    error ValidityOutOfBand(uint64 secondsAhead);
    error NonceAlreadyUsed(address mm, uint256 nonce);
    error PriceOutOfBand(uint256 live, uint128 quoted, uint16 bandBps);
    error PriceBandOutOfProtocolRange(uint16 bandBps);
    error CapacityExceeded(bytes32 quoteId, uint128 attemptedV0, uint128 cap);
    error MMUndercollateralised(address mm, uint128 needed, uint256 available);
    error PremiumExceedsSlippage(uint128 premium, uint256 maxPremium);
    error DustPosition(uint128 V0);
    error DustPremium(uint128 premium);
    error RatioOutOfBand(uint16 ratioBps, uint16 minBps, uint16 maxBps);
    error UnsupportedModel(uint8 model);
    error SwapNotActive(uint256 swapId, Status status);
    error NotYetExpired(uint64 expiry, uint256 nowTs);
    error ZeroAddress();

    // ─── Constructor
    // ──────────────────────────────────────────────────────

    constructor(
        IERC20 _usdc,
        IOracleManager _oracle,
        IILMath _ilMath,
        UnderwriterVault _vault,
        ILVault _ilVault,
        address _nonfungiblePositionManager,
        address _treasury
    ) EIP712("Inflexion", "1") Ownable(msg.sender) {
        if (
            address(_usdc) == address(0) || address(_oracle) == address(0) || address(_ilMath) == address(0)
                || address(_vault) == address(0) || address(_ilVault) == address(0)
                || _nonfungiblePositionManager == address(0) || _treasury == address(0)
        ) {
            revert ZeroAddress();
        }
        usdc = _usdc;
        oracle = _oracle;
        ilMath = _ilMath;
        underwriterVault = _vault;
        ilVault = _ilVault;
        nonfungiblePositionManager = _nonfungiblePositionManager;
        treasury = _treasury;
    }

    // ─── Admin
    // ────────────────────────────────────────────────────────────

    function registerMarket(
        MarketConfig calldata cfg
    ) external onlyOwner {
        bytes32 id = keccak256(abi.encodePacked(cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds));
        markets[id] = cfg;
        emit MarketRegistered(id, cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds, cfg.oracleToken);
    }

    function deactivateMarket(
        bytes32 marketId
    ) external onlyOwner {
        markets[marketId].active = false;
        emit MarketDeactivated(marketId);
    }

    function setTreasury(
        address _treasury
    ) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    // ─── Nonces (Task 5.2 + 5.3, spec §4.3.2 / F-#7)
    // ──────────────────────

    /// @notice Read whether a Permit2-style bitmap nonce has been used.
    /// @param  mm     The signer the nonce belongs to.
    /// @param  nonce  Encoded as `(wordIndex << 8) | bitIndex`.
    function isNonceUsed(
        address mm,
        uint256 nonce
    ) public view returns (bool) {
        uint256 word = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        return (nonces[mm][word] & bit) != 0;
    }

    /// @notice MM-callable: invalidate a batch of own nonces. Flips bits to
    ///         "used" so any quote signed with those nonces is rejected.
    function cancelNonces(
        uint256[] calldata noncesToCancel
    ) external {
        for (uint256 i = 0; i < noncesToCancel.length; ++i) {
            uint256 n = noncesToCancel[i];
            uint256 word = n >> 8;
            uint256 bit = 1 << (n & 0xff);
            nonces[msg.sender][word] |= bit;
        }
        emit NoncesCancelled(msg.sender, noncesToCancel);
    }

    /// @dev Atomically asserts + marks `nonce` used. Reverts if already used.
    function _useNonce(
        address mm,
        uint256 nonce
    ) internal {
        uint256 word = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        uint256 current = nonces[mm][word];
        if ((current & bit) != 0) revert NonceAlreadyUsed(mm, nonce);
        nonces[mm][word] = current | bit;
    }

    // ─── EIP-712 (Task 5.1)
    // ──────────────────────────────────────────────

    /// @notice Expose the EIP-712 domain separator for off-chain consumers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Compute the struct hash of a quote (signature excluded).
    /// @dev    Off-chain signers compute the same hash, prepend the EIP-712
    ///         domain separator, and ECDSA-sign.
    function hashQuote(
        SignedQuote calldata q
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SIGNED_QUOTE_TYPEHASH,
                q.mm,
                q.marketId,
                q.premiumRateOfMaxIL,
                q.minMaxILRatioBps,
                q.maxMaxILRatioBps,
                q.quotePrice,
                q.priceBandBps,
                q.model,
                q.partialRatioBps,
                q.maxNotionalV0,
                q.validUntil,
                q.quoteId,
                q.nonce
            )
        );
    }

    /// @notice Recover signer of a SignedQuote from the EIP-712 digest.
    function recoverSigner(
        SignedQuote calldata q,
        bytes calldata sig
    ) public view returns (address) {
        bytes32 digest = _hashTypedDataV4(hashQuote(q));
        return ECDSA.recover(digest, sig);
    }

    // ─── Views (Task 5.9)
    // ────────────────────────────────────────────────

    /// @notice Compute the payout that would result if the swap settled at
    ///         a given sqrt price, without touching state. Used by the
    ///         invariant test suite (Task 5.10) and by frontends to preview
    ///         settle outcomes without burning gas.
    /// @dev    `sqrtPaX96` and `sqrtPbX96` are not stored on the swap to
    ///         keep the SwapRecord compact — pass them in (off-chain SDK
    ///         reads ticks from the position NFT and converts).
    function settlePreview(
        uint256 swapId,
        uint160 sqrtPTX96,
        uint160 sqrtPaX96,
        uint160 sqrtPbX96
    ) external view returns (uint256 realisedIL, uint128 payout) {
        SwapRecord memory s = swaps[swapId];
        if (s.status != Status.ACTIVE) revert SwapNotActive(swapId, s.status);

        realisedIL = ilMath.computeIL(
            uint256(sqrtPTX96), uint256(sqrtPaX96), uint256(sqrtPbX96), s.liquidity, s.amount0Entry, s.amount1Entry
        );
        payout = realisedIL > s.maxIL ? s.maxIL : uint128(realisedIL);
    }

    // ─── createSwap (Task 5.7)
    // ───────────────────────────────────────────

    /// @notice Open a swap against a signed MM quote (spec §5.2 CEI).
    /// @param  quote        MM-signed quote.
    /// @param  signature    EIP-712 signature of `quote` by `quote.mm`.
    /// @param  tokenId      LP's Uniswap v3 position NFT.
    /// @param  maxPremium   LP slippage guard (in USDC).
    /// @param  sqrtPaX96    Lower-tick sqrt price (off-chain SDK supplies).
    /// @param  sqrtPbX96    Upper-tick sqrt price (off-chain SDK supplies).
    /// @param  sqrtP0X96    Entry sqrt price (off-chain SDK reads pool slot0).
    /// @return swapId       Newly-assigned swap identifier.
    function createSwap(
        SignedQuote calldata quote,
        bytes calldata signature,
        uint256 tokenId,
        uint256 maxPremium,
        uint160 sqrtPaX96,
        uint160 sqrtPbX96,
        uint160 sqrtP0X96
    ) external returns (uint256 swapId) {
        // ───── PHASE 1 — READ (no state change)
        // ──────────────────────────
        MarketConfig memory cfg = markets[quote.marketId];
        if (!cfg.active) revert MarketNotRegistered(quote.marketId);

        // Verify the position belongs to the LP.
        address actualOwner = IERC721(nonfungiblePositionManager).ownerOf(tokenId);
        if (actualOwner != msg.sender) {
            revert NotPositionOwner(actualOwner, msg.sender);
        }

        // Read the position and cross-check market metadata.
        (,, address token0, address token1, uint24 fee,,, uint128 liquidity,,,,) =
            INonfungiblePositionManagerView(nonfungiblePositionManager).positions(tokenId);
        bytes32 derivedMarketId = keccak256(abi.encodePacked(token0, token1, fee, cfg.durationSeconds));
        if (derivedMarketId != quote.marketId) {
            revert MarketMismatch(quote.marketId, derivedMarketId);
        }

        // In-range check: Pa ≤ P0 ≤ Pb (F-#2 / spec §5.2 PHASE 1)
        if (sqrtP0X96 < sqrtPaX96 || sqrtP0X96 > sqrtPbX96) {
            // Tick comparison via sqrt price is monotonic, so this works.
            revert PositionOutOfRange(0, 0, 0); // params populated in v2
        }

        // IL math (delegated to IILMath — Stylus in production)
        uint256 maxIL = ilMath.computeMaxIL(uint256(sqrtP0X96), uint256(sqrtPaX96), uint256(sqrtPbX96), liquidity);

        // Snapshot entry amounts so settle can compute IL without re-reading
        // the position (invariant I6). These come from the same IL math
        // module so we don't duplicate the formula.
        // (Single-call helper kept simple; production splits per-amount.)
        (uint128 a0, uint128 a1) = _entryAmounts(sqrtP0X96, sqrtPaX96, sqrtPbX96, liquidity);

        // V0 in token1 units (token1 is the numéraire — typically USDC).
        // V0 = a0·P0_token1_per_token0 + a1, with P0 = sqrtP0² / 2^192.
        uint256 V0 = _amount0InToken1(a0, sqrtP0X96) + a1;

        // Verify MM signature
        address signer = recoverSigner(quote, signature);
        if (signer != quote.mm) revert InvalidSignature(signer, quote.mm);

        // Premium = ceilDiv(rate · maxIL, 10_000) — round UP (F-#8)
        uint256 premium = Math.ceilDiv(uint256(quote.premiumRateOfMaxIL) * maxIL, _BPS);

        // ───── PHASE 2 — CHECKS
        // ──────────────────────────────────────────
        if (quote.model != uint8(CollateralModel.FULL)) {
            revert UnsupportedModel(quote.model);
        }
        if (V0 < MIN_POSITION_V0) revert DustPosition(uint128(V0));
        if (premium < MIN_PREMIUM) revert DustPremium(uint128(premium));

        uint16 ratioBps = uint16(Math.mulDiv(maxIL, _BPS, V0));
        if (ratioBps < quote.minMaxILRatioBps || ratioBps > quote.maxMaxILRatioBps) {
            revert RatioOutOfBand(ratioBps, quote.minMaxILRatioBps, quote.maxMaxILRatioBps);
        }

        if (quote.validUntil <= block.timestamp) {
            revert QuoteExpired(quote.validUntil, block.timestamp);
        }
        uint64 secondsAhead = quote.validUntil - uint64(block.timestamp);
        if (secondsAhead < VALIDITY_MIN_S || secondsAhead > VALIDITY_MAX_S) {
            revert ValidityOutOfBand(secondsAhead);
        }

        if (isNonceUsed(quote.mm, quote.nonce)) {
            revert NonceAlreadyUsed(quote.mm, quote.nonce);
        }

        if (quote.priceBandBps < PRICE_BAND_MIN_BPS || quote.priceBandBps > PRICE_BAND_MAX_BPS) {
            revert PriceBandOutOfProtocolRange(quote.priceBandBps);
        }
        // Oracle-anchored band check (Fork 2 / §4.3.3 / invariant I9)
        uint256 livePrice = oracle.getPrice(cfg.oracleToken);
        uint256 bandDevBps = oracle.absBps(int256(livePrice), int256(uint256(quote.quotePrice)));
        if (bandDevBps > quote.priceBandBps) {
            revert PriceOutOfBand(livePrice, quote.quotePrice, quote.priceBandBps);
        }

        if (consumedNotional[quote.quoteId] + V0 > quote.maxNotionalV0) {
            revert CapacityExceeded(quote.quoteId, uint128(consumedNotional[quote.quoteId] + V0), quote.maxNotionalV0);
        }

        uint256 mmAvail = underwriterVault.availableBalance(quote.mm);
        if (mmAvail < maxIL) revert MMUndercollateralised(quote.mm, uint128(maxIL), mmAvail);

        if (premium > maxPremium) revert PremiumExceedsSlippage(uint128(premium), maxPremium);

        // ───── PHASE 3 — EFFECTS (state, no external calls) ──────────────
        consumedNotional[quote.quoteId] += uint128(V0);
        _useNonce(quote.mm, quote.nonce);
        underwriterVault.lockCollateral(quote.mm, maxIL);

        swapId = nextSwapId++;
        swaps[swapId] = SwapRecord({
            tokenId: tokenId,
            lp: msg.sender,
            mm: quote.mm,
            V0: uint128(V0),
            maxIL: uint128(maxIL),
            collateral: uint128(maxIL), // FULL
            premium: uint128(premium),
            model: uint8(CollateralModel.FULL),
            settlement: uint8(SettlementStyle.EUROPEAN),
            createdAt: uint64(block.timestamp),
            expiry: uint64(block.timestamp + cfg.durationSeconds),
            sqrtP0X96: sqrtP0X96,
            amount0Entry: a0,
            amount1Entry: a1,
            liquidity: liquidity, // I6: stored once
            status: Status.ACTIVE
        });

        // ───── PHASE 4 — INTERACTIONS (external last)
        // ────────────────────
        // USDC first: if it reverts, NFT never moved.
        usdc.safeTransferFrom(msg.sender, address(this), premium);

        // NFT custody: payload encodes swapId so ILVault can pin the mapping.
        IERC721(nonfungiblePositionManager).safeTransferFrom(msg.sender, address(ilVault), tokenId, abi.encode(swapId));

        // Distribute premium: 99% MM / 1% treasury (FULL, spec §5.2).
        uint256 mmCut = (premium * FULL_MM_BPS) / _BPS;
        uint256 treasuryCut = premium - mmCut;
        if (mmCut > 0) usdc.safeTransfer(quote.mm, mmCut);
        if (treasuryCut > 0) usdc.safeTransfer(treasury, treasuryCut);

        emit SwapCreated(swapId, msg.sender, quote.mm, tokenId, uint128(V0), uint128(maxIL), uint128(premium));
    }

    // ─── settle (Task 5.8, spec §5.4)
    // ────────────────────────────────────

    /// @notice Settle an expired swap. Callable by anyone at or after
    ///         `expiry`. Pulls the Chainlink round-at-T price via
    ///         OracleManager (spec §6.1), recomputes IL using the STORED
    ///         `liquidity` (invariant I6), caps payout at `maxIL`, releases
    ///         collateral and returns the NFT.
    /// @param  swapId        Identifier from `createSwap`.
    /// @param  hintRoundId   Chainlink round id whose `updatedAt` brackets
    ///                       `swap.expiry` (off-chain keeper supplies this;
    ///                       OracleManager verifies — spec §6.1).
    /// @param  sqrtPaX96     Lower-tick sqrt price (same as at creation).
    /// @param  sqrtPbX96     Upper-tick sqrt price (same as at creation).
    /// @param  sqrtPTX96     Settlement sqrt price derived from Chainlink
    ///                       price by the caller (off-chain SDK).
    function settle(
        uint256 swapId,
        uint80 hintRoundId,
        uint160 sqrtPaX96,
        uint160 sqrtPbX96,
        uint160 sqrtPTX96
    ) external {
        SwapRecord storage s = swaps[swapId];
        if (s.status != Status.ACTIVE) revert SwapNotActive(swapId, s.status);
        if (block.timestamp < s.expiry) revert NotYetExpired(s.expiry, block.timestamp);

        // 1. Oracle: pin price at expiry. Reverts on sequencer down, grace,
        //    staleness, lone-spike (unless backstop), wrong-round (spec §6.1).
        MarketConfig memory cfg = _marketForSwap(s);
        (uint256 settlementPrice,) = oracle.getSettlementPrice(cfg.oracleToken, s.expiry, hintRoundId);

        // 2. IL with STORED liquidity (invariant I6).
        uint256 realisedIL = ilMath.computeIL(
            uint256(sqrtPTX96), uint256(sqrtPaX96), uint256(sqrtPbX96), s.liquidity, s.amount0Entry, s.amount1Entry
        );

        // 3. Cap (invariants I1 + I2): payout = min(IL, maxIL).
        uint128 payout = realisedIL > s.maxIL ? s.maxIL : uint128(realisedIL);

        // 4. State transition BEFORE external calls.
        s.status = Status.SETTLED;

        // 5. Vault settles: LP receives payout, MM keeps maxIL - payout.
        underwriterVault.releaseAndDistribute(s.mm, s.lp, payout, s.collateral);

        // 6. NFT returns to LP.
        ilVault.returnNFT(swapId, s.lp);

        emit SwapSettled(swapId, realisedIL, payout, settlementPrice);
    }

    // ─── Internal helpers
    // ────────────────────────────────────────────────

    /// @dev Reconstruct the MarketConfig for a swap. The stored swap doesn't
    ///      carry the marketId directly; we re-derive it from the position
    ///      to keep the SwapRecord compact (storage slot pressure).
    ///      Cheaper alternatives exist; this is the simplest at hackathon scale.
    function _marketForSwap(
        SwapRecord storage s
    ) internal view returns (MarketConfig memory) {
        (,, address token0, address token1, uint24 fee,,,,,,,) =
            INonfungiblePositionManagerView(nonfungiblePositionManager).positions(s.tokenId);
        // We don't store `durationSeconds` per-swap either — derive it from
        // `expiry - createdAt` for the marketId computation.
        uint32 duration = uint32(s.expiry - s.createdAt);
        bytes32 marketId = keccak256(abi.encodePacked(token0, token1, fee, duration));
        return markets[marketId];
    }

    /// @dev Convert `amount0` (token0 wei) to token1-wei equivalent at the
    ///      pool's `sqrtP` (Q64.96). Equivalent to `amount0 · sqrtP² / 2^192`,
    ///      split across two `mulDiv` calls to avoid intermediate overflow.
    function _amount0InToken1(
        uint256 amount0,
        uint160 sqrtPX96
    ) internal pure returns (uint256) {
        uint256 step = Math.mulDiv(amount0, uint256(sqrtPX96), 1 << 96);
        return Math.mulDiv(step, uint256(sqrtPX96), 1 << 96);
    }

    /// @dev Reconstruct entry amounts from sqrt prices + L. Mirrors the
    ///      Uniswap v3 white-paper §6.30 formulas. Returns:
    ///        amount0 = L · (sqrtPb - sqrtP0) / (sqrtP0 · sqrtPb / 2^96)
    ///        amount1 = L · (sqrtP0 - sqrtPa) / 2^96
    function _entryAmounts(
        uint160 sqrtP0X96,
        uint160 sqrtPaX96,
        uint160 sqrtPbX96,
        uint128 liquidity
    ) internal pure returns (uint128 amount0, uint128 amount1) {
        uint256 numer0 = Math.mulDiv(uint256(liquidity), uint256(sqrtPbX96) - uint256(sqrtP0X96), 1 << 96);
        uint256 amt0 = Math.mulDiv(numer0, 1 << 96, uint256(sqrtP0X96));
        amt0 = Math.mulDiv(amt0, 1 << 96, uint256(sqrtPbX96));
        uint256 amt1 = Math.mulDiv(uint256(liquidity), uint256(sqrtP0X96) - uint256(sqrtPaX96), 1 << 96);
        amount0 = uint128(amt0);
        amount1 = uint128(amt1);
    }
}
