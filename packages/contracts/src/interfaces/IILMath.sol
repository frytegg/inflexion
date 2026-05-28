// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  IILMath — pure-compute interface for Uniswap v3 IL / MaxIL math
/// @notice Implemented by the Inflexion Stylus contract `ILMath` at
///         `packages/contracts/stylus/ILMath/`. Solidity contracts call into
///         this interface to delegate the hot math (sqrt + Q64.96 fixed-point)
///         to a Rust/WASM implementation that is materially cheaper than the
///         Solidity equivalent for these operations.
/// @dev    Spec references:
///           * `spec.md` §3.1  — IL formula (in-range / below Pa / above Pb)
///           * `spec.md` §3.2  — MaxIL = max(IL(Pa), IL(Pb)) + the coverage cap
///           * `spec.md` §11.2 — this interface
///         All prices are in Uniswap v3 Q64.96 sqrt-price format
///         (`sqrtPriceX96 = floor(sqrt(price) * 2^96)`).
///         "IL" here is *impermanent loss* (the concept) — not the Inflexion brand.
interface IILMath {
    /// @notice Maximum in-range IL for a position — the analytical worst case
    ///         while price stays within `[Pa, Pb]`. This serves two roles:
    ///         (1) the FULL-mode collateral unit (MM locks MaxIL), and
    ///         (2) the payout cap (`payout = min(realized_IL, MaxIL)`).
    /// @dev    Together with the cap, this gives invariant **I1** (no bad debt,
    ///         FULL): `payout ≤ collateral == MaxIL` by construction
    ///         (`spec.md` §3.2). Convexity proof: `V_hold(P)` is affine in `P`
    ///         and `V_lp(P)` is concave on `[Pa, Pb]`, so `IL = V_hold − V_lp`
    ///         is convex and attains its max at a boundary — hence
    ///         `max(IL(Pa), IL(Pb))`.
    /// @param  sqrtPriceX96  Entry price `P0` at swap creation, in Q64.96
    /// @param  sqrtPaX96     Lower-tick price, in Q64.96
    /// @param  sqrtPbX96     Upper-tick price, in Q64.96
    /// @param  liquidity     Position liquidity `L` read once from the NFT at
    ///                       creation, stored in `SwapRecord`, and reused at
    ///                       settlement (invariant **I6** — `L`-immutability)
    /// @return maxIL         MaxIL in token1-denominated units (USDC for USD pairs)
    function computeMaxIL(
        uint256 sqrtPriceX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity
    ) external view returns (uint256 maxIL);

    /// @notice Realized IL at settlement price `P_T` = `max(0, V_hold(T) − V_lp(T))`.
    /// @dev    Three regimes handled internally (`spec.md` §3.1):
    ///           - in range (`Pa ≤ P_T ≤ Pb`): `V_lp = x(P_T)·P_T + y(P_T)`
    ///           - below `Pa` (full token0):    `V_lp = L·(1/√Pa − 1/√Pb)·P_T`
    ///           - above `Pb` (full token1):    `V_lp = L·(√Pb − √Pa)`
    ///         Invariant **I3**: the subtraction `V_hold − V_lp` is never
    ///         unchecked; computed as `V_hold > V_lp ? V_hold − V_lp : 0`.
    ///         Invariant **I4**: when `V_lp ≥ V_hold`, returns `0` — the LP
    ///         never profits from the swap.
    /// @param  sqrtPriceTX96  Settlement price (Chainlink round at expiry `T`,
    ///                        per `spec.md` §6.1), in Q64.96
    /// @param  sqrtPaX96      Lower-tick price
    /// @param  sqrtPbX96      Upper-tick price
    /// @param  liquidity      `L` stored at creation (invariant **I6**)
    /// @param  amount0Entry   token0 amount at the creation snapshot
    /// @param  amount1Entry   token1 amount at the creation snapshot
    /// @return ilAmount       Raw realized IL — the cap is applied at the
    ///                        caller: `payout = min(ilAmount, maxIL)`
    ///                        (`spec.md` §5.4)
    function computeIL(
        uint256 sqrtPriceTX96,
        uint256 sqrtPaX96,
        uint256 sqrtPbX96,
        uint128 liquidity,
        uint256 amount0Entry,
        uint256 amount1Entry
    ) external returns (uint256 ilAmount);
}
