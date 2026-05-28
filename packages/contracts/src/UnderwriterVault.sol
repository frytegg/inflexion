// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  UnderwriterVault — pooled MM collateral with `deposited` / `locked` accounting
/// @notice One pool per MM. Collateral is auto-pulled from the MM at match
///         time (`lockCollateral`, called by Inflexion Core), held until
///         settlement, then distributed to the LP and the MM by
///         `releaseAndDistribute`. Spec §7.1.
/// @dev    Invariant **I5** (spec §13): `locked[mm] ≤ deposited[mm]` for
///         every `mm` at all times. The arithmetic preserves this by
///         construction:
///           * `lockCollateral` requires `availableBalance(mm) ≥ amount`,
///             i.e. `deposited - locked ≥ amount`, so post-lock
///             `locked' = locked + amount ≤ deposited`.
///           * `releaseAndDistribute` requires `payout ≤ locked_` and
///             `locked_ ≤ locked`, so `deposited' - locked' ≥ 0`.
contract UnderwriterVault is Ownable {
    using SafeERC20 for IERC20;

    /// @notice The USDC token (set at construction; not upgradable).
    IERC20 public immutable usdc;

    /// @notice `InflexionCore` — only address allowed to call
    ///         `lockCollateral` / `releaseAndDistribute`. Settable once
    ///         (post-deploy wiring), then frozen via `freezeCore`.
    address public core;
    bool public coreFrozen;

    /// @notice Total USDC each MM has deposited (principal in the vault).
    mapping(address => uint256) public deposited;

    /// @notice USDC committed to active swaps; not available for withdraw.
    mapping(address => uint256) public locked;

    /// @notice `CapitalLow` emits when `available < CAPITAL_LOW_BPS%` of
    ///         `deposited` after a lock (spec §7.1). Surfaces as an alert
    ///         in the MM dashboard.
    uint256 public constant CAPITAL_LOW_BPS = 2000; // 20% in basis points
    uint256 private constant _BPS = 10_000;

    // ─── Events
    // ───────────────────────────────────────────────────────────

    event Deposited(address indexed mm, uint256 amount);
    event Withdrawn(address indexed mm, uint256 amount);
    event CollateralLocked(address indexed mm, uint256 amount);
    event SettlementReleased(address indexed mm, address indexed lp, uint256 payout, uint256 unlocked);
    event CapitalLow(address indexed mm, uint256 available);
    event CoreSet(address indexed core);
    event CoreFrozen(address indexed core);

    // ─── Errors
    // ───────────────────────────────────────────────────────────

    error OnlyCore();
    error CoreAlreadyFrozen();
    error CoreNotSet();
    error InsufficientAvailable(address mm, uint256 requested, uint256 available);
    error InsufficientLocked(address mm, uint256 requested, uint256 lockedNow);
    error PayoutExceedsCollateral(uint256 payout, uint256 collateral);
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
        IERC20 _usdc
    ) Ownable(msg.sender) {
        if (address(_usdc) == address(0)) revert ZeroAddress();
        usdc = _usdc;
    }

    /// @notice Wire the Inflexion Core address. Callable once, until
    ///         `freezeCore` is invoked (then immutable).
    function setCore(
        address _core
    ) external onlyOwner {
        if (coreFrozen) revert CoreAlreadyFrozen();
        if (_core == address(0)) revert ZeroAddress();
        core = _core;
        emit CoreSet(_core);
    }

    /// @notice Freeze the `core` address so it can never be changed.
    ///         One-way switch; called once Inflexion Core is verified.
    function freezeCore() external onlyOwner {
        if (core == address(0)) revert CoreNotSet();
        coreFrozen = true;
        emit CoreFrozen(core);
    }

    // ─── Reads
    // ────────────────────────────────────────────────────────────

    /// @notice USDC the MM may still withdraw or commit (= `deposited - locked`).
    function availableBalance(
        address mm
    ) public view returns (uint256) {
        // I5 guarantees `deposited[mm] >= locked[mm]`, so this is safe.
        return deposited[mm] - locked[mm];
    }

    // ─── MM-facing writes
    // ────────────────────────────────────────────────

    /// @notice MM deposits USDC into their pool. Pulls via `transferFrom`.
    function deposit(
        uint256 amount
    ) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        deposited[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice MM withdraws available (non-locked) USDC from their pool.
    function withdraw(
        uint256 amount
    ) external {
        uint256 avail = availableBalance(msg.sender);
        if (avail < amount) {
            revert InsufficientAvailable(msg.sender, amount, avail);
        }
        unchecked {
            deposited[msg.sender] -= amount;
        }
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Core-facing writes (onlyCore)
    // ───────────────────────────────────

    /// @notice Inflexion Core locks `amount` of `mm`'s collateral when a
    ///         swap is matched. Reverts if available is insufficient.
    ///         Emits `CapitalLow` if post-lock available drops under 20%.
    function lockCollateral(
        address mm,
        uint256 amount
    ) external onlyCore {
        uint256 avail = availableBalance(mm);
        if (avail < amount) revert InsufficientAvailable(mm, amount, avail);
        locked[mm] += amount;
        emit CollateralLocked(mm, amount);
        _maybeEmitCapitalLow(mm);
    }

    /// @notice Settle a swap: `payout` is paid to `lp` from the MM's
    ///         pool, and `lockedAmount` is released back to available.
    ///         `payout` must not exceed the swap's collateral (`lockedAmount`).
    ///         For FULL mode (spec invariant **I1**): `payout ≤ MaxIL == lockedAmount`,
    ///         so this is always satisfiable.
    function releaseAndDistribute(
        address mm,
        address lp,
        uint256 payout,
        uint256 lockedAmount
    ) external onlyCore {
        if (payout > lockedAmount) {
            revert PayoutExceedsCollateral(payout, lockedAmount);
        }
        uint256 lockedNow = locked[mm];
        if (lockedNow < lockedAmount) {
            revert InsufficientLocked(mm, lockedAmount, lockedNow);
        }
        unchecked {
            // Both: (a) we just bounded payout ≤ lockedAmount, and (b) we
            // require lockedAmount ≤ locked[mm] ≤ deposited[mm] (I5).
            locked[mm] = lockedNow - lockedAmount;
            deposited[mm] -= payout;
        }
        if (payout > 0) usdc.safeTransfer(lp, payout);
        emit SettlementReleased(mm, lp, payout, lockedAmount);
    }

    // ─── Internal
    // ─────────────────────────────────────────────────────────

    function _maybeEmitCapitalLow(
        address mm
    ) internal {
        uint256 dep = deposited[mm];
        if (dep == 0) return; // pathological; nothing to compare against
        uint256 avail = availableBalance(mm);
        uint256 threshold = (dep * CAPITAL_LOW_BPS) / _BPS;
        if (avail < threshold) emit CapitalLow(mm, avail);
    }
}
