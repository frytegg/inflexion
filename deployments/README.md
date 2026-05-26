# Deployments

Per-network contract address registries. Populated by `packages/contracts/script/Deploy.s.sol` runs.

- `sepolia.json` — Arbitrum Sepolia testnet (active development)
- `arbitrum.json` — Arbitrum One mainnet (post-hackathon)
- `local.json` — local Nitro fork (regenerated each dev session)

**Format:** a JSON object keyed by contract name, each entry holding
`{ address, deployer, txHash, blockNumber, deployedAt }`.

`foundry.toml` grants `fs_permissions = [{ access = "read", path = "../../deployments" }]`
so deploy scripts may read prior addresses for upgrades / linking.
