// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  IFairValueOracle — on-chain published fair value of the IL claim (Pillar 1)
/// @notice Publishes `FairPremium = fairRate · MaxIL`, where `fairRate =
///         E_Q[min(IL, MaxIL)] / MaxIL` is the **exact** risk-neutral closed form
///         (a finite Φ-sum over the piecewise v3 payoff — NOT a lookup table,
///         NOT the straddle-theta / Lipton continuum, NO fitted coefficients).
///         `σ_ref` is the only stochastic input (read from the VolOracle).
/// @dev    `fairRate` is **L-independent** — IL and MaxIL both scale with the
///         position's liquidity, so it cancels and the rate depends only on the
///         geometry ratios `a = Pa/P0`, `b = Pb/P0`, plus `σ_ref` and `T`. The
///         numéraire is **token1** (USDC) and the measure is risk-neutral GBM
///         (`μ = 0, r = 0`), matching `quant/il.py`. Verified ≡ the Python closed
///         form (`inflexion_quant.cvamm.fair_rate`) to a stated tolerance (P2.2).
interface IFairValueOracle {
    /// @notice `fairRate` (WAD, ∈ (0,1]) for normalised geometry `a = Pa/P0`,
    ///         `b = Pb/P0` (both WAD), annualised `sigma` (WAD), `durationSeconds`.
    /// @dev    Pure — the exact Φ-sum. Reverts unless `a < 1e18 < b` (in-range:
    ///         `Pa < P0 < Pb`).
    function fairRate(
        uint256 aWad,
        uint256 bWad,
        uint256 sigmaWad,
        uint256 durationSeconds
    ) external pure returns (uint256 fairRateWad);

    /// @notice `fairRate` from raw prices (same scale for `P0`, `Pa`, `Pb`).
    function fairRateFromPrices(
        uint256 P0,
        uint256 Pa,
        uint256 Pb,
        uint256 sigmaWad,
        uint256 durationSeconds
    ) external pure returns (uint256 fairRateWad);

    /// @notice `FairPremium = fairRate(σ_ref) · maxIL` for `token`, reading
    ///         `σ_ref` from the VolOracle. `maxIL` is in token1 units (from
    ///         `ILMath`); the returned premium is in the same units.
    /// @return premium   FairPremium in token1 units.
    /// @return fairRateWad The fairRate used (WAD).
    /// @return sigmaRefWad The σ_ref read from the VolOracle (WAD).
    function fairPremium(
        address token,
        uint256 aWad,
        uint256 bWad,
        uint256 durationSeconds,
        uint256 maxIL
    ) external view returns (uint256 premium, uint256 fairRateWad, uint256 sigmaRefWad);

    /// @notice The VolOracle this oracle reads `σ_ref` from.
    function volOracle() external view returns (address);
}
