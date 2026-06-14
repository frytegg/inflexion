# Inflexion

Inflexion is the first trustless, fully-collateralized on-chain market for Uniswap v3 in-range impermanent-loss risk, built on Arbitrum (Stylus + Solidity). A liquidity provider pays a fixed upfront premium and is paid `min(realized IL, MaxIL)` at expiry from collateral locked before the position goes live. Pricing comes from an always-on cvAMM pool (the floor) and competing market makers (the ceiling), routed to whichever is cheaper; the fair value itself is an exact closed form computed **on-chain** by an Arbitrum Stylus (Rust) oracle.

## Highlights

- **Capped, no bad debt in FULL mode** — payout is `min(realized IL, MaxIL)`, fully pre-collateralized; under capped payoff + solvent collateral + oracle/settlement liveness, the protocol cannot produce bad debt.
- **Exact pricing, on-chain** — the fair premium is a closed-form solution evaluated by an Arbitrum Stylus (Rust) oracle, not an off-chain quote.
- **Two rails, one route** — a cvAMM pool (floor) and competing market makers (ceiling), routed to the cheaper price.
- **Full stack** — a TypeScript SDK, a public REST API, and a subgraph ship alongside the contracts.

## Links

|                    |                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------- |
| App                | https://inflexion-ten.vercel.app                                                   |
| Documentation      | https://inflexion.mintlify.app                                                     |
| REST API + Swagger | https://inflexion-backend.onrender.com/docs                                        |
| Subgraph           | https://api.studio.thegraph.com/query/1754692/inflexion-arb-sepolia/version/latest |

## Monorepo layout

| Path                 | Contents                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `packages/contracts` | Foundry + Stylus on-chain code — core, vaults, oracles, IL math.           |
| `packages/sdk`       | `@inflexion/sdk` — LP, depositor, MM, and data surfaces.                   |
| `packages/engine`    | Off-chain matching relayer for market-maker quotes (Path B).               |
| `packages/api`       | Public, read-only REST API (Swagger-documented).                           |
| `packages/subgraph`  | The Graph subgraph.                                                        |
| `apps/web`           | Next.js frontend — Protect / Earn / Underwrite.                            |
| `apps/docs`          | Mintlify documentation site.                                               |
| `quant`              | Monte Carlo calibration → `params.json` (the on-chain pricing parameters). |
| `docs`               | Math, security, and engineering references.                                |
| `deployments`        | Per-network address registries.                                            |

## Quickstart

```bash
pnpm install
pnpm test
```

The full build also requires the **Foundry**, **Stylus** (Rust; WSL2/Linux on Windows), and **Python 3.12+** toolchains — see [`packages/contracts/README.md`](packages/contracts/README.md) for the contract build.

## Status

Live on **Arbitrum Sepolia** (chainId `421614`), with the full create → settle lifecycle exercised on both rails (cvAMM pool and market maker). The app runs on Vercel, the documentation on Mintlify, and the backend (REST API + matching engine) on Render.

## Disclaimer

Testnet software. LPs are paid in FULL mode with no bad debt — qualified by capped payoff, solvent collateral, and oracle/settlement liveness. Depositors (Earn) and market makers (Underwrite) are volatility sellers: their **capital is not guaranteed** and can be drawn down to pay LP settlements.

## License

[MIT](LICENSE).
