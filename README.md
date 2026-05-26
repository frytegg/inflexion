# IL Swap

> The first trustless market for Uniswap v3 LP impermanent-loss risk transfer.

LPs pay a fixed upfront premium to transfer the _in-range_ IL risk of a specific Uniswap v3 position to a market maker, who posts collateral and is paid for taking the risk. In FULL mode the protocol cannot produce bad debt — the payoff is capped at **MaxIL**, the analytically-computable worst-case while price stays in the position's range. Off-chain matching, on-chain non-custodial settlement on **Arbitrum One**.

Built for the **Arbitrum Open House London Buildathon** (25 May → 14 June 2026).

## Quick links

- **Spec:** [`spec.md`](spec.md) — v3.3, build-ready
- **Roadmap:** [`ROADMAP.md`](ROADMAP.md) — daily task tracker
- **Architecture overview:** [`CLAUDE.md`](CLAUDE.md)
- **Runbook:** [`RUNBOOK.md`](RUNBOOK.md)
- **App:** _(coming — `apps/web/`)_
- **Docs:** _(coming — `docs.ilswap.xyz`)_
- **Public API:** _(coming)_

## Status

Phase 0 of the build (repo foundation). See [`ROADMAP.md`](ROADMAP.md) for live progress.

## License

[MIT](LICENSE).
