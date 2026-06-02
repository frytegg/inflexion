// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IILMath } from "./interfaces/IILMath.sol";
import { IOracleManager } from "./interfaces/IOracleManager.sol";
import { IFairValueOracle } from "./interfaces/IFairValueOracle.sol";
import { IVolOracle } from "./interfaces/IVolOracle.sol";
import { IConvexityVault } from "./interfaces/IConvexityVault.sol";
import { UnderwriterVault } from "./UnderwriterVault.sol";
import { ILVault } from "./ILVault.sol";
import { TickMath } from "./libraries/TickMath.sol";
import { CvammPricing } from "./libraries/CvammPricing.sol";

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

    /// @notice 2^192 — the squared Q64.96 scale, used by the oracle→sqrtP
    ///         conversion (`_oracleSqrtPriceX96`).
    uint256 private constant _Q192 = 1 << 192;

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
        address oracleToken; // token whose USD price prices entry/settlement + the band check
        uint8 token0Decimals; // ERC-20 decimals of token0 (oracle→sqrtP conversion)
        uint8 token1Decimals; // ERC-20 decimals of token1
        uint8 oracleDecimals; // Chainlink feed decimals for oracleToken (e.g. 8)
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

    // ─── cvAMM (Path A) wiring — set once post-deploy, then frozen ─────────
    //
    // Added via a setter (NOT the constructor) so the existing Path-B deploy /
    // tests are untouched. Path A is the signature-free pooled rail; settle
    // infers the vault from `swap.mm == address(convexityVault)` (no SwapRecord
    // struct change). All load primitives come from `loadParams` (params.json
    // cvAMM block) — hardcoding is the audit failure.
    IConvexityVault public convexityVault;
    IFairValueOracle public fairValueOracle;
    IVolOracle public volOracle;
    bool public cvammFrozen;

    /// @notice The cvAMM load-stack params (baseLoad regimes, the two skews,
    ///         maxLoadBps). Settable by owner from `quant/params.json`.
    CvammPricing.LoadParams public loadParams;

    /// @notice Per-market opt-in to the always-on Path-A pool.
    mapping(bytes32 => bool) public cvammEnabled;

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
    event CvammConfigured(address convexityVault, address fairValueOracle, address volOracle);
    event CvammFrozen();
    event CvammEnabledSet(bytes32 indexed marketId, bool enabled);
    event LoadParamsSet();

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
    error UnsupportedOracleOrientation(address oracleToken, address token0, address token1);
    error UnsupportedDecimals();
    error OracleSqrtOutOfRange(uint256 sq);
    error MarketPriceConfigImmutable(bytes32 marketId);
    error CvammNotConfigured();
    error CvammAlreadyFrozen();
    error MarketNotCvammEnabled(bytes32 marketId);

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
        // The oracle prices ONE of the pair's tokens in USD; the other token is
        // the USD-stable numéraire (Phase-1: USDC — spec §19, USD-quoted pairs
        // only). Reject any pair where the oracle token isn't one of the two.
        if (cfg.oracleToken != cfg.token0 && cfg.oracleToken != cfg.token1) {
            revert UnsupportedOracleOrientation(cfg.oracleToken, cfg.token0, cfg.token1);
        }
        bytes32 id = keccak256(abi.encodePacked(cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds));

        // Price-config immutability: the oracle orientation is fixed once set, so
        // re-registering a market can NEVER re-price an already-active swap (settle
        // re-reads markets[id]). Only `active` (+ identical orientation) may change.
        // (Decimals are read on-chain below, so they cannot drift across re-registers.)
        address prevToken0 = markets[id].token0;
        if (prevToken0 != address(0) && markets[id].oracleToken != cfg.oracleToken) {
            revert MarketPriceConfigImmutable(id);
        }

        // Decimals are read ON-CHAIN, never trusted from owner calldata — a single
        // wrong digit would silently mis-scale every entry/settlement price ~10x
        // (the oracle→sqrtP conversion exponents are decimal-driven, §_oracleSqrtPriceX96).
        MarketConfig memory m = cfg;
        m.token0Decimals = IERC20Metadata(cfg.token0).decimals();
        m.token1Decimals = IERC20Metadata(cfg.token1).decimals();
        m.oracleDecimals = oracle.feedDecimals(cfg.oracleToken);
        markets[id] = m;

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

    // ─── cvAMM (Path A) admin
    // ─────────────────────────────────────────────

    /// @notice Wire the cvAMM (Path A) contracts. Callable until `freezeCvamm`.
    function setCvamm(
        IConvexityVault _convexityVault,
        IFairValueOracle _fairValueOracle,
        IVolOracle _volOracle
    ) external onlyOwner {
        if (cvammFrozen) revert CvammAlreadyFrozen();
        if (
            address(_convexityVault) == address(0) || address(_fairValueOracle) == address(0)
                || address(_volOracle) == address(0)
        ) {
            revert ZeroAddress();
        }
        convexityVault = _convexityVault;
        fairValueOracle = _fairValueOracle;
        volOracle = _volOracle;
        emit CvammConfigured(address(_convexityVault), address(_fairValueOracle), address(_volOracle));
    }

    /// @notice Freeze the cvAMM wiring (one-way), like `UnderwriterVault.freezeCore`.
    function freezeCvamm() external onlyOwner {
        if (address(convexityVault) == address(0)) revert CvammNotConfigured();
        cvammFrozen = true;
        emit CvammFrozen();
    }

    /// @notice Set the cvAMM load-stack params (from `quant/params.json`).
    function setLoadParams(
        CvammPricing.LoadParams calldata p
    ) external onlyOwner {
        loadParams = p;
        emit LoadParamsSet();
    }

    /// @notice Opt a market into the always-on Path-A pool.
    function setCvammEnabled(
        bytes32 marketId,
        bool enabled
    ) external onlyOwner {
        cvammEnabled[marketId] = enabled;
        emit CvammEnabledSet(marketId, enabled);
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
    /// @dev    `sqrtPaX96` / `sqrtPbX96` are re-derived from the position's
    ///         (immutable) `tickLower` / `tickUpper` via TickMath. The
    ///         caller only provides `sqrtPTX96` (the hypothetical
    ///         settlement price they're previewing).
    function settlePreview(
        uint256 swapId,
        uint160 sqrtPTX96
    ) external returns (uint256 realisedIL, uint128 payout) {
        SwapRecord memory s = swaps[swapId];
        if (s.status != Status.ACTIVE) revert SwapNotActive(swapId, s.status);

        (uint160 sqrtPaX96, uint160 sqrtPbX96) = _sqrtBoundsFor(s.tokenId);
        realisedIL = ilMath.computeIL(
            uint256(sqrtPTX96), uint256(sqrtPaX96), uint256(sqrtPbX96), s.liquidity, s.amount0Entry, s.amount1Entry
        );
        payout = realisedIL > s.maxIL ? s.maxIL : uint128(realisedIL);
    }

    /// @notice The Q64.96 sqrt price the protocol derives on-chain from a given
    ///         oracle price for a market. Exposed so the SDK can reproduce the
    ///         exact entry/settlement price the contract will use (createSwap /
    ///         settle do NOT accept a caller-supplied price — they call this).
    function oracleDerivedSqrtPriceX96(
        bytes32 marketId,
        uint256 oraclePrice
    ) external view returns (uint160) {
        return _oracleSqrtPriceX96(markets[marketId], oraclePrice);
    }

    // ─── createSwap (Task 5.7)
    // ───────────────────────────────────────────

    /// @notice Open a swap against a signed MM quote (spec §5.2 CEI).
    /// @param  quote        MM-signed quote.
    /// @param  signature    EIP-712 signature of `quote` by `quote.mm`.
    /// @param  tokenId      LP's Uniswap v3 position NFT.
    /// @param  maxPremium   LP slippage guard (in USDC).
    /// @return swapId       Newly-assigned swap identifier.
    /// @dev    `sqrtPaX96` / `sqrtPbX96` are derived on-chain from the
    ///         position's `tickLower` / `tickUpper` via TickMath, and the entry
    ///         price `sqrtP0X96` is derived on-chain from the Chainlink oracle
    ///         (`_oracleSqrtPriceX96`) — NEVER caller-supplied. The LP can lie
    ///         about neither the range geometry nor the entry price (which
    ///         otherwise sets MaxIL / premium / V0).
    function createSwap(
        SignedQuote calldata quote,
        bytes calldata signature,
        uint256 tokenId,
        uint256 maxPremium
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
        (,, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) =
            INonfungiblePositionManagerView(nonfungiblePositionManager).positions(tokenId);
        bytes32 derivedMarketId = keccak256(abi.encodePacked(token0, token1, fee, cfg.durationSeconds));
        if (derivedMarketId != quote.marketId) {
            revert MarketMismatch(quote.marketId, derivedMarketId);
        }

        // Derive Pa / Pb on-chain from the position's immutable ticks
        // (TickMath). Plugs the trust gap of an off-chain SDK lying about
        // the position's geometry.
        uint160 sqrtPaX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtPbX96 = TickMath.getSqrtRatioAtTick(tickUpper);

        // Entry price P0 is pinned to the Chainlink oracle ON-CHAIN (spec §5.2),
        // NOT caller-supplied — so the LP cannot pick a favourable entry price to
        // game MaxIL / premium / V0. `livePrice` is reused for the Fork-2 band
        // check in PHASE 2 (same oracle read).
        uint256 livePrice = oracle.getPrice(cfg.oracleToken);
        uint160 sqrtP0X96 = _oracleSqrtPriceX96(cfg, livePrice);

        // In-range check: Pa ≤ P0 ≤ Pb (F-#2 / spec §5.2 PHASE 1)
        if (sqrtP0X96 < sqrtPaX96 || sqrtP0X96 > sqrtPbX96) {
            revert PositionOutOfRange(tickLower, 0, tickUpper);
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

        // Verify MM signature — EIP-712 ECDSA *or* EIP-1271 contract signer
        // (§4.7, pre-authorized). `SignatureChecker` recovers ECDSA for EOAs and
        // calls `isValidSignature` for contract signers (incl. a vault-signer);
        // EOA-signed quotes still validate identically, so this is non-breaking.
        bytes32 digest = _hashTypedDataV4(hashQuote(quote));
        if (!SignatureChecker.isValidSignatureNow(quote.mm, digest, signature)) {
            revert InvalidSignature(address(0), quote.mm);
        }

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
        // Oracle-anchored band check (Fork 2 / §4.3.3 / invariant I9).
        // Reuses `livePrice` fetched in PHASE 1 (the same read that pins P0).
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

    // ─── createSwapPathA — cvAMM, signature-free (P3.3, spec §4.0/§5.2) ────

    /// @notice Open a swap against the always-on cvAMM pool (Path A). No signed
    ///         quote, no keeper, no validity clock — the contract reads the
    ///         on-chain published `FairPremium` and the pool's inventory, applies
    ///         the I10-clamped load stack, and locks pooled collateral.
    /// @param  marketId    Selects the duration (`keccak(token0,token1,fee,dur)`).
    /// @param  tokenId     LP's Uniswap v3 position NFT.
    /// @param  maxPremium  LP slippage guard (USDC).
    /// @dev    Mirrors `createSwap`'s on-chain geometry/price discipline
    ///         (ownerOf, positions, Pa/Pb via TickMath, oracle-pinned P0,
    ///         in-range gate, computeMaxIL, entry snapshot, V0, CEI). Pricing is
    ///         `premium = FairPremium·(1 + clamp(baseLoad+util_skew+dispersion,
    ///         maxLoad))` (I10 by construction), additionally capped at MaxIL
    ///         (never charge more than the max possible payout). On Path A
    ///         `mm = address(convexityVault)`, which `settle` uses to dispatch.
    function createSwapPathA(
        bytes32 marketId,
        uint256 tokenId,
        uint256 maxPremium
    ) external returns (uint256 swapId) {
        if (address(convexityVault) == address(0)) revert CvammNotConfigured();

        // ───── PHASE 1 — READ
        MarketConfig memory cfg = markets[marketId];
        if (!cfg.active) revert MarketNotRegistered(marketId);
        if (!cvammEnabled[marketId]) revert MarketNotCvammEnabled(marketId);

        address actualOwner = IERC721(nonfungiblePositionManager).ownerOf(tokenId);
        if (actualOwner != msg.sender) revert NotPositionOwner(actualOwner, msg.sender);

        (,, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) =
            INonfungiblePositionManagerView(nonfungiblePositionManager).positions(tokenId);
        bytes32 derivedMarketId = keccak256(abi.encodePacked(token0, token1, fee, cfg.durationSeconds));
        if (derivedMarketId != marketId) revert MarketMismatch(marketId, derivedMarketId);

        uint160 sqrtPaX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtPbX96 = TickMath.getSqrtRatioAtTick(tickUpper);
        uint160 sqrtP0X96 = _oracleSqrtPriceX96(cfg, oracle.getPrice(cfg.oracleToken));
        if (sqrtP0X96 < sqrtPaX96 || sqrtP0X96 > sqrtPbX96) {
            revert PositionOutOfRange(tickLower, 0, tickUpper);
        }

        uint256 maxIL = ilMath.computeMaxIL(uint256(sqrtP0X96), uint256(sqrtPaX96), uint256(sqrtPbX96), liquidity);
        (uint128 a0, uint128 a1) = _entryAmounts(sqrtP0X96, sqrtPaX96, sqrtPbX96, liquidity);
        uint256 V0 = _amount0InToken1(a0, sqrtP0X96) + a1;

        // Path-A pricing: on-chain FairPremium + I10-clamped load stack.
        uint256 premium = _pathAPremium(cfg, sqrtP0X96, sqrtPaX96, sqrtPbX96, maxIL);

        // ───── PHASE 2 — CHECKS
        if (V0 < MIN_POSITION_V0) revert DustPosition(uint128(V0));
        if (premium < MIN_PREMIUM) revert DustPremium(uint128(premium));
        if (premium > maxPremium) revert PremiumExceedsSlippage(uint128(premium), maxPremium);

        // ───── PHASE 3 — EFFECTS
        convexityVault.lockCollateral(marketId, maxIL); // checks free + senior protection
        swapId = nextSwapId++;
        swaps[swapId] = SwapRecord({
            tokenId: tokenId,
            lp: msg.sender,
            mm: address(convexityVault), // Path A — settle dispatches on this
            V0: uint128(V0),
            maxIL: uint128(maxIL),
            collateral: uint128(maxIL), // FULL
            premium: uint128(premium),
            model: uint8(CollateralModel.FULL),
            settlement: uint8(SettlementStyle.EUROPEAN),
            createdAt: uint64(block.timestamp),
            expiry: uint64(block.timestamp + cfg.durationSeconds),
            amount0Entry: a0,
            amount1Entry: a1,
            liquidity: liquidity, // I6
            status: Status.ACTIVE
        });

        // ───── PHASE 4 — INTERACTIONS
        usdc.safeTransferFrom(msg.sender, address(this), premium);
        IERC721(nonfungiblePositionManager).safeTransferFrom(msg.sender, address(ilVault), tokenId, abi.encode(swapId));
        // Premium split: pool (accrues to depositors) + 1% treasury.
        uint256 poolCut = (premium * FULL_MM_BPS) / _BPS;
        uint256 treasuryCut = premium - poolCut;
        if (treasuryCut > 0) usdc.safeTransfer(treasury, treasuryCut);
        if (poolCut > 0) {
            usdc.forceApprove(address(convexityVault), poolCut);
            convexityVault.accruePremium(poolCut);
        }

        emit SwapCreated(
            swapId, msg.sender, address(convexityVault), tokenId, uint128(V0), uint128(maxIL), uint128(premium)
        );
    }

    /// @dev Path-A premium: FairPremium (on-chain, σ_ref-driven) × (1 + I10 load).
    ///      Pokes the VolOracle first (refresh σ_ref; no-op if too soon). Caps the
    ///      premium at MaxIL — the max possible payout, an economic overcharge guard.
    function _pathAPremium(
        MarketConfig memory cfg,
        uint160 sqrtP0X96,
        uint160 sqrtPaX96,
        uint160 sqrtPbX96,
        uint256 maxIL
    ) internal returns (uint256 premium) {
        // a = Pa/P0 = (sqrtPa/sqrtP0)²;  b = Pb/P0 = (sqrtPb/sqrtP0)²  (WAD)
        uint256 rA = Math.mulDiv(uint256(sqrtPaX96), 1e18, uint256(sqrtP0X96));
        uint256 rB = Math.mulDiv(uint256(sqrtPbX96), 1e18, uint256(sqrtP0X96));
        uint256 aWad = (rA * rA) / 1e18;
        uint256 bWad = (rB * rB) / 1e18;

        volOracle.poke(cfg.oracleToken); // refresh σ_ref (permissionless, no-op if too soon)
        (uint256 fairPrem,, uint256 sigmaRef) =
            fairValueOracle.fairPremium(cfg.oracleToken, aWad, bWad, cfg.durationSeconds, maxIL);

        (,,, uint256 util, uint256 conc) = convexityVault.inventory();
        uint256 load = CvammPricing.totalLoadWad(sigmaRef, util, conc, loadParams);
        premium = CvammPricing.premiumFromLoad(fairPrem, load);
        if (premium > maxIL) premium = maxIL; // never charge more than the max payout
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
    /// @dev    `sqrtPaX96` / `sqrtPbX96` are re-derived on-chain from the
    ///         position's immutable ticks (TickMath), and the settlement price
    ///         `sqrtPTX96` is derived on-chain from the Chainlink round-at-T
    ///         price (`_oracleSqrtPriceX96`) — NEVER caller-supplied. This pins
    ///         settlement to the manipulation-resistant Chainlink price (spec
    ///         §6.1) so the payout reflects the TRUE settlement price
    ///         (invariants I2 / I4), not a value chosen by whoever calls settle.
    function settle(
        uint256 swapId,
        uint80 hintRoundId
    ) external {
        SwapRecord storage s = swaps[swapId];
        if (s.status != Status.ACTIVE) revert SwapNotActive(swapId, s.status);
        if (block.timestamp < s.expiry) revert NotYetExpired(s.expiry, block.timestamp);

        // 1. Status flips to SETTLED FIRST — strict CEI. A malicious
        //    `oracle` / `ilMath` re-entering settle on the same swapId
        //    would now hit the `Status.ACTIVE` check above and revert.
        //    (Both are owner-deployed trusted contracts in practice; this
        //    is defensive hardening + Slither reentrancy-no-eth fix.)
        s.status = Status.SETTLED;

        // 2. Oracle: pin price at expiry. Reverts on sequencer down, grace,
        //    staleness, lone-spike (unless backstop), wrong-round (spec §6.1).
        MarketConfig memory cfg = _marketForSwap(s);
        (uint256 settlementPrice,) = oracle.getSettlementPrice(cfg.oracleToken, s.expiry, hintRoundId);

        // Settlement price is pinned to the Chainlink round-at-T ON-CHAIN
        // (spec §6.1) — NOT caller-supplied. This is what makes the payout
        // reflect the true price (I2/I4) instead of a settler-chosen one.
        uint160 sqrtPTX96 = _oracleSqrtPriceX96(cfg, settlementPrice);

        (uint160 sqrtPaX96, uint160 sqrtPbX96) = _sqrtBoundsFor(s.tokenId);

        // 3. IL with STORED liquidity (invariant I6).
        uint256 realisedIL = ilMath.computeIL(
            uint256(sqrtPTX96), uint256(sqrtPaX96), uint256(sqrtPbX96), s.liquidity, s.amount0Entry, s.amount1Entry
        );

        // 4. Cap (invariants I1 + I2): payout = min(IL, maxIL).
        uint128 payout = realisedIL > s.maxIL ? s.maxIL : uint128(realisedIL);

        // 5. Vault settles: LP receives payout, the counterparty keeps
        //    collateral - payout. Dispatch on the path: Path A's counterparty is
        //    the pooled ConvexityVault (mm == convexityVault), Path B's is the MM.
        //    The settle MATH above (steps 1-4, I1/I2/I6) is identical either way.
        if (address(convexityVault) != address(0) && s.mm == address(convexityVault)) {
            convexityVault.releaseAndDistribute(_marketIdForSwap(s), s.lp, payout, s.collateral);
        } else {
            underwriterVault.releaseAndDistribute(s.mm, s.lp, payout, s.collateral);
        }

        // 6. NFT returns to LP.
        ilVault.returnNFT(swapId, s.lp);

        emit SwapSettled(swapId, realisedIL, payout, settlementPrice);
    }

    // ─── Internal helpers
    // ────────────────────────────────────────────────

    /// @dev Read the position's `tickLower` / `tickUpper` from the NPM and
    ///      convert to Q64.96 sqrt prices via TickMath. Used by both
    ///      `createSwap` (to gate in-range) and `settle` / `settlePreview`
    ///      (to feed the IL math). The position's tick range is immutable
    ///      for a given `tokenId`, so the two readings are guaranteed equal.
    function _sqrtBoundsFor(
        uint256 tokenId
    ) internal view returns (uint160 sqrtPaX96, uint160 sqrtPbX96) {
        (,,,,, int24 tickLower, int24 tickUpper,,,,,) =
            INonfungiblePositionManagerView(nonfungiblePositionManager).positions(tokenId);
        sqrtPaX96 = TickMath.getSqrtRatioAtTick(tickLower);
        sqrtPbX96 = TickMath.getSqrtRatioAtTick(tickUpper);
    }

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

    /// @dev The marketId for a swap (same derivation as `_marketForSwap`), used
    ///      by `settle` to release Path-A collateral against the ConvexityVault.
    function _marketIdForSwap(
        SwapRecord storage s
    ) internal view returns (bytes32) {
        (,, address token0, address token1, uint24 fee,,,,,,,) =
            INonfungiblePositionManagerView(nonfungiblePositionManager).positions(s.tokenId);
        return keccak256(abi.encodePacked(token0, token1, fee, uint32(s.expiry - s.createdAt)));
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

    /// @dev Convert an oracle price (USD per `oracleToken`, scaled to
    ///      `oracleDecimals`) into the pool's Q64.96 sqrt price. This pins both
    ///      the entry price `P0` (createSwap) and the settlement price `P_T`
    ///      (settle) to Chainlink ON-CHAIN — closing the trust hole where a
    ///      caller-supplied sqrt price could set MaxIL/premium (entry) or the
    ///      payout anywhere in `[0, MaxIL]` (settle).
    ///
    ///      The NON-oracle token is assumed a USD-stable numéraire (Phase-1:
    ///      USDC — spec §19 ships USD-quoted pairs only; a USDC depeg is a
    ///      disclosed shared risk). Pool price (Uniswap convention) is
    ///      `token1_raw / token0_raw`, so `sqrtPriceX96^2 = poolPrice_raw·2^192`.
    ///        - oracleToken == token0 (volatile = token0):
    ///            poolPrice_raw = oraclePrice · 10^(t1dec − t0dec − oracleDec)
    ///        - oracleToken == token1 (volatile = token1):
    ///            poolPrice_raw = 10^(oracleDec + t1dec − t0dec) / oraclePrice
    ///      `Math.mulDiv` carries the 512-bit intermediate; `Math.sqrt` is the
    ///      floor integer sqrt. Reverts if the result doesn't fit a `uint160`.
    function _oracleSqrtPriceX96(
        MarketConfig memory cfg,
        uint256 oraclePrice
    ) internal pure returns (uint160) {
        if (oraclePrice == 0) revert OracleSqrtOutOfRange(0);
        uint256 inner;
        if (cfg.oracleToken == cfg.token0) {
            // inner = oraclePrice · 2^192 / 10^(t0dec + oracleDec − t1dec)
            uint256 d = uint256(cfg.token0Decimals) + uint256(cfg.oracleDecimals);
            if (d < uint256(cfg.token1Decimals)) revert UnsupportedDecimals();
            inner = Math.mulDiv(oraclePrice, _Q192, 10 ** (d - uint256(cfg.token1Decimals)));
        } else {
            // oracleToken == token1 (registerMarket guarantees one of the two).
            // inner = 10^(oracleDec + t1dec − t0dec) · 2^192 / oraclePrice
            uint256 e = uint256(cfg.oracleDecimals) + uint256(cfg.token1Decimals);
            if (e < uint256(cfg.token0Decimals)) revert UnsupportedDecimals();
            inner = Math.mulDiv(10 ** (e - uint256(cfg.token0Decimals)), _Q192, oraclePrice);
        }
        uint256 sq = Math.sqrt(inner);
        if (sq == 0 || sq > type(uint160).max) revert OracleSqrtOutOfRange(sq);
        return uint160(sq);
    }
}
