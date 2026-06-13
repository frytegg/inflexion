# Deployments

Per-network contract address registries. Populated by `packages/contracts/script/Deploy.s.sol` runs.

- `arbitrum-sepolia.json` — Arbitrum Sepolia testnet (live deployment)
- `arbitrum-one.json` — Arbitrum One mainnet (post-hackathon)

**Format:** a JSON object keyed by contract name, each entry holding
`{ address, deployer, txHash, blockNumber, deployedAt }`.

`foundry.toml` grants `fs_permissions = [{ access = "read", path = "../../deployments" }]`
so deploy scripts may read prior addresses for upgrades / linking.
