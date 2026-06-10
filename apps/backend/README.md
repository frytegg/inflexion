# @inflexion/backend

The combined, hosted backend — **one process, one port**:

- `/` → the public REST API ([`@inflexion/api`](../../packages/api)) — markets, pool, pricing, swaps, `data/*` (the five signals), sigma, mm, `/health`.
- `/engine/*` → the Path-B quote relayer ([`@inflexion/engine`](../../packages/engine)) — `GET`/`POST /engine/quote`, `POST /engine/telemetry/preview`, `/engine/health`.

Co-locating them lets the API read the **same** telemetry JSONL the engine writes (`DEMAND_LOG` / `COMPETITION_LOG` on a shared volume), so the off-chain halves of **Signal 2** (quote competition) and **Signal 4** (latent demand) are live alongside the subgraph-backed and live-RPC signals.

## Run locally

```bash
pnpm --filter "@inflexion/backend..." build   # build sdk + engine + api
SUBGRAPH_URL=https://api.studio.thegraph.com/query/1754692/inflexion-arb-sepolia/version/latest \
ARBITRUM_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc \
DEMAND_LOG=./.data/demand.jsonl COMPETITION_LOG=./.data/competition.jsonl \
pnpm --filter @inflexion/backend start
# → http://localhost:8088  (API)  +  http://localhost:8088/engine  (relayer)
```

`pnpm --filter @inflexion/backend dev` runs it with `node --watch`. The `start` script auto-loads a root `.env` if present (`node --env-file-if-exists=../../.env`).

## Environment

| Var                    | Required      | Purpose                                                                                      |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `PORT`                 | host-injected | Listen port (the host / compose sets this; default `8088`).                                  |
| `BACKEND_DOMAIN`       | for VM deploy | TLS hostname for Caddy (your domain, or `<vm-ip>.sslip.io`).                                 |
| `SUBGRAPH_URL`         | recommended   | Subgraph query endpoint. Absent → history/aggregate surfaces return typed `pending`.         |
| `ARBITRUM_SEPOLIA_RPC` | recommended   | RPC for the live current-load surface (or `SEPOLIA_RPC`). Absent → live endpoints `pending`. |
| `CHAIN_ID`             | no            | Default `421614` (Arbitrum Sepolia).                                                         |
| `VERIFYING_CONTRACT`   | no            | InflexionCore address for EIP-712 quote verification. Default = the address registry.        |
| `DEMAND_LOG`           | for Signal 4  | JSONL path on the shared volume, e.g. `/data/demand.jsonl`.                                  |
| `COMPETITION_LOG`      | for Signal 2  | JSONL path on the shared volume, e.g. `/data/competition.jsonl`.                             |
| `QUOTE_LOG`            | no            | Accepted-quote JSONL (optional).                                                             |

## Deploy on a VM (Oracle Cloud free tier) — recommended

Always-on, $0, persistent telemetry. The stack is [`docker-compose.yml`](../../docker-compose.yml): the combined backend + a [Caddy](./Caddyfile) reverse proxy that obtains **automatic Let's Encrypt HTTPS** — required, because an HTTPS dApp cannot call a plain-HTTP backend (mixed content is blocked).

### 1. Create the VM

Oracle Cloud → Compute → Instances → **Create**. Image **Ubuntu 22.04**; shape **VM.Standard.A1.Flex** (Ampere/ARM, Always Free — e.g. 2 OCPU / 12 GB; fall back to **VM.Standard.E2.1.Micro** if A1 capacity is unavailable). Add your SSH key, create, note the **public IP**.

### 2. Open ports 80 + 443 (two places — Oracle blocks both)

- **VCN security list**: Networking → your VCN → the subnet's Security List → add Ingress rules for TCP **80** and **443** from `0.0.0.0/0`.
- **On the VM** (Oracle's Ubuntu image ships restrictive iptables):
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

### 3. Install Docker

```bash
ssh ubuntu@<PUBLIC_IP>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exit   # re-SSH so the docker group applies
```

### 4. Get the code + configure

```bash
ssh ubuntu@<PUBLIC_IP>
git clone https://github.com/frytegg/inflexion.git && cd inflexion
cp .env.example .env && nano .env
```

Set in `.env`:

```
SUBGRAPH_URL=https://api.studio.thegraph.com/query/1754692/inflexion-arb-sepolia/version/latest
ARBITRUM_SEPOLIA_RPC=<your Arbitrum Sepolia RPC>
# TLS hostname for Caddy — a domain pointed at the VM, OR sslip.io with no domain:
BACKEND_DOMAIN=<PUBLIC_IP>.sslip.io
```

> **No domain?** `BACKEND_DOMAIN=<PUBLIC_IP>.sslip.io` resolves to your IP, so Caddy still gets a real certificate. With a domain, add an A record (e.g. `api.inflexion.xyz → <PUBLIC_IP>`) and use that hostname instead.

### 5. Launch

```bash
docker compose up -d --build      # first build ~2-4 min on A1
docker compose logs -f caddy      # watch the certificate get issued
curl https://<BACKEND_DOMAIN>/health
curl https://<BACKEND_DOMAIN>/engine/health
```

Update later with `git pull && docker compose up -d --build`.

## Deploy to Railway (alternative, paid)

The repo also ships [`railway.json`](../../railway.json) (Dockerfile builder, healthcheck `/health`): `railway up` from the repo root, set the same env vars, add a volume at `/data`, generate a domain. Railway removed its free tier (~$5/mo).

## After deploy — wire the dApp

With your backend origin `https://<BACKEND_DOMAIN>`, set in `apps/web/.env.local` (and the web host):

```
NEXT_PUBLIC_API_URL=https://<BACKEND_DOMAIN>
NEXT_PUBLIC_ENGINE_URL=https://<BACKEND_DOMAIN>/engine
```

The engine lives under the `/engine` prefix, so the SDK's `${engineBaseUrl}/quote` resolves to `…/engine/quote`. WebSocket quote-streaming (the `mm-bot`) is a local-dev tool and is not exposed by the hosted backend; browser MMs publish via `POST /engine/quote`.
