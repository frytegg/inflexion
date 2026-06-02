// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FixedPointMathLib } from "solady/utils/FixedPointMathLib.sol";

import { IOracleManager } from "./interfaces/IOracleManager.sol";
import { IVolOracle } from "./interfaces/IVolOracle.sol";

/// @title  VolOracle — conservative σ-EWMA reference volatility (cvAMM Pillar 1, P2.1)
/// @notice On-chain `sigma_ref = max(sigma_short, sigma_long, floor)`, a
///         **time-aware** EWMA of Chainlink log-returns. Each `poke` folds the
///         latest `OracleManager.getPrice` into a short- and long-halflife EWMA
///         of per-second variance; `sigmaRef` annualises and takes the
///         conservative max with a hard floor. Mirrors the Python reference
///         `inflexion_quant.prices.sigma_ref` (P1 deliverable 2).
/// @dev    **Solvency-load-bearing for the I10 cap + depositor solvency, NOT for
///         the FULL no-bad-debt invariant (I1)** — that is structural and
///         oracle-independent (spec §6.5). The two windows + floor are injected
///         at construction from `quant/params.json` (cvAMM block) — **no vol
///         primitive is hardcoded** (CLAUDE.md inv. 6). Deribit DVOL is optional
///         published enrichment only; this oracle never depends on it.
///
///         **Why poke-based:** Chainlink rounds are irregular and reading deep
///         history on every quote is gas-prohibitive. A permissionless `poke`
///         (keeper, or folded into `createSwap`) maintains an O(1) EWMA. `dt` is
///         clamped to `[minSampleInterval, maxSampleInterval]` so a single huge
///         gap can neither divide-by-tiny-dt nor over-weight one sample.
contract VolOracle is IVolOracle {
    using FixedPointMathLib for int256;
    using FixedPointMathLib for uint256;

    // ─── Constants
    // ────────────────────────────────────────────────────────
    uint256 internal constant WAD = 1e18;
    uint256 internal constant LN2_WAD = 693_147_180_559_945_309; // ln(2) · 1e18
    /// @dev 365-day year, matching the Python model's `DAYS_PER_YEAR = 365`.
    uint256 internal constant SECONDS_PER_YEAR = 365 days; // 31_536_000

    // ─── Immutable config (from params.json cvAMM block at deploy) ─────────
    IOracleManager public immutable oracle;
    uint32 public immutable shortHalflife; // seconds
    uint32 public immutable longHalflife; // seconds
    uint256 public immutable floorWad; // annualised σ floor (WAD)
    uint32 public immutable minSampleInterval; // seconds; samples sooner are ignored
    uint32 public immutable maxSampleInterval; // seconds; dt is clamped to this

    // ─── Per-token EWMA state
    // ─────────────────────────────────────────────
    struct State {
        bool initialized;
        uint64 lastTs;
        uint256 lastPriceWad;
        uint256 varShortWad; // per-second variance, short window (WAD)
        uint256 varLongWad; // per-second variance, long window (WAD)
    }

    mapping(address => State) private _state;

    constructor(
        IOracleManager _oracle,
        uint32 _shortHalflife,
        uint32 _longHalflife,
        uint256 _floorWad,
        uint32 _minSampleInterval,
        uint32 _maxSampleInterval
    ) {
        require(address(_oracle) != address(0), "VolOracle: oracle=0");
        require(_shortHalflife > 0 && _longHalflife > 0, "VolOracle: halflife=0");
        require(_longHalflife >= _shortHalflife, "VolOracle: long<short");
        require(_floorWad > 0, "VolOracle: floor=0");
        require(_minSampleInterval > 0 && _maxSampleInterval >= _minSampleInterval, "VolOracle: bad interval");
        oracle = _oracle;
        shortHalflife = _shortHalflife;
        longHalflife = _longHalflife;
        floorWad = _floorWad;
        minSampleInterval = _minSampleInterval;
        maxSampleInterval = _maxSampleInterval;
    }

    // ─── Mutating
    // ─────────────────────────────────────────────────────────

    /// @inheritdoc IVolOracle
    function poke(
        address token
    ) external returns (uint256 sigmaRefWad) {
        uint256 priceWad = _priceWad(token);
        State storage s = _state[token];

        if (!s.initialized) {
            // Seed both windows at the floor so the first reads are conservative.
            uint256 seed = _floorPerSecVar();
            s.initialized = true;
            s.lastTs = uint64(block.timestamp);
            s.lastPriceWad = priceWad;
            s.varShortWad = seed;
            s.varLongWad = seed;
            emit Initialized(token, priceWad, floorWad);
            return _sigmaRef(s);
        }

        uint256 dt = block.timestamp - s.lastTs;
        if (dt < minSampleInterval) {
            // Too soon — do not let micro-samples blow up r²/dt. No-op (safe to
            // call from createSwap). State unchanged; report the current value.
            return _sigmaRef(s);
        }
        uint256 dtClamped = dt > maxSampleInterval ? maxSampleInterval : dt;

        // Log-return r = ln(price / lastPrice), WAD-signed.
        int256 r = FixedPointMathLib.lnWad(int256(FixedPointMathLib.divWad(priceWad, s.lastPriceWad)));
        uint256 rAbs = r < 0 ? uint256(-r) : uint256(r);
        uint256 r2 = rAbs.mulWad(rAbs); // r² (WAD)
        uint256 vSample = r2 / dtClamped; // per-second variance (WAD)

        s.varShortWad = _ewma(s.varShortWad, vSample, dtClamped, shortHalflife);
        s.varLongWad = _ewma(s.varLongWad, vSample, dtClamped, longHalflife);
        s.lastTs = uint64(block.timestamp);
        s.lastPriceWad = priceWad;

        sigmaRefWad = _sigmaRef(s);
        emit Poked(token, priceWad, dt, _annualisedSigma(s.varShortWad), _annualisedSigma(s.varLongWad));
    }

    // ─── Views
    // ────────────────────────────────────────────────────────────

    /// @inheritdoc IVolOracle
    function sigmaRef(
        address token
    ) external view returns (uint256) {
        State storage s = _state[token];
        require(s.initialized, "VolOracle: not initialized");
        return _sigmaRef(s);
    }

    /// @inheritdoc IVolOracle
    function sigmaComponents(
        address token
    ) external view returns (uint256 sigmaShortWad, uint256 sigmaLongWad, uint256 floorWad_, uint8 binding) {
        State storage s = _state[token];
        require(s.initialized, "VolOracle: not initialized");
        sigmaShortWad = _annualisedSigma(s.varShortWad);
        sigmaLongWad = _annualisedSigma(s.varLongWad);
        floorWad_ = floorWad;
        uint256 m = sigmaShortWad;
        binding = 0;
        if (sigmaLongWad > m) {
            m = sigmaLongWad;
            binding = 1;
        }
        if (floorWad > m) {
            binding = 2;
        }
    }

    /// @inheritdoc IVolOracle
    function isInitialized(
        address token
    ) external view returns (bool) {
        return _state[token].initialized;
    }

    // ─── Internal
    // ─────────────────────────────────────────────────────────

    /// @dev Time-aware EWMA update: `λ = 0.5^(dt/halflife) = exp(-dt·ln2/hl)`,
    ///      `new = λ·old + (1−λ)·sample`. All WAD.
    function _ewma(
        uint256 oldVar,
        uint256 sample,
        uint256 dt,
        uint32 halflife
    ) internal pure returns (uint256) {
        // exponent = dt·ln2/halflife (WAD); λ = exp(−exponent) ∈ (0, 1].
        uint256 exponent = (dt * LN2_WAD) / halflife;
        uint256 lambda = uint256(FixedPointMathLib.expWad(-int256(exponent)));
        if (lambda > WAD) lambda = WAD; // numerical guard
        return lambda.mulWad(oldVar) + (WAD - lambda).mulWad(sample);
    }

    /// @dev Annualise a per-second variance and take the WAD square root → σ.
    function _annualisedSigma(
        uint256 varPerSecWad
    ) internal pure returns (uint256) {
        return FixedPointMathLib.sqrtWad(varPerSecWad * SECONDS_PER_YEAR);
    }

    /// @dev `max(sigma_short, sigma_long, floor)` — the conservative guard.
    function _sigmaRef(
        State storage s
    ) internal view returns (uint256) {
        uint256 ss = _annualisedSigma(s.varShortWad);
        uint256 sl = _annualisedSigma(s.varLongWad);
        uint256 m = ss > sl ? ss : sl;
        return m > floorWad ? m : floorWad;
    }

    /// @dev Per-second variance corresponding to the annualised σ floor.
    function _floorPerSecVar() internal view returns (uint256) {
        uint256 annualVar = floorWad.mulWad(floorWad); // floor² (WAD)
        return annualVar / SECONDS_PER_YEAR;
    }

    /// @dev Latest Chainlink price for `token`, normalised to WAD (1e18 = $1).
    function _priceWad(
        address token
    ) internal view returns (uint256) {
        uint256 ans = oracle.getPrice(token); // in feed decimals
        uint8 dec = oracle.feedDecimals(token);
        if (dec == 18) return ans;
        if (dec < 18) return ans * (10 ** (18 - dec));
        return ans / (10 ** (dec - 18));
    }
}
