"""ROADMAP-tagged cvAMM sizing methods (deliverables 7, 8, 9).

These are **not launch-blocking** (launch is ETH/USDC FULL, leverage 1, nude
USDC, single untranched pool). Each provides a *sizing method* + a param slot so
the roadmap features can be turned on later from ``params.json`` without
hardcoding. All three reuse the legacy real-measure crash machinery and/or the
launch depositor P&L.

- **Deliverable 7 — productive-collateral SAFE cap.** :func:`routable_idle_fraction`.
  COMPLIANT FORM ONLY: idle/free USDC, instantly-redeemable wrappers, hard cap,
  never 100%, nude buffer kept. The "Aave for locked collateral" idea is
  **BLOCKED** (CLAUDE.md + spec §7.2 F-#3 + the ``IYieldAdapter`` contract);
  routing *locked* collateral to a utilization-gated venue lets a util→100% event
  break ``releaseAndDistribute`` and the no-bad-debt guarantee. Not encoded here.
- **Deliverable 8 — pool-level hedge fraction.** :func:`pool_hedge_frontier`.
  The pool buys back a fraction of aggregate tail convexity (long option strip /
  long Panoptic) — the only lever that changes the *nature* of the risk (halves
  the worst month) at an APY cost. Approximate (perpetual vs fixed-maturity
  gamma); **explicitly NOT relied on for solvency**.
- **Deliverable 9 — senior/junior tranche cut.** :func:`tranche_cut`. No
  engineering makes a single-pair vol seller low-risk; tranching lets each
  depositor pick a risk dose. Senior = hedged, low tail; junior = first loss,
  high APY.
"""

from __future__ import annotations

import numpy as np

from inflexion_quant.depositor import DepositorModel, simulate_monthly_pnl
from inflexion_quant.legacy.stress import var_cvar

ROADMAP_STATUS = "roadmap"

# Venues explicitly blocked for ALL vault USDC (locked AND idle), per CLAUDE.md.
BLOCKED_VENUES = ("Aave", "Compound", "any utilization-gated lending venue")
COMPLIANT_VENUES = ("sDAI", "tokenized_tbills")


# ─── Deliverable 7: productive-collateral SAFE cap (idle-only) ───────────────


def routable_idle_fraction(
    *,
    free_usdc: float = 1.0,
    p99_instant_demand_frac: float = 0.20,
    safety_multiple: float = 1.5,
) -> dict[str, object]:
    """Safe fraction of **idle/free** USDC routable to instantly-redeemable wrappers.

    Locked collateral is **never** routed. The constraint is only on free USDC:
    keep a nude buffer covering the 99th-percentile instant demand (new coverage
    to lock + withdrawal-queue outflow within the wrapper's redemption window),
    scaled by ``safety_multiple``; route the rest. Because the wrappers are
    instantly redeemable the residual is recoverable on demand — but the cap is
    **never 100%** by construction.

        nude_buffer_frac = min(1.0, safety_multiple · p99_instant_demand_frac)
        routable_frac    = max(0.0, 1.0 − nude_buffer_frac)

    Returns the fractions + the venue whitelist/blocklist for provenance.
    """
    nude_buffer_frac = min(1.0, safety_multiple * p99_instant_demand_frac)
    routable_frac = max(0.0, 1.0 - nude_buffer_frac)
    return {
        "status": ROADMAP_STATUS,
        "applies_to": "idle/free USDC only — locked collateral is NEVER routed",
        "routable_idle_frac": routable_frac,
        "nude_buffer_frac": nude_buffer_frac,
        "venue_whitelist": list(COMPLIANT_VENUES),
        "venue_blocklist": list(BLOCKED_VENUES),
        "blocked_reason": (
            "Routing any vault USDC (locked OR idle) to a utilization-gated venue "
            "lets a util→100% event break instant redemption and the no-bad-debt "
            "guarantee. 'Aave for locked collateral' is BLOCKED pending an explicit "
            "owner override of CLAUDE.md."
        ),
        "free_usdc_basis": free_usdc,
    }


# ─── Deliverable 8: pool-level hedge fraction (APY vs tail frontier) ─────────


def pool_hedge_frontier(
    model: DepositorModel | None = None,
    *,
    hedge_fractions: tuple[float, ...] = (0.0, 0.1, 0.2, 0.3, 0.5),
    hedge_cost_mult: float = 1.15,
    n_months: int = 20_000,
    rng_seed: int = 20260601,
    terminal_fn=None,
) -> dict[str, object]:
    """APY-vs-tail frontier as the pool hedges a fraction ``h`` of its short gamma.

    Model: the pool buys a long-convexity strip that pays the depositor's *tail*
    loss it is short. A fraction ``h`` of every month's payout is hedged away, at
    a premium of ``hedge_cost_mult`` × its fair (real-measure mean) cost — the
    hedge is a long option position so it costs more than its expected payoff
    (that excess is what the counterparty earns). Hedged monthly P&L::

        pnl_h = pnl + h · (payout_offset − hedge_cost)

    where ``payout_offset`` removes ``h`` of the realised payout variance and
    ``hedge_cost`` is its fair price × ``hedge_cost_mult``. Reported: mean monthly
    return, worst month, CVaR99 per ``h`` — the frontier the quant reads the
    optimal ``h`` off (knee where worst-month halves at acceptable APY cost).

    Approximate (perpetual vs fixed-maturity gamma); NOT relied on for solvency.
    """
    model = model or DepositorModel()
    rng = np.random.default_rng(rng_seed)
    pnl = simulate_monthly_pnl(model, n_months=n_months, rng=rng, terminal_fn=terminal_fn)
    # Decompose: the loss component (negative tail) is what a long-convexity hedge
    # offsets. fair hedge cost ≈ mean of the offset payoff; charged at a markup.
    loss_component = np.maximum(0.0, -pnl)  # monthly losses (frac of capital)
    fair_hedge_cost = float(loss_component.mean())

    rows = []
    for h in hedge_fractions:
        hedge_cost = h * fair_hedge_cost * hedge_cost_mult
        pnl_h = pnl + h * loss_component - hedge_cost
        var99, cvar99 = var_cvar(pnl_h, confidence=0.99)
        rows.append(
            {
                "hedge_fraction": h,
                "mean_monthly_return": float(pnl_h.mean()),
                "worst_month": float(max(0.0, -pnl_h.min())),
                "cvar99_monthly": float(cvar99),
                "p_losing_month": float((pnl_h < 0).mean()),
            }
        )
    return {
        "status": ROADMAP_STATUS,
        "hedge_cost_mult": hedge_cost_mult,
        "fair_hedge_cost_monthly": fair_hedge_cost,
        "frontier": rows,
        "note": "approximate (perpetual vs fixed-maturity gamma); NOT for solvency",
    }


# ─── Deliverable 9: senior/junior tranche cut point ─────────────────────────


def tranche_cut(
    model: DepositorModel | None = None,
    *,
    senior_fractions: tuple[float, ...] = (0.4, 0.5, 0.6, 0.7, 0.8),
    senior_loss_target: float = 0.005,
    n_months: int = 20_000,
    rng_seed: int = 20260601,
    terminal_fn=None,
) -> dict[str, object]:
    """Senior/junior cut where the **junior** tranche absorbs first loss.

    Capital is split into ``junior_frac = 1 − senior_fraction`` (first loss) and
    ``senior_fraction`` (protected). A monthly loss ``ℓ`` (fraction of *total*
    capital) hits junior first; senior is touched only once ``ℓ > junior_frac``.
    Per-tranche monthly returns (scaled to each tranche's own capital):

        junior_ret = (gain − min(loss, junior_frac)) / junior_frac
        senior_ret = (gain − max(0, loss − junior_frac)) / senior_fraction

    (gains accrue mostly to junior — it captures the load for taking first loss;
    here the upside is shared pro-rata for a conservative senior view.) Returns
    each candidate's senior P(loss) / CVaR and junior APY; the recommended cut is
    the smallest junior tranche whose senior P(loss) ≤ ``senior_loss_target``.
    """
    model = model or DepositorModel()
    rng = np.random.default_rng(rng_seed)
    pnl = simulate_monthly_pnl(model, n_months=n_months, rng=rng, terminal_fn=terminal_fn)
    gain = np.maximum(0.0, pnl)
    loss = np.maximum(0.0, -pnl)

    rows = []
    recommended = None
    for sf in senior_fractions:
        jf = 1.0 - sf
        if jf <= 0:
            continue
        junior_loss = np.minimum(loss, jf)
        senior_loss = np.maximum(0.0, loss - jf)
        # Conservative: gains shared pro-rata (real design routes most load to junior)
        junior_ret = (gain * jf - junior_loss) / jf
        senior_ret = (gain * sf - senior_loss) / sf
        senior_p_loss = float((senior_ret < 0).mean())
        _, senior_cvar = var_cvar(senior_ret, confidence=0.99)
        row = {
            "senior_fraction": sf,
            "junior_fraction": jf,
            "senior_p_loss": senior_p_loss,
            "senior_cvar99": float(senior_cvar),
            "junior_mean_monthly": float(junior_ret.mean()),
            "junior_worst_month": float(max(0.0, -junior_ret.min())),
        }
        rows.append(row)
        if recommended is None and senior_p_loss <= senior_loss_target:
            recommended = sf

    return {
        "status": ROADMAP_STATUS,
        "senior_loss_target": senior_loss_target,
        "recommended_senior_fraction": recommended,
        "junior_first_loss": True,
        "sweep": rows,
        "note": "no engineering makes a single-pair vol seller low-risk; tranching "
        "lets each depositor pick a risk dose",
    }
