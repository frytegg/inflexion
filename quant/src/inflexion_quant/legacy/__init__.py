"""Legacy PARTIAL multi-asset study (preserved, not deleted).

The launch pivoted to the **cvAMM-FULL** single-asset design (see
``inflexion_quant.cvamm``). This subpackage preserves the multi-asset PARTIAL
solvency stack — the ``c``-waterfall (``portfolio``), the correlated-crash stress
harness (``stress``), the 8-parameter calibrator (``calibrate``), and the PARTIAL
deck charts (``deck_charts``) — because they seed the roadmap:

- the PARTIAL leverage dial (collateral < MaxIL + buffer),
- the senior/junior tranche cut-point (cvAMM deliverable 9), and
- the pool-level hedge fraction (cvAMM deliverable 8),

all of which need the real-measure crash sims this stack already implements. The
generic tail-risk helpers ``stress.var_cvar`` / ``stress.ruin_probability`` are
re-imported by the launch depositor-disclosure module (``cvamm`` deliverable 10).

Located as a subpackage (``inflexion_quant.legacy``) rather than a top-level
``quant/legacy/`` dir so the launch package can import the reused helpers cleanly
and the wheel/editable install picks it up with no extra packaging. See
``quant/legacy/README.md`` for the full module classification.

Compatibility shims ``inflexion_quant.calibrate`` and ``inflexion_quant.stress``
remain at the package root so the **frozen** ``params.py`` and ``test_params.py``
keep importing without edits.
"""
