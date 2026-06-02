// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { FixedPointMathLib } from "solady/utils/FixedPointMathLib.sol";

import { Gaussian } from "./libraries/Gaussian.sol";
import { IFairValueOracle } from "./interfaces/IFairValueOracle.sol";
import { IVolOracle } from "./interfaces/IVolOracle.sol";

/// @title  FairValueOracle — on-chain exact closed-form fair value (Pillar 1, P2.2)
/// @notice `fairRate = E_Q[min(IL, MaxIL)] / MaxIL` as the EXACT finite Φ-sum over
///         the piecewise v3 capped payoff, computed live from `(a=Pa/P0, b=Pb/P0,
///         σ_ref, T)`. `FairPremium = fairRate · MaxIL`. Mirrors the verified
///         Python closed form `inflexion_quant.cvamm.fair_rate`.
/// @dev    The payoff `min(IL, MaxIL)` is piecewise in the terminal price:
///         **below** Pa (linear, slope<0, capped for P<PcapL), **inside** [Pa,Pb]
///         (`c1·P − 2√P + c0`, convex, never capped), **above** Pb (linear,
///         slope>0, capped for P>PcapR). Each arm integrated against the
///         lognormal density is a sum of interval moments
///         `M_p(K1,K2) = E[P^p·1{K1<P<K2}] = pref_p·(Φ(d_p(K1)) − Φ(d_p(K2)))`
///         with `p ∈ {0, ½, 1}`. Everything runs in **normalised** units
///         (`P0 = 1`, `L = 1`) so values are O(1) — `fairRate` is L-independent
///         (IL and MaxIL both scale with L). The only approximation is `Φ`
///         (Abramowitz–Stegun, ~1e-7); the GBM `r = 0` assumption is covered by
///         the conservative `σ_ref`. Settle / MaxIL / I1–I9 are untouched — this
///         is upstream of settle (Pillar 1 pricing input).
///
///         **Latent sub-task (personal machine w/ Stylus + Nitro):** the Rust
///         Stylus port + the Stylus-vs-Solidity gas+accuracy benchmark + the
///         ship decision (cheaper impl meeting the bar; the other as the CI
///         cross-check oracle). See `docs/STYLUS_FAIRVALUE_BENCHMARK.md`.
contract FairValueOracle is IFairValueOracle {
    using FixedPointMathLib for int256;
    using FixedPointMathLib for uint256;
    using Gaussian for int256;

    int256 internal constant WAD_I = 1e18;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SECONDS_PER_YEAR = 365 days; // 365-day year (matches il.py)
    uint256 internal constant INF = type(uint256).max; // K = +∞ sentinel (Φ → 0)

    IVolOracle public immutable vol;

    constructor(
        IVolOracle _vol
    ) {
        require(address(_vol) != address(0), "FVO: vol=0");
        vol = _vol;
    }

    /// @inheritdoc IFairValueOracle
    function volOracle() external view returns (address) {
        return address(vol);
    }

    /// @inheritdoc IFairValueOracle
    function fairRateFromPrices(
        uint256 P0,
        uint256 Pa,
        uint256 Pb,
        uint256 sigmaWad,
        uint256 durationSeconds
    ) public pure returns (uint256) {
        require(P0 > 0, "FVO: P0=0");
        return fairRate(Pa.divWad(P0), Pb.divWad(P0), sigmaWad, durationSeconds);
    }

    /// @inheritdoc IFairValueOracle
    function fairPremium(
        address token,
        uint256 aWad,
        uint256 bWad,
        uint256 durationSeconds,
        uint256 maxIL
    ) external view returns (uint256 premium, uint256 fairRateWad, uint256 sigmaRefWad) {
        sigmaRefWad = vol.sigmaRef(token);
        fairRateWad = fairRate(aWad, bWad, sigmaRefWad, durationSeconds);
        premium = maxIL.mulWad(fairRateWad);
    }

    // ─── The exact Φ-sum
    // ──────────────────────────────────────────────────

    /// @inheritdoc IFairValueOracle
    function fairRate(
        uint256 a,
        uint256 b,
        uint256 sigma,
        uint256 durationSeconds
    ) public pure returns (uint256) {
        require(a < WAD && b > WAD, "FVO: need Pa<P0<Pb"); // in-range gate
        require(sigma > 0 && durationSeconds > 0, "FVO: sigma/T=0");

        // σ√T, σ²T, half = σ²T/2, prefH = exp(−σ²T/8).
        uint256 T = durationSeconds.fullMulDiv(WAD, SECONDS_PER_YEAR); // years (WAD)
        uint256 sst = sigma.mulWad(FixedPointMathLib.sqrtWad(T));
        require(sst > 0, "FVO: sst=0");
        uint256 s2t = sst.mulWad(sst);
        int256 half = int256(s2t / 2);
        int256 prefH = FixedPointMathLib.expWad(-int256(s2t / 8));

        uint256 sa = FixedPointMathLib.sqrtWad(a); // √a
        uint256 sb = FixedPointMathLib.sqrtWad(b); // √b

        // Entry amounts (normalised P0=1, L=1): amt0 = 1 − 1/√b, amt1 = 1 − √a.
        int256 amt0 = WAD_I - int256(WAD.divWad(sb));
        int256 amt1 = WAD_I - int256(sa);

        // MaxIL = max(IL(Pa), IL(Pb)).
        int256 ilA = amt0.sMulWad(int256(a)) + amt1 - int256(sa) + int256(a.divWad(sb));
        int256 ilB = amt0.sMulWad(int256(b)) + amt1 - int256(sb) + int256(sa);
        if (ilA < 0) ilA = 0;
        if (ilB < 0) ilB = 0;
        int256 maxIl = ilA > ilB ? ilA : ilB;
        require(maxIl > 0, "FVO: MaxIL=0");

        // Arm coefficients.
        int256 a1b = amt0 - int256(WAD.divWad(sa)) + int256(WAD.divWad(sb)); // below slope (<0)
        int256 a0b = amt1; // below intercept
        int256 c1 = amt0 + int256(WAD.divWad(sb)); // inside: c1·P − 2√P + c0
        int256 c0 = amt1 + int256(sa);
        int256 a1a = amt0; // above slope (>0)
        int256 a0a = amt1 - (int256(sb) - int256(sa)); // above intercept

        // Cap-crossing prices, clamped: below caps on (0, PcapL); above on (PcapR, ∞).
        uint256 pcapL;
        {
            int256 pL = (maxIl - a0b).sDivWad(a1b); // a1b < 0
            pcapL = pL > 0 ? uint256(pL) : 0;
        }
        uint256 pcapR;
        {
            int256 pR = (maxIl - a0a).sDivWad(a1a); // a1a > 0
            pcapR = pR > int256(b) ? uint256(pR) : b;
        }

        // ── below arm (0, Pa): MaxIL·M0(0,PcapL) + a1b·M1(PcapL,Pa) + a0b·M0(PcapL,Pa)
        int256 below = maxIl.sMulWad(_m0(0, pcapL, sst, half)) + a1b.sMulWad(_m1(pcapL, a, sst, half))
            + a0b.sMulWad(_m0(pcapL, a, sst, half));

        // ── inside arm (Pa, Pb): c1·M1 − 2·Mh + c0·M0  (L = 1)
        int256 inside = c1.sMulWad(_m1(a, b, sst, half)) - 2 * _mh(a, b, sst, prefH) + c0.sMulWad(_m0(a, b, sst, half));

        // ── above arm (Pb, ∞): a1a·M1(Pb,PcapR) + a0a·M0(Pb,PcapR) + MaxIL·M0(PcapR,∞)
        int256 above = a1a.sMulWad(_m1(b, pcapR, sst, half)) + a0a.sMulWad(_m0(b, pcapR, sst, half))
            + maxIl.sMulWad(_m0(pcapR, INF, sst, half));

        int256 fr = (below + inside + above).sDivWad(maxIl);
        return fr < 0 ? 0 : uint256(fr);
    }

    // ─── Interval moments E[P^p · 1{K1<P<K2}] (normalised P0=1), WAD ───────

    /// @dev `M0(K1,K2) = Φ(d0(K1)) − Φ(d0(K2))`, d0 uses cTerm = −half.
    function _m0(
        uint256 k1,
        uint256 k2,
        uint256 sst,
        int256 half
    ) private pure returns (int256) {
        return _cdfD(k1, -half, sst) - _cdfD(k2, -half, sst);
    }

    /// @dev `M1(K1,K2) = Φ(d1(K1)) − Φ(d1(K2))`, d1 uses cTerm = +half (pref=1).
    function _m1(
        uint256 k1,
        uint256 k2,
        uint256 sst,
        int256 half
    ) private pure returns (int256) {
        return _cdfD(k1, half, sst) - _cdfD(k2, half, sst);
    }

    /// @dev `Mh(K1,K2) = exp(−σ²T/8)·(Φ(dh(K1)) − Φ(dh(K2)))`, dh uses cTerm = 0.
    function _mh(
        uint256 k1,
        uint256 k2,
        uint256 sst,
        int256 prefH
    ) private pure returns (int256) {
        return prefH.sMulWad(_cdfD(k1, 0, sst) - _cdfD(k2, 0, sst));
    }

    /// @dev `Φ(d)` with `d = (−ln(K) + cTerm)/sst`. `K = 0 ⇒ d = +∞ ⇒ Φ = 1`;
    ///      `K = ∞ ⇒ d = −∞ ⇒ Φ = 0`.
    function _cdfD(
        uint256 K,
        int256 cTerm,
        uint256 sst
    ) private pure returns (int256) {
        if (K == 0) return WAD_I; // Φ(+∞)
        if (K == INF) return 0; // Φ(−∞)
        int256 num = -FixedPointMathLib.lnWad(int256(K)) + cTerm;
        int256 d = num.sDivWad(int256(sst));
        return int256(Gaussian.stdNormalCdf(d));
    }
}
