# Deploy guide — Inflexion backend (Render free tier)

Oracle Cloud's free A1/E2 capacity is often unavailable by region (e.g. Paris), so the
**primary path is Render** — free, no credit card, **automatic HTTPS**, and no VM / SSH /
firewall. It builds straight from `apps/backend/Dockerfile` using the committed `render.yaml`.
You can do this from **any** machine with a browser.

Paste the block below into Claude Code (or just follow it yourself). It goes **one step at a
time, waiting for your confirmation between steps**.

---

You are guiding me through deploying the **Inflexion combined backend** (REST API at `/` +
Path-B engine at `/engine`) to **Render** (free Docker web service). The repo on `main`
already has `render.yaml` and `apps/backend/Dockerfile`.

**Interaction rules:** walk me through ONE step at a time; after each, STOP and wait for me to
confirm it's done (and paste any output/errors); don't advance until the previous step
succeeded; if something errors, help me fix it first.

**Goal:** a live HTTPS backend at `https://<app>.onrender.com` (API at `/`, engine at
`/engine`); then report that URL so I can paste it back to my other Claude session to wire the
dApp + docs.

**Facts you can rely on:** `SUBGRAPH_URL` and the telemetry paths are already in `render.yaml`;
the only secret I must supply is my **Arbitrum Sepolia RPC URL**.

**Steps (one at a time, wait for my confirmation between each):**

1. **Confirm `main` is current.** `git pull` — verify `render.yaml` and `apps/backend/` exist.

2. **Create the Blueprint.** Go to <https://dashboard.render.com> → **New → Blueprint**.
   Connect the GitHub repo `frytegg/inflexion` (authorize Render the first time). Render reads
   `render.yaml` and proposes the **`inflexion-backend`** Docker web service. Apply it.

3. **Set the RPC secret.** In the service's **Environment**, set `ARBITRUM_SEPOLIA_RPC` to my
   Arbitrum Sepolia RPC URL. (`SUBGRAPH_URL`, `DEMAND_LOG`, `COMPETITION_LOG` come from
   `render.yaml`; `PORT` is injected by Render automatically.)

4. **Deploy + watch the build.** First build is ~3–5 min (it builds the monorepo). Watch the
   logs until you see `[inflexion-backend] listening on :…`.

5. **Verify.** Open `https://<app>.onrender.com/health` and
   `https://<app>.onrender.com/engine/health` — both should return `ok` JSON. The very first
   hit after idle takes ~30–60s (free-tier cold start); that's expected.

6. **Done.** Print the final `https://<app>.onrender.com` URL and remind me to send it back to
   my other Claude session to wire `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_ENGINE_URL` and flip
   the docs `/status` + roadmap to live.

**Notes / gotchas:**

- Free instances **sleep after ~15 min idle** → ~30–60s cold start on the next request. The
  dApp reads chain data directly via RPC, so the core demo is unaffected; for judging, add a
  free uptime pinger (e.g. UptimeRobot) hitting `/health` every 10 min to keep it warm.
- No persistent disk on free → telemetry resets on restart (fine; the subgraph powers the
  historical signals).
- If the Render build runs out of memory, retry — the build runs on Render's build infra, not
  the free instance.

---

## Fallbacks (if you want no cold-starts)

All use the same `apps/backend/Dockerfile`:

- **Koyeb** (free, **no sleep**): New → Docker → repo `frytegg/inflexion`, Dockerfile
  `apps/backend/Dockerfile`, set the same env vars. Auto-HTTPS on `*.koyeb.app`.
- **Fly.io** (~$2/mo, card): `fly launch --dockerfile apps/backend/Dockerfile` + set env; a
  real volume for persistent telemetry.
- **Oracle Cloud VM** (when A1 capacity returns): the `docker-compose.yml` + Caddy +
  `scripts/oracle-vm-setup.sh` path — see `apps/backend/README.md`.
