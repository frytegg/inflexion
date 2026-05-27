# Inflexion — Runbook

Day-to-day operational reference: environment, env vars, common commands, demo-day playbook.

## Environment versions (last verified 2026-05-27)

| Tool                 | Required | Installed    | Status                                                            |
| -------------------- | -------- | ------------ | ----------------------------------------------------------------- |
| node                 | ≥ 20     | 24.15.0      | ✅                                                                |
| pnpm                 | ≥ 9      | 10.33.2      | ✅                                                                |
| forge / cast / anvil | latest   | 1.6.0-v1.7.0 | ✅                                                                |
| python               | ≥ 3.12   | 3.14.5       | ✅                                                                |
| gh                   | latest   | 2.92.0       | ✅                                                                |
| rustc / cargo        | 1.88     | —            | ❌ **WSL2 / Linux only** — see "Stylus development" below         |
| cargo-stylus         | 0.10.x   | —            | ❌ **WSL2 / Linux only** — see "Stylus development" below         |
| docker               | latest   | —            | ❌ needed before **Phase 1.7** (local Nitro dev node)             |
| uv                   | latest   | —            | ❌ needed before **Phase 14** (`quant/`); `pip` works as fallback |

### Install commands for missing tools (Windows / winget)

```powershell
# Docker Desktop (required for local Nitro dev node + WSL2 backend for Stylus)
winget install --id Docker.DockerDesktop --source winget

# uv (Python package manager) — optional, pip works too
winget install --id astral-sh.uv --source winget
# or: python -m pip install --user uv
```

## Stylus development (WSL2 / Linux only)

**Why WSL2 and not native Windows.** The Stylus build chain depends on
`alloy-primitives`, which references the Stylus VM hostio function
`native_keccak256` (only defined at WASM runtime). Linux's `ld` tolerates this
as an undefined external; Windows MSVC `link.exe` (LNK2019 / LNK1120) does
not, and breaks the `stylus-proc` proc-macro DLL build. OffchainLabs patches
`alloy-primitives` / `ruint` internally for their own Windows builds but has
never upstreamed those patches, and the official
[Quickstart](https://docs.arbitrum.io/stylus/quickstart) only targets Linux.
The cargo-stylus repo itself was archived Oct 2025 and folded into
[`stylus-sdk-rs/cargo-stylus`](https://github.com/OffchainLabs/stylus-sdk-rs/tree/main/cargo-stylus) —
also Linux-only.

**Setup (run inside WSL2 Ubuntu 22.04 or 24.04):**

```bash
# 1. WSL2 system deps
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev git curl

# 2. Rust 1.88 (matches the pinned channel in
#    packages/contracts/stylus/ILMath/rust-toolchain.toml)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default 1.88
rustup target add wasm32-unknown-unknown --toolchain 1.88

# 3. cargo-stylus (latest stable)
cargo install --force cargo-stylus
cargo stylus -V   # should print 0.10.x

# 4. Validate the ILMath skeleton compiles
cd ~/dev/inflexion/packages/contracts/stylus/ILMath
cargo stylus check
```

**Filesystem.** Clone the repo into the WSL2 native filesystem
(`~/dev/inflexion`), **not** `/mnt/c/...`. Cross-filesystem bind mounts from
the Windows host into Docker are dramatically slower
([Docker WSL2 best practices](https://docs.docker.com/desktop/features/wsl/best-practices/)).

**Docker.** Required for `cargo stylus verify` and reproducible deploy
checks. Install Docker Desktop on the Windows host with the WSL2 backend
enabled; it auto-exposes the daemon to WSL2.

**CI.** GitHub Actions Linux runners match this setup natively — no special
config required.

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
