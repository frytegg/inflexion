// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { AggregatorV2V3Interface } from "@chainlink/shared/interfaces/AggregatorV2V3Interface.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { UnderwriterVault } from "../src/UnderwriterVault.sol";
import { ILVault } from "../src/ILVault.sol";
import { OracleManager } from "../src/OracleManager.sol";
import { ILMath } from "../src/ILMath.sol";

/// @title  Task 5.11 — InflexionCore end-to-end fork integration test
/// @notice Real Arbitrum One: WETH, USDC, Uniswap v3 NPM + pool, ETH/USD
///         Chainlink, sequencer feed. Our stack (InflexionCore + vaults +
///         OracleManager + Solidity ILMath) is deployed locally.
/// @dev    The hard problem fork tests face here is that Foundry forks
///         freeze chain state at the fork block: `latestRoundData()` on
///         Chainlink stops updating, so a `vm.warp` past expiry can't
///         find a bracketing round. We solve this with `vm.rollFork`:
///
///           1. Fork at N1 (~90 min in the past). Deploy stack. LP mints
///              a real v3 NFT. MM signs an EIP-712 quote. createSwap.
///           2. `vm.makePersistent` our local contracts + the WETH/USDC/NPM
///              contracts whose storage we mutated (deal, approvals, NFT
///              custody).
///           3. `vm.rollFork(HEAD)` — chain state advances ~90 min;
///              Chainlink now has rounds bracketing our T_expiry.
///           4. settle. Real getSettlementPrice walks real rounds.
///
///         Skipped unless `ARBITRUM_RPC` is set. Run via:
///           `ARBITRUM_RPC=… forge test --match-path test/InflexionCore.fork.t.sol -vvv`
contract InflexionCoreForkTest is Test {
    // ─── Arbitrum One canonical (deployments/arbitrum-one.json) ────────

    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // 6 decimals
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // 18 decimals
    address internal constant NPM = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address internal constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant CHAINLINK_ETH_USD = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;
    address internal constant SEQUENCER_UPTIME = 0xFdB631F5EE196F0ed6FAa767959853A9F217697D;
    uint24 internal constant FEE_500 = 500; // 0.05% — deepest WETH/USDC pool
    uint256 internal constant STALENESS = 90_000;

    // Roll distance — Arbitrum One blocks are ~0.25s. 22,000 blocks ≈ 91 min.
    uint256 internal constant ROLL_BLOCKS = 22_000;

    // Market parameters.
    uint32 internal constant DURATION = 1 hours;

    // ─── Local stack
    // ───────────────────────────────────────────────────

    InflexionCore internal core;
    UnderwriterVault internal vault;
    ILVault internal ilVault;
    OracleManager internal oracle;
    ILMath internal ilMath;

    // ─── Actors
    // ────────────────────────────────────────────────────────

    Vm.Wallet internal mm;
    address internal lp = makeAddr("lp");
    address internal treasury = makeAddr("treasury");

    bool internal forked;
    uint256 internal forkN1;

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        // N1 must be passed via env (bash computes HEAD-22000 once and
        // exports it). Doing it in-test would force two createSelectFork
        // calls and confuse Foundry's per-fork contract-code cache.
        forkN1 = vm.envOr("ARBITRUM_FORK_BLOCK", uint256(0));
        if (forkN1 == 0) {
            emit log("SKIP: ARBITRUM_FORK_BLOCK not set");
            return;
        }
        vm.createSelectFork(rpc, forkN1);
        forked = true;

        mm = vm.createWallet("mm");

        // Deploy stack.
        oracle = new OracleManager(SEQUENCER_UPTIME);
        oracle.setPriceFeed(WETH, CHAINLINK_ETH_USD, STALENESS);
        ilMath = new ILMath();
        vault = new UnderwriterVault(IERC20(USDC));
        ilVault = new ILVault(NPM);
        core = new InflexionCore(IERC20(USDC), oracle, ilMath, vault, ilVault, NPM, treasury);
        vault.setCore(address(core));
        ilVault.setCore(address(core));

        // WETH = 0x82aF.. < USDC = 0xaf88.. numerically, so the Uniswap
        // pool stores token0 = WETH (volatile) and token1 = USDC (stable).
        // We pick WETH as the oracle token: ETH/USD Chainlink quotes USD
        // per WETH at 8 decimals — same as `quotePrice` in the signed quote.
        InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
            token0: WETH,
            token1: USDC,
            fee: FEE_500,
            durationSeconds: DURATION,
            oracleToken: WETH,
            token0Decimals: 18,
            token1Decimals: 6,
            oracleDecimals: 8,
            active: true
        });
        core.registerMarket(cfg);

        // Fund LP.
        deal(WETH, lp, 10 ether);
        deal(USDC, lp, 100_000e6);

        // Fund MM and pre-fund the vault. With ~$10k V0 we expect MaxIL
        // in the tens-to-hundreds of USDC; $1M is generous headroom.
        deal(USDC, mm.addr, 1_000_000e6);
        vm.startPrank(mm.addr);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6);
        vm.stopPrank();
    }

    modifier requiresFork() {
        if (!forked) {
            emit log("SKIP: ARBITRUM_RPC not set - skipping fork test");
            return;
        }
        _;
    }

    // ─── The end-to-end test
    // ───────────────────────────────────────────

    function test_fork_createSwap_settle_endToEnd() public requiresFork {
        // ── 1. Read the pool. Pick a tick range bracketing the current tick.
        address pool = IV3Factory(V3_FACTORY).getPool(WETH, USDC, FEE_500);
        require(pool != address(0), "WETH/USDC 500 pool absent at N1");
        (, int24 tickCurrent,,,,,) = IV3Pool(pool).slot0();

        // ±20 tick-spacings of 10 each = ±200 raw ticks (~±2% range).
        // tickSpacing rounding: snap current tick down to a multiple of 10.
        int24 base = (tickCurrent / 10) * 10;
        int24 tickLower = base - 200;
        int24 tickUpper = base + 200;
        emit log_named_int("tickCurrent", tickCurrent);
        emit log_named_int("tickLower", tickLower);
        emit log_named_int("tickUpper", tickUpper);

        // ── 2. LP mints a real v3 NFT (5 WETH + 20,000 USDC desired).
        vm.startPrank(lp);
        IERC20(WETH).approve(NPM, type(uint256).max);
        IERC20(USDC).approve(NPM, type(uint256).max);
        IERC20(USDC).approve(address(core), type(uint256).max);

        (uint256 tokenId, uint128 liquidity,,) = INPM(NPM)
            .mint(
                INPM.MintParams({
                token0: WETH,
                token1: USDC,
                fee: FEE_500,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: 5 ether,
                amount1Desired: 20_000e6,
                amount0Min: 0,
                amount1Min: 0,
                recipient: lp,
                deadline: block.timestamp + 60
            })
            );
        emit log_named_uint("minted tokenId", tokenId);
        emit log_named_uint("position L", uint256(liquidity));

        IERC721(NPM).setApprovalForAll(address(core), true);
        vm.stopPrank();

        // ── 3. MM signs an EIP-712 quote.
        bytes32 marketId = keccak256(abi.encodePacked(WETH, USDC, FEE_500, DURATION));
        uint128 livePrice = uint128(oracle.getPrice(WETH));
        InflexionCore.SignedQuote memory quote = InflexionCore.SignedQuote({
            mm: mm.addr,
            marketId: marketId,
            premiumRateOfMaxIL: 500, // 5% of MaxIL — safely above $1 floor
            minMaxILRatioBps: 1, // wide ratio band — any MaxIL/V0 ok
            maxMaxILRatioBps: 10_000,
            quotePrice: livePrice,
            priceBandBps: 100, // 1% (within [25, 500])
            model: 0, // FULL
            partialRatioBps: 0,
            maxNotionalV0: type(uint128).max,
            validUntil: uint64(block.timestamp + 10),
            quoteId: keccak256("fork-test-q1"),
            nonce: 0 // word 0, bit 0
        });
        bytes memory sig = _signQuote(quote);

        // ── 4. createSwap. Entry price P0 is derived ON-CHAIN from Chainlink
        //       (no caller-supplied sqrt price).
        vm.prank(lp);
        uint256 swapId = core.createSwap(quote, sig, tokenId, 100_000e6);
        emit log_named_uint("swapId", swapId);

        // Pull the stored swap. Tuple decomposition skips the fields we
        // don't need at this assertion stage.
        (
            uint256 tokenIdStored,,
            address mmStored,
            uint128 V0,
            uint128 maxIL,
            uint128 collateral,
            uint128 premium,,,,
            uint64 expiry,,,,
        ) = core.swaps(swapId);

        assertEq(tokenIdStored, tokenId, "tokenId stored mismatch");
        assertEq(mmStored, mm.addr, "mm stored mismatch");
        assertGt(V0, 0, "V0 must be positive");
        assertGt(maxIL, 0, "maxIL must be positive");
        assertEq(collateral, maxIL, "FULL collateral == maxIL");
        assertGe(premium, 1e6, "premium must be >= MIN_PREMIUM ($1)");
        emit log_named_uint("V0 (USDC wei)", uint256(V0));
        emit log_named_uint("MaxIL (USDC wei)", uint256(maxIL));
        emit log_named_uint("premium (USDC wei)", uint256(premium));

        assertEq(IERC721(NPM).ownerOf(tokenId), address(ilVault), "NFT not custodied");

        uint256 expectedExpiry = block.timestamp + DURATION;
        assertEq(uint256(expiry), expectedExpiry, "expiry math");

        // ── 5. Persist the contracts whose state we want to carry across
        //       the fork roll: our deployments + ERC-20s we deal'd /
        //       approved + the NPM that holds the NFT.
        vm.makePersistent(address(core));
        vm.makePersistent(address(vault));
        vm.makePersistent(address(ilVault));
        vm.makePersistent(address(oracle));
        vm.makePersistent(address(ilMath));
        vm.makePersistent(NPM);
        vm.makePersistent(USDC);
        vm.makePersistent(WETH);
        // The pool contract itself isn't persisted — we want HEAD's pool
        // state for the settlement sqrtP_T reading.

        // ── 6. Roll forward to HEAD-ish. Chainlink now has rounds well
        //       past T_expiry.
        vm.rollFork(forkN1 + ROLL_BLOCKS);
        emit log_named_uint("post-roll block.number", block.number);
        emit log_named_uint("post-roll block.timestamp", block.timestamp);

        // Belt-and-braces: if rollFork didn't advance timestamp far enough
        // (e.g. RPC mismatched block-time assumption), warp explicitly.
        if (block.timestamp < uint256(expiry) + 60) {
            vm.warp(uint256(expiry) + 60);
        }

        // ── 7. Find a Chainlink round bracketing expiry, settle.
        uint80 hint = _findRoundAt(CHAINLINK_ETH_USD, expiry);
        require(hint > 0, "no bracketing Chainlink round at HEAD");
        emit log_named_uint("hint round", uint256(hint));

        // settle is callable by anyone. Settlement price P_T is derived
        // ON-CHAIN from the Chainlink round-at-T (no caller-supplied price).
        core.settle(swapId, hint);

        // ── 8. Asserts after settle.
        assertEq(IERC721(NPM).ownerOf(tokenId), lp, "NFT not returned to LP");

        (,,,,,,,,,,,,,, InflexionCore.Status statusAfter) = core.swaps(swapId);
        assertEq(uint8(statusAfter), uint8(InflexionCore.Status.SETTLED), "status not SETTLED");

        // LP's USDC balance reflects payout (could be 0 if price stayed in
        // a no-IL region) — we don't tie this to a specific amount because
        // pool sqrtP_T moved between fork blocks. We only assert the
        // settle call didn't revert and the NFT is back.
    }

    // ─── Helpers
    // ───────────────────────────────────────────────────────

    function _signQuote(
        InflexionCore.SignedQuote memory q
    ) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), core.hashQuote(q)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(mm.privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Walk Chainlink rounds backward from `latestRoundData` until we
    ///      find one whose `updatedAt ≤ T < nextRound.updatedAt`. Returns 0
    ///      if no such round is found. Same algorithm as the OracleManager
    ///      fork test — duplicated here to keep fork tests independent.
    function _findRoundAt(
        address feed,
        uint64 T
    ) internal view returns (uint80) {
        AggregatorV2V3Interface f = AggregatorV2V3Interface(feed);
        (uint80 latest,,,,) = f.latestRoundData();
        uint80 max = 500;
        uint80 floor_ = latest > max ? latest - max : 1;
        for (uint80 i = latest; i > floor_; --i) {
            (, int256 px,, uint256 updatedAt,) = f.getRoundData(i);
            if (px <= 0 || updatedAt == 0) continue;
            if (updatedAt <= uint256(T)) {
                if (i == latest) continue;
                (, int256 pxNext,, uint256 nextUpdatedAt,) = f.getRoundData(i + 1);
                if (pxNext > 0 && nextUpdatedAt > uint256(T)) return i;
            }
        }
        return 0;
    }
}

// ─── External interfaces (minimal)
// ─────────────────────────────────────

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

interface IV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

interface IV3Factory {
    function getPool(
        address token0,
        address token1,
        uint24 fee
    ) external view returns (address);
}
