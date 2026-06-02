// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IConvexityVault } from "./interfaces/IConvexityVault.sol";

/// @title  ConvexityVault — pooled passive cvAMM underwriter, dual-tranche (P3.1 + P3.1b)
/// @notice The cvAMM centrepiece (Pillar 2, Path A): ONE pool per pair underwrites
///         all 9 marketIds (collateral fungible across them). Depositors choose a
///         tranche — **SENIOR** (protected, base-yield + a small premium slice) or
///         **JUNIOR** (first-loss, captures most of the premium, high-APY). FULL:
///         per-swap collateral == MaxIL, so payout ≤ collateral (no bad debt, I1).
/// @dev    **Structural senior protection (the key invariant):**
///         `totalLocked ≤ juniorAssets` is enforced at every `lockCollateral`.
///         Since every payout ≤ its MaxIL = its locked amount, total payouts ≤
///         totalLocked ≤ juniorAssets, so the junior-first loss waterfall absorbs
///         **all underwriting loss** before senior is ever touched — and the
///         invariant is preserved by settlement (a payout p ≤ MaxIL m unlocks m
///         from `locked` while taking p from `junior`, and m − p ≥ 0). This is the
///         code form of the ROADMAP's "enforce u ≤ 1−sf", made adaptive to the
///         ACTUAL junior buffer (safer than a fixed ratio). `sf = 0.60` (P1.13) is
///         the TARGET tranche ratio for UX/incentives, not the hard cap.
///
///         **CAPITAL NOT GUARANTEED.** Senior is structurally protected from
///         *underwriting* loss only — NOT from systemic failure (USDC depeg,
///         oracle/settlement failure, contract bug). Two never-merged claims:
///         (1) LPs are always paid (no bad debt, FULL, I1, qualified);
///         (2) depositors can lose principal (esp. junior; senior in a systemic tail).
///
///         **Run defense:** withdrawals are cooldown-gated and junior cannot be
///         withdrawn below `totalLocked` — the same locked/free accounting that
///         prices `util_skew` up before over-commitment.
///
///         All economic params (cooldown, senior premium slice) are injected from
///         `quant/params.json` (cvAMM block) — no primitive hardcoded.
contract ConvexityVault is IConvexityVault, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    IERC20 public immutable usdc;
    /// @notice Seconds a withdrawal request must age before it can be claimed.
    uint256 public immutable withdrawalCooldown;
    /// @notice Senior's share of each accrued premium, in bps (the rest → junior).
    ///         Small, so senior is a low-yield "savings account" and junior the
    ///         high-APY vol tranche. From params.json (cvAMM block).
    uint256 public immutable seniorPremiumShareBps;

    // ─── Core wiring (one-way freeze, mirrors UnderwriterVault) ────────────
    address public core;
    bool public coreFrozen;

    // ─── Tranche accounting (USDC value + internal shares per tranche) ─────
    uint256 public seniorAssets;
    uint256 public juniorAssets;
    uint256 public seniorShares;
    uint256 public juniorShares;
    mapping(address => uint256) public seniorBalanceOf;
    mapping(address => uint256) public juniorBalanceOf;

    // ─── Collateral accounting
    // ────────────────────────────────────────────
    uint256 public totalLocked;
    mapping(bytes32 => uint256) public lockedByMarket;
    /// @dev Σ lockedByMarket[m]² — incremental, for the O(1) HHI concentration.
    uint256 public sumLockedSq;

    // ─── Withdrawal queue (cooldown)
    // ──────────────────────────────────────
    struct WithdrawRequest {
        uint256 shares;
        uint64 unlockAt;
    }

    mapping(address => WithdrawRequest) public seniorWithdraw;
    mapping(address => WithdrawRequest) public juniorWithdraw;

    // ─── Events
    // ───────────────────────────────────────────────────────────
    event Deposited(address indexed who, Tranche indexed tranche, uint256 assets, uint256 shares);
    event WithdrawRequested(address indexed who, Tranche indexed tranche, uint256 shares, uint64 unlockAt);
    event Withdrawn(address indexed who, Tranche indexed tranche, uint256 assets, uint256 shares);
    event PremiumAccrued(uint256 amount, uint256 toSenior, uint256 toJunior);
    event CollateralLocked(bytes32 indexed marketId, uint256 amount, uint256 totalLocked);
    event SettlementReleased(bytes32 indexed marketId, address indexed lp, uint256 payout, uint256 unlocked);
    event JuniorLoss(uint256 payout, uint256 juniorLoss, uint256 seniorLoss);
    event CoreSet(address indexed core);
    event CoreFrozen(address indexed core);

    // ─── Errors
    // ───────────────────────────────────────────────────────────
    error OnlyCore();
    error CoreAlreadyFrozen();
    error CoreNotSet();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientFree(uint256 requested, uint256 free);
    error SeniorProtectionBreached(uint256 lockedAfter, uint256 junior);
    error InsufficientShares(uint256 requested, uint256 held);
    error CooldownNotElapsed(uint64 unlockAt);
    error NoRequest();
    error JuniorBelowLocked(uint256 juniorAfter, uint256 locked);
    error PayoutExceedsCollateral(uint256 payout, uint256 lockedAmount);
    error MarketUnderLocked(uint256 requested, uint256 marketLocked);

    modifier onlyCore() {
        if (msg.sender != core) revert OnlyCore();
        _;
    }

    constructor(
        IERC20 _usdc,
        uint256 _withdrawalCooldown,
        uint256 _seniorPremiumShareBps
    ) Ownable(msg.sender) {
        if (address(_usdc) == address(0)) revert ZeroAddress();
        require(_seniorPremiumShareBps <= BPS, "CV: slice>100%");
        usdc = _usdc;
        withdrawalCooldown = _withdrawalCooldown;
        seniorPremiumShareBps = _seniorPremiumShareBps;
    }

    // ─── Core wiring
    // ──────────────────────────────────────────────────────
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

    // ─── Views
    // ────────────────────────────────────────────────────────────

    function totalAssets() public view returns (uint256) {
        return seniorAssets + juniorAssets;
    }

    function freeAssets() public view returns (uint256) {
        return totalAssets() - totalLocked; // totalLocked ≤ junior ≤ total (invariant)
    }

    function utilizationWad() public view returns (uint256) {
        uint256 t = totalAssets();
        return t == 0 ? 0 : (totalLocked * WAD) / t;
    }

    /// @notice Normalised Herfindahl of per-market locked coverage, WAD.
    ///         `HHI = Σ lockedByMarket² / totalLocked²` ∈ [1/n, 1]; 1 = all in one
    ///         market (max concentration), low = dispersed. Feeds `dispersion_skew`.
    function concentrationWad() public view returns (uint256) {
        if (totalLocked == 0) return 0;
        return (sumLockedSq * WAD) / (totalLocked * totalLocked);
    }

    /// @inheritdoc IConvexityVault
    function inventory()
        external
        view
        returns (uint256 total, uint256 locked, uint256 free, uint256 util, uint256 conc)
    {
        total = totalAssets();
        locked = totalLocked;
        free = total - locked;
        util = total == 0 ? 0 : (locked * WAD) / total;
        conc = concentrationWad();
    }

    /// @notice USDC value of `shares` in a tranche (NAV per share).
    function convertToAssets(
        Tranche tranche,
        uint256 shares
    ) public view returns (uint256) {
        (uint256 a, uint256 s) = _trancheState(tranche);
        return s == 0 ? 0 : (shares * a) / s;
    }

    function convertToShares(
        Tranche tranche,
        uint256 assets
    ) public view returns (uint256) {
        (uint256 a, uint256 s) = _trancheState(tranche);
        return (s == 0 || a == 0) ? assets : (assets * s) / a;
    }

    // ─── Depositor flow
    // ───────────────────────────────────────────────────

    function deposit(
        Tranche tranche,
        uint256 amount
    ) external returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        shares = convertToShares(tranche, amount);
        if (tranche == Tranche.SENIOR) {
            seniorAssets += amount;
            seniorShares += shares;
            seniorBalanceOf[msg.sender] += shares;
        } else {
            juniorAssets += amount;
            juniorShares += shares;
            juniorBalanceOf[msg.sender] += shares;
        }
        emit Deposited(msg.sender, tranche, amount, shares);
    }

    /// @notice Queue a withdrawal of `shares` from `tranche`; claimable after the
    ///         cooldown. Overwrites any prior pending request for that tranche.
    function requestWithdrawal(
        Tranche tranche,
        uint256 shares
    ) external {
        uint256 held = tranche == Tranche.SENIOR ? seniorBalanceOf[msg.sender] : juniorBalanceOf[msg.sender];
        if (shares == 0) revert ZeroAmount();
        if (shares > held) revert InsufficientShares(shares, held);
        uint64 unlockAt = uint64(block.timestamp + withdrawalCooldown);
        if (tranche == Tranche.SENIOR) {
            seniorWithdraw[msg.sender] = WithdrawRequest(shares, unlockAt);
        } else {
            juniorWithdraw[msg.sender] = WithdrawRequest(shares, unlockAt);
        }
        emit WithdrawRequested(msg.sender, tranche, shares, unlockAt);
    }

    /// @notice Claim a matured withdrawal. JUNIOR cannot be drawn below
    ///         `totalLocked` (would break senior protection / over-commit).
    function withdraw(
        Tranche tranche
    ) external returns (uint256 assets) {
        WithdrawRequest memory r = tranche == Tranche.SENIOR ? seniorWithdraw[msg.sender] : juniorWithdraw[msg.sender];
        if (r.shares == 0) revert NoRequest();
        if (block.timestamp < r.unlockAt) revert CooldownNotElapsed(r.unlockAt);

        uint256 held = tranche == Tranche.SENIOR ? seniorBalanceOf[msg.sender] : juniorBalanceOf[msg.sender];
        uint256 shares = r.shares > held ? held : r.shares; // tolerate balance drift
        assets = convertToAssets(tranche, shares);

        if (tranche == Tranche.SENIOR) {
            seniorBalanceOf[msg.sender] = held - shares;
            seniorShares -= shares;
            seniorAssets -= assets;
            delete seniorWithdraw[msg.sender];
        } else {
            if (juniorAssets - assets < totalLocked) revert JuniorBelowLocked(juniorAssets - assets, totalLocked);
            juniorBalanceOf[msg.sender] = held - shares;
            juniorShares -= shares;
            juniorAssets -= assets;
            delete juniorWithdraw[msg.sender];
        }
        usdc.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, tranche, assets, shares);
    }

    // ─── Core-facing
    // ──────────────────────────────────────────────────────

    /// @inheritdoc IConvexityVault
    function accruePremium(
        uint256 amount
    ) external onlyCore {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 toSenior = (amount * seniorPremiumShareBps) / BPS;
        uint256 toJunior = amount - toSenior;
        seniorAssets += toSenior;
        juniorAssets += toJunior;
        emit PremiumAccrued(amount, toSenior, toJunior);
    }

    /// @inheritdoc IConvexityVault
    function lockCollateral(
        bytes32 marketId,
        uint256 amount
    ) external onlyCore {
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeAssets();
        if (free < amount) revert InsufficientFree(amount, free);
        uint256 lockedAfter = totalLocked + amount;
        // STRUCTURAL SENIOR PROTECTION: junior must cover the entire locked book.
        if (lockedAfter > juniorAssets) revert SeniorProtectionBreached(lockedAfter, juniorAssets);

        uint256 x = lockedByMarket[marketId];
        sumLockedSq += amount * amount + 2 * x * amount; // (x+amt)² − x²
        lockedByMarket[marketId] = x + amount;
        totalLocked = lockedAfter;
        emit CollateralLocked(marketId, amount, lockedAfter);
    }

    /// @inheritdoc IConvexityVault
    function releaseAndDistribute(
        bytes32 marketId,
        address lp,
        uint256 payout,
        uint256 lockedAmount
    ) external onlyCore {
        if (payout > lockedAmount) revert PayoutExceedsCollateral(payout, lockedAmount);
        uint256 mLocked = lockedByMarket[marketId];
        if (lockedAmount > mLocked) revert MarketUnderLocked(lockedAmount, mLocked);

        // Unlock the collateral (concentration accumulator stays consistent).
        sumLockedSq -= 2 * mLocked * lockedAmount - lockedAmount * lockedAmount; // x² − (x−amt)²
        lockedByMarket[marketId] = mLocked - lockedAmount;
        totalLocked -= lockedAmount;

        // Apply the payout loss junior-first. By the invariant payout ≤ locked ≤
        // junior, so junior absorbs it fully and senior is untouched — the `min`
        // is defense-in-depth.
        if (payout > 0) {
            uint256 juniorLoss = payout <= juniorAssets ? payout : juniorAssets;
            uint256 seniorLoss = payout - juniorLoss;
            juniorAssets -= juniorLoss;
            seniorAssets -= seniorLoss;
            usdc.safeTransfer(lp, payout);
            emit JuniorLoss(payout, juniorLoss, seniorLoss);
        }
        emit SettlementReleased(marketId, lp, payout, lockedAmount);
    }

    // ─── Internal
    // ─────────────────────────────────────────────────────────

    function _trancheState(
        Tranche tranche
    ) private view returns (uint256 assets, uint256 shares) {
        if (tranche == Tranche.SENIOR) return (seniorAssets, seniorShares);
        return (juniorAssets, juniorShares);
    }
}
