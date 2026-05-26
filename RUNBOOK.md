# Inflexion — Runbook

Day-to-day operational reference: environment, env vars, common commands, demo-day playbook.

## Environment versions (last verified 2026-05-26)

| Tool                 | Required | Installed    | Status                                                            |
| -------------------- | -------- | ------------ | ----------------------------------------------------------------- |
| node                 | ≥ 20     | 24.15.0      | ✅                                                                |
| pnpm                 | ≥ 9      | 10.33.2      | ✅                                                                |
| forge / cast / anvil | latest   | 1.6.0-v1.7.0 | ✅                                                                |
| python               | ≥ 3.12   | 3.14.5       | ✅                                                                |
| gh                   | latest   | 2.92.0       | ✅                                                                |
| rustc / cargo        | ≥ 1.75   | —            | ❌ needed before **Phase 2** (ILMath Stylus)                      |
| cargo-stylus         | latest   | —            | ❌ needed before **Phase 2**                                      |
| docker               | latest   | —            | ❌ needed before **Phase 1.7** (local Nitro dev node)             |
| uv                   | latest   | —            | ❌ needed before **Phase 14** (`quant/`); `pip` works as fallback |

### Install commands for missing tools (Windows / winget)

```powershell
# Rust toolchain (rustc + cargo)
winget install --id Rustlang.Rustup --source winget
rustup default stable
cargo install --force cargo-stylus

# Docker Desktop (required for local Nitro dev node)
winget install --id Docker.DockerDesktop --source winget

# uv (Python package manager) — optional, pip works too
winget install --id astral-sh.uv --source winget
# or: python -m pip install --user uv
```

## Environment variables

Copy `.env.example` → `.env` and fill in (created in **Phase 1.8**).

Expected keys:

- `ARBITRUM_RPC`, `SEPOLIA_RPC`, `LOCAL_RPC=http://localhost:8545`
- `DEPLOYER_PRIVATE_KEY` (Sepolia + local only — never mainnet from this file)
- `OPERATOR_PRIVATE_KEY` (demo-mode oracle, never mainnet)
- `ETHERSCAN_API_KEY`, `THEGRAPH_DEPLOY_KEY`

## Common commands

_(Populated as packages land — see `CLAUDE.md` for current state.)_

## Demo-day playbook

_(Populated in Phase 12. Will cover: pre-seed, dry-run, fallback video, RPC pinning, gas pre-funding.)_
