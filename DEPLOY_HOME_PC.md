# Home-PC deploy prompt — Inflexion backend (Oracle Cloud free VM)

Open Claude Code on the home PC inside the `inflexion` repo and paste the block below
(or just say: _"Follow DEPLOY_HOME_PC.md."_). It drives the deploy **one step at a time,
waiting for your confirmation between steps**.

---

You are guiding me through deploying the **Inflexion combined backend** (REST API + Path-B
engine) to an **Oracle Cloud Always-Free VM**, using **Docker Compose + Caddy** (automatic
HTTPS). All deploy artifacts already exist on `main`: `docker-compose.yml`, `apps/backend/`,
`apps/backend/Caddyfile`, and `scripts/oracle-vm-setup.sh`.

**Interaction rules (important):**

- Walk me through **ONE step at a time**.
- After each step, **STOP and wait** for me to confirm it's done and paste any output/errors.
- **Do not** give the next step until I confirm the previous one succeeded.
- If a step errors, diagnose from my pasted output and help me fix it before continuing.
- Keep each step short and copy-pasteable.

**Goal:** a live HTTPS backend at `https://<BACKEND_DOMAIN>` serving the API at `/` and the
engine at `/engine`; then report the final `BACKEND_DOMAIN` so I can paste it back into my
other Claude session to wire the dApp + docs.

**Facts you can rely on (don't re-derive):**

- Subgraph is already live: `SUBGRAPH_URL=https://api.studio.thegraph.com/query/1754692/inflexion-arb-sepolia/version/latest`
- I will give you my own **Arbitrum Sepolia RPC URL** when asked.
- **No domain needed:** use `BACKEND_DOMAIN=<VM_PUBLIC_IP>.sslip.io` — sslip.io resolves that
  to the IP, so Caddy still gets a real Let's Encrypt cert.

**The steps (one at a time, wait for my confirmation between each):**

1. **Create the VM.** Tell me exactly how, in the Oracle Cloud console: Ubuntu 22.04, shape
   **VM.Standard.A1.Flex** (ARM Always-Free, e.g. 2 OCPU / 12 GB; if A1 capacity is
   unavailable, fall back to **VM.Standard.E2.1.Micro**), upload my SSH public key. Ask me
   for the **public IP** before continuing.

2. **Open ports in the OCI console.** Guide me to the VM's VCN → subnet → **Security List**,
   and adding **Ingress** rules for **TCP 80** and **TCP 443** from `0.0.0.0/0`. Wait until I
   confirm both rules exist. (This is separate from the VM firewall, which the script handles.)

3. **SSH in.** Give me the `ssh ubuntu@<IP>` command. Wait until I'm in.

4. **Get the code.** `git clone https://github.com/frytegg/inflexion.git && cd inflexion`
   (or `git pull` if it already exists). Wait for confirmation.

5. **Run the setup script (first pass).** `bash scripts/oracle-vm-setup.sh` — it opens the VM
   firewall, installs Docker, and scaffolds `.env`, then stops. Wait for it to pause.

6. **Fill `.env`.** Have me `nano .env` and set `ARBITRUM_SEPOLIA_RPC=<my RPC>` and
   `BACKEND_DOMAIN=<VM_PUBLIC_IP>.sslip.io` (`SUBGRAPH_URL` is already defaulted). Wait until I save.

7. **Launch.** Re-run `bash scripts/oracle-vm-setup.sh` (it runs `docker compose up -d --build`).
   Then `sudo docker compose logs -f caddy` until the TLS certificate is issued. Wait for confirmation.

8. **Verify.** `curl https://<BACKEND_DOMAIN>/health` and `curl https://<BACKEND_DOMAIN>/engine/health`.
   Confirm both return `ok` JSON.

9. **Done.** Print the final `BACKEND_DOMAIN` and remind me to send it back to my other Claude
   session to wire `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_ENGINE_URL` and flip the docs status + roadmap.

**Known gotchas:** ports must be open in **both** the OCI Security List **and** the VM iptables
(the script does the iptables part); A1 capacity is sometimes unavailable (retry or use
E2.1.Micro); the script uses `sudo docker` so you don't need to re-login after the Docker install.
