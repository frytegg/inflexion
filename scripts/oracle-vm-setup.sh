#!/usr/bin/env bash
# One-shot setup for the Inflexion backend on an Oracle Cloud (Ubuntu) VM.
#
# Usage on the VM (after SSH):
#   git clone https://github.com/frytegg/inflexion.git && cd inflexion
#   bash scripts/oracle-vm-setup.sh
#
# It opens the VM firewall, installs Docker, prepares .env (pausing once for you to
# fill it in), then builds + starts the Docker Compose stack (backend + Caddy/TLS).
#
# NOTE: the Oracle *VCN Security List* ingress rules for TCP 80 + 443 must also be
# added in the OCI console — that is the one step this script cannot do (no creds).
set -euo pipefail

REPO_URL="https://github.com/frytegg/inflexion.git"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "==> 1/4  Opening VM firewall ports 80 + 443 (iptables)…"
sudo iptables -C INPUT -m state --state NEW -p tcp --dport 80 -j ACCEPT 2>/dev/null \
  || sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -m state --state NEW -p tcp --dport 443 -j ACCEPT 2>/dev/null \
  || sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || echo "    (netfilter-persistent not present; rules apply now but may not survive reboot)"

echo "==> 2/4  Installing Docker (if missing)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "    docker already installed: $(docker --version)"
fi

echo "==> 3/4  Preparing .env…"
if [ ! -f .env ]; then
  cp .env.example .env
  cat <<EOF

  Created .env from .env.example. EDIT IT before launching:
      nano "$REPO_DIR/.env"
  Set at least:
      SUBGRAPH_URL          (already defaulted to the live subgraph)
      ARBITRUM_SEPOLIA_RPC  (your Arbitrum Sepolia RPC URL)
      BACKEND_DOMAIN        (your domain pointed at this VM, OR <THIS_VM_PUBLIC_IP>.sslip.io)
  Then re-run:  bash scripts/oracle-vm-setup.sh
EOF
  exit 0
fi

if ! grep -qE '^BACKEND_DOMAIN=.+' .env; then
  echo "    ERROR: BACKEND_DOMAIN is not set in .env — Caddy needs it for TLS." >&2
  echo "    Set BACKEND_DOMAIN=<your-domain-or-<ip>.sslip.io> then re-run." >&2
  exit 1
fi

echo "==> 4/4  Building + starting the stack (this takes a few minutes the first time)…"
sudo docker compose up -d --build

DOMAIN="$(grep -E '^BACKEND_DOMAIN=' .env | head -n1 | cut -d= -f2-)"
cat <<EOF

  Up. Caddy is fetching a TLS certificate (watch:  sudo docker compose logs -f caddy).
  Once issued, verify:
      curl https://$DOMAIN/health
      curl https://$DOMAIN/engine/health
EOF
