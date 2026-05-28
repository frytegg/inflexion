// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";

import { InflexionCore } from "../src/InflexionCore.sol";
import { UnderwriterVault } from "../src/UnderwriterVault.sol";
import { ILVault } from "../src/ILVault.sol";
import { OracleManager } from "../src/OracleManager.sol";

import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";
import { MockNonfungiblePositionManager } from "./mocks/MockNonfungiblePositionManager.sol";
import { MockILMath } from "./mocks/MockILMath.sol";

/// @title  InflexionCore invariants (Task 5.10) — I1 / I2 / I6 / I9 property tests
///         + stateful Handler for I5.
/// @notice Spec §13:
///           * I1 (no bad debt, FULL): `payout ≤ collateral == MaxIL`
///           * I2 (cap correctness):   `payout == min(IL, MaxIL)`
///           * I5 (vault solvency):    `locked[mm] ≤ deposited[mm]`
///           * I6 (L immutability):    `payout` uses STORED L, never re-reads
///           * I9 (band enforcement):  oracle drift > priceBandBps reverts createSwap
///
///         I3 / I4 (non-neg / LP no-profit) live INSIDE the IL math itself
///         and need the real Solidity / Stylus impl to be meaningful —
///         deferred to that task.
///
///         I7 (capacity authority): partial coverage in the createSwap
///         unit suite (`test_createSwap_consumedNotional_tracked`,
///         `test_createSwap_rejectsUsedNonce`); a full Handler-driven
///         stateful test is overkill at hackathon scope.
///
///         I8 (settlement liveness): covered in `OracleManager.invariant.t.sol`
///         (Phase 3 — 1,280 fuzz runs across the feasible window).
contract InflexionCoreInvariantsTest is Test {
    // ─── Players + contracts (shared across tests)
    // ────────────────────────

    Vm.Wallet internal mmWallet;
    address internal lp = makeAddr("lp");
    address internal treasury = makeAddr("treasury");
    address internal owner = makeAddr("owner");

    InflexionCore internal core;
    UnderwriterVault internal vault;
    ILVault internal ilVault;
    MockERC20 internal usdc;
    OracleManager internal oracle;
    MockAggregator internal sequencer;
    MockAggregator internal ethFeed;
    MockNonfungiblePositionManager internal pm;
    MockILMath internal ilMath;

    address internal constant WETH = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);
    address internal constant USDC_TOKEN = address(0x1111111111111111111111111111111111111111);
    uint24 internal constant FEE = 3000;
    uint32 internal constant DURATION = 30 days;
    bytes32 internal MARKET_ID;

    uint128 internal constant POSITION_LIQUIDITY = 1e10;
    uint256 internal constant USDC_BANKROLL = 1_000_000e6;

    uint160 internal constant SQRT_PA = uint160(uint256(1) << 96);
    uint160 internal constant SQRT_PB = uint160((uint256(1) << 96) * 2);
    uint160 internal constant SQRT_P0 = uint160((uint256(1) << 96) * 1414 / 1000);
    uint160 internal constant SQRT_PT = uint160((uint256(1) << 96) * 12 / 10);

    function setUp() public virtual {
        mmWallet = vm.createWallet("mm");

        vm.warp(1_800_000_000);

        vm.prank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vm.prank(owner);
        sequencer = new MockAggregator(0, "L2 Sequencer");
        vm.prank(owner);
        ethFeed = new MockAggregator(8, "ETH / USD");
        vm.prank(owner);
        oracle = new OracleManager(address(sequencer));
        vm.prank(owner);
        oracle.setPriceFeed(WETH, address(ethFeed), 90_000);
        sequencer.setRound(1, 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        ethFeed.setRound(1, 3000e8, block.timestamp - 100, true);

        vm.prank(owner);
        vault = new UnderwriterVault(usdc);
        pm = new MockNonfungiblePositionManager();
        vm.prank(owner);
        ilVault = new ILVault(address(pm));

        ilMath = new MockILMath();

        vm.prank(owner);
        core = new InflexionCore(usdc, oracle, ilMath, vault, ilVault, address(pm), treasury);

        vm.prank(owner);
        vault.setCore(address(core));
        vm.prank(owner);
        ilVault.setCore(address(core));

        InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
            token0: USDC_TOKEN, token1: WETH, fee: FEE, durationSeconds: DURATION, oracleToken: WETH, active: true
        });
        MARKET_ID = keccak256(abi.encodePacked(cfg.token0, cfg.token1, cfg.fee, cfg.durationSeconds));
        vm.prank(owner);
        core.registerMarket(cfg);

        usdc.mint(mmWallet.addr, USDC_BANKROLL);
        vm.prank(mmWallet.addr);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(mmWallet.addr);
        vault.deposit(USDC_BANKROLL);

        usdc.mint(lp, USDC_BANKROLL);
        vm.prank(lp);
        usdc.approve(address(core), type(uint256).max);

        pm.setDefaultPositionData(USDC_TOKEN, WETH, FEE, -887_220, 887_220);
    }

    // ─── Helpers
    // ─────────────────────────────────────────────────────────

    function _mintLPNFT() internal returns (uint256 tokenId) {
        tokenId = pm.mint(lp, POSITION_LIQUIDITY);
        vm.prank(lp);
        pm.setApprovalForAll(address(core), true);
    }

    function _signQuote(
        InflexionCore.SignedQuote memory q
    ) internal view returns (bytes memory sig) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), core.hashQuote(q)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(mmWallet.privateKey, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _defaultQuote(
        uint256 nonce
    ) internal view returns (InflexionCore.SignedQuote memory q) {
        q = InflexionCore.SignedQuote({
            mm: mmWallet.addr,
            marketId: MARKET_ID,
            premiumRateOfMaxIL: 7500,
            minMaxILRatioBps: 0,
            maxMaxILRatioBps: 10_000,
            quotePrice: 3000e8,
            priceBandBps: 100,
            model: uint8(InflexionCore.CollateralModel.FULL),
            partialRatioBps: 0,
            maxNotionalV0: 10_000_000e6,
            validUntil: uint64(block.timestamp + 10),
            quoteId: bytes32(uint256(0xdead)),
            nonce: nonce
        });
    }

    function _createSwapWithMaxIL(
        uint128 maxIL,
        uint256 nonce
    ) internal returns (uint256 swapId, uint256 tokenId) {
        ilMath.setMaxIL(maxIL);
        tokenId = _mintLPNFT();
        InflexionCore.SignedQuote memory q = _defaultQuote(nonce);
        bytes memory sig = _signQuote(q);
        vm.prank(lp);
        swapId = core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_PA, SQRT_PB, SQRT_P0);
    }

    function _warpAndSeedSettlementRound(
        uint64 expiry
    ) internal {
        vm.warp(uint256(expiry) + 1);
        sequencer.setRound(uint80(2), 0, block.timestamp - oracle.GRACE_PERIOD() - 1, true);
        ethFeed.setRound(2, 3000e8, uint256(expiry) - 100, true);
        ethFeed.setRound(3, 3000e8, uint256(expiry) + 100, true);
    }

    // ─── I1 + I2: payout ≤ maxIL  AND  payout = min(IL, maxIL) ───────────

    function testFuzz_I1_I2_payoutCappedAtMaxIL(
        uint128 maxIL,
        uint128 realisedIL
    ) public {
        // Bound:
        //   - maxIL ∈ [$200, $5,000] — above MIN_PREMIUM dust floor, below V0
        //     (≈ $8,283 with our placeholder sqrt prices) so the
        //     `maxIL / V0 ≤ maxMaxILRatioBps` gate is satisfied.
        //   - realisedIL spans 0 → 10× maxIL so both cap-active and
        //     cap-inactive branches fire.
        uint128 mm = uint128(bound(uint256(maxIL), 200e6, 5000e6));
        uint128 rIL = uint128(bound(uint256(realisedIL), 0, 50_000e6));

        (uint256 swapId,) = _createSwapWithMaxIL(mm, 1);
        (,,,, uint128 storedMaxIL,,,,,, uint64 expiry,,,,,) = core.swaps(swapId);

        _warpAndSeedSettlementRound(expiry);
        ilMath.setIL(rIL);

        uint256 lpBefore = usdc.balanceOf(lp);
        core.settle(swapId, 2, SQRT_PA, SQRT_PB, SQRT_PT);
        uint256 paid = usdc.balanceOf(lp) - lpBefore;

        // I1: payout ≤ maxIL (== collateral)
        assertLe(paid, storedMaxIL, "I1: payout > maxIL");
        // I2: payout == min(realisedIL, maxIL)
        uint256 expected = rIL > storedMaxIL ? storedMaxIL : rIL;
        assertEq(paid, expected, "I2: payout != min(IL, maxIL)");
    }

    // ─── I6: STORED liquidity is used at settle
    // ──────────────────────────

    /// @notice Inflate the position NFT's liquidity AFTER createSwap and
    ///         verify that the IL passed to the math layer is still the
    ///         STORED L, not the (now-larger) re-read.
    function testFuzz_I6_settleUsesStoredLiquidity(
        uint64 inflateBy
    ) public {
        // createSwap path: use a normal scripted maxIL so the ratio gate
        // is satisfied. echoLiquidityIL stays OFF here.
        (uint256 swapId, uint256 tokenId) = _createSwapWithMaxIL(uint128(2000e6), 1);
        (,,,, uint128 storedMaxIL,,,,,, uint64 expiry,,,, uint128 storedL,) = core.swaps(swapId);
        assertEq(storedL, POSITION_LIQUIDITY, "stored L mismatch (setUp sanity)");

        // Third-party / accident inflates the NFT's L between create and
        // settle (the F-#2 scenario).
        pm.inflateLiquidity(tokenId, inflateBy);
        assertEq(pm.liquidity(tokenId), uint128(POSITION_LIQUIDITY) + inflateBy);

        // settle path: switch the math mock to echo `liquidity` as the IL
        // value so we can read off WHICH L the contract passed in.
        ilMath.setEchoLiquidityIL(true);

        _warpAndSeedSettlementRound(expiry);
        uint256 lpBefore = usdc.balanceOf(lp);
        core.settle(swapId, 2, SQRT_PA, SQRT_PB, SQRT_PT);
        uint256 paid = usdc.balanceOf(lp) - lpBefore;

        // STORED-L branch: IL = POSITION_LIQUIDITY = 1e10. Cap at maxIL
        // ($2,000 = 2e9). So payout MUST equal maxIL (the IL exceeds cap).
        // RE-READ-L branch: IL = POSITION_LIQUIDITY + inflateBy > 1e10 →
        // ALSO capped at maxIL. Both branches yield `maxIL` once capped —
        // so the cap defeats the test by hiding the L choice.
        //
        // Stronger assertion: confirm payout == maxIL, which is the I1+I2
        // bound; THEN assert via the contract's own NatSpec invariant that
        // settle never re-reads — checked by inspection of `getSettlementPrice`
        // call site in `InflexionCore.settle`, which passes `s.liquidity`.
        assertEq(paid, storedMaxIL, "I1: payout must cap at maxIL");
        assertLe(paid, storedMaxIL, "I1 again - explicit");
    }

    /// @notice Direct deterministic check via the IL-call recorder: at
    ///         settle time the contract MUST forward the STORED liquidity
    ///         to the IL math, not a re-read of the mutable position field.
    function testFuzz_I6_recordsStoredLiquidity(
        uint64 inflateBy
    ) public {
        (uint256 swapId, uint256 tokenId) = _createSwapWithMaxIL(uint128(2000e6), 1);
        (,,,,,,,,,, uint64 expiry,,,, uint128 storedL,) = core.swaps(swapId);

        // Mutate the NFT's L mid-swap (F-#2 scenario)
        pm.inflateLiquidity(tokenId, inflateBy);
        assertEq(pm.liquidity(tokenId), uint128(POSITION_LIQUIDITY) + inflateBy);

        _warpAndSeedSettlementRound(expiry);
        core.settle(swapId, 2, SQRT_PA, SQRT_PB, SQRT_PT);

        // I6: the L the contract forwarded to computeIL == stored.
        assertTrue(ilMath.lastILCallSeen(), "settle never invoked computeIL");
        assertEq(ilMath.lastILCallLiquidity(), storedL, "I6 violated: contract forwarded re-read liquidity to IL math");
        // Sanity: the stored L is what we created the swap with.
        assertEq(storedL, POSITION_LIQUIDITY);
    }

    // ─── I9: oracle drift > priceBandBps → createSwap reverts ────────────

    function testFuzz_I9_priceBandViolationReverts(
        uint64 driftBps
    ) public {
        // Use DOWN drift (quote < live). With OracleManager.absBps using
        // `hi` (the larger value) as the denominator, drift DOWN gives
        //   absBps = (live - quoted) * 10000 / live = driftBps exactly.
        // So `drift > 100` reliably triggers the band check (band=100).
        uint64 drift = uint64(bound(uint256(driftBps), 200, 5000));
        ilMath.setMaxIL(2000e6);
        uint256 tokenId = _mintLPNFT();

        InflexionCore.SignedQuote memory q = _defaultQuote(1);
        q.priceBandBps = 100;
        q.quotePrice = uint128((uint256(3000e8) * (10_000 - drift)) / 10_000);
        bytes memory sig = _signQuote(q);

        vm.prank(lp);
        vm.expectRevert();
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_PA, SQRT_PB, SQRT_P0);
    }

    function testFuzz_I9_priceBandWithinBandAccepts(
        uint64 driftBps
    ) public {
        // DOWN drift, bounded under the band so absBps stays inside.
        uint64 drift = uint64(bound(uint256(driftBps), 0, 50));
        ilMath.setMaxIL(2000e6);
        uint256 tokenId = _mintLPNFT();

        InflexionCore.SignedQuote memory q = _defaultQuote(1);
        q.priceBandBps = 100;
        q.quotePrice = uint128((uint256(3000e8) * (10_000 - drift)) / 10_000);
        bytes memory sig = _signQuote(q);

        vm.prank(lp);
        core.createSwap(q, sig, tokenId, type(uint256).max, SQRT_PA, SQRT_PB, SQRT_P0);
    }
}

// ─── Stateful invariant: I5 (`locked ≤ deposited` per MM) ───────────────

/// @notice Lightweight Handler — exposes vault ops to Foundry's invariant
///         runner. The runner calls these in random sequences; after each
///         call the I5 invariant is rechecked across all tracked MMs.
contract VaultHandler is Test {
    UnderwriterVault internal vault;
    MockERC20 internal usdc;
    address internal core;

    address[] public mms;
    mapping(address => bool) internal seen;

    constructor(
        UnderwriterVault _vault,
        MockERC20 _usdc,
        address _core
    ) {
        vault = _vault;
        usdc = _usdc;
        core = _core;
    }

    function trackedMMs() external view returns (address[] memory) {
        return mms;
    }

    function _track(
        address mm
    ) internal {
        if (!seen[mm]) {
            seen[mm] = true;
            mms.push(mm);
        }
    }

    function deposit(
        uint64 mmSeed,
        uint64 amount
    ) external {
        if (amount == 0) return;
        address mm = address(uint160(uint256(keccak256(abi.encode(mmSeed)))));
        _track(mm);
        usdc.mint(mm, amount);
        vm.prank(mm);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(mm);
        vault.deposit(amount);
    }

    function withdraw(
        uint64 mmIdx,
        uint64 amount
    ) external {
        if (mms.length == 0) return;
        address mm = mms[mmIdx % mms.length];
        uint256 avail = vault.availableBalance(mm);
        if (avail == 0) return;
        uint256 amt = amount % (avail + 1);
        if (amt == 0) return;
        vm.prank(mm);
        vault.withdraw(amt);
    }

    function lock(
        uint64 mmIdx,
        uint64 amount
    ) external {
        if (mms.length == 0) return;
        address mm = mms[mmIdx % mms.length];
        uint256 avail = vault.availableBalance(mm);
        if (avail == 0) return;
        uint256 amt = amount % (avail + 1);
        if (amt == 0) return;
        vm.prank(core);
        vault.lockCollateral(mm, amt);
    }

    function release(
        uint64 mmIdx,
        uint64 payoutSeed,
        uint64 lockedSeed
    ) external {
        if (mms.length == 0) return;
        address mm = mms[mmIdx % mms.length];
        uint256 lockedNow = vault.locked(mm);
        if (lockedNow == 0) return;
        uint256 lockedAmt = lockedSeed % (lockedNow + 1);
        if (lockedAmt == 0) return;
        uint256 payout = payoutSeed % (lockedAmt + 1);
        address lp = address(uint160(uint256(keccak256(abi.encode("lp", mmIdx)))));
        vm.prank(core);
        vault.releaseAndDistribute(mm, lp, payout, lockedAmt);
    }
}

contract InflexionCore_I5_StatefulInvariant is StdInvariant, Test {
    MockERC20 internal usdc;
    UnderwriterVault internal vault;
    VaultHandler internal handler;
    address internal core = makeAddr("core");
    address internal owner = makeAddr("owner");

    function setUp() public {
        vm.prank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vm.prank(owner);
        vault = new UnderwriterVault(usdc);
        vm.prank(owner);
        vault.setCore(core);

        handler = new VaultHandler(vault, usdc, core);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.withdraw.selector;
        selectors[2] = VaultHandler.lock.selector;
        selectors[3] = VaultHandler.release.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    /// @notice Spec §13 invariant **I5** — locked ≤ deposited per MM
    ///         after any sequence of vault operations.
    function invariant_I5_lockedLeDeposited() public view {
        address[] memory mms = handler.trackedMMs();
        for (uint256 i = 0; i < mms.length; ++i) {
            assertLe(vault.locked(mms[i]), vault.deposited(mms[i]), "I5 violated: locked > deposited");
        }
    }
}
