/**
 * `DepositorClient` — the passive + active depositor surface (DEP-1..DEP-7).
 *
 * This is the **claim (B)** surface: every state/yield result it returns carries
 * `capitalNotGuaranteed: true`. The two depositor claims are NEVER merged here —
 * the LP-payout claim (A) "LPs are always paid, no bad debt in FULL (I1)" lives on
 * the LP surface; this module only ever speaks claim (B): "depositor capital is
 * NOT guaranteed (junior is first-loss; senior is structurally protected from
 * underwriting loss only, not the systemic tail)." See README_CLAIMS below.
 *
 * Reads come from the deployed `ConvexityVault` (Path-A pooled cvAMM underwriter):
 *   - `inventory()`            → (total, locked, free, utilWad, concWad)
 *   - `seniorAssets()`/`juniorAssets()`  (public state getters)
 *   - `lockedByMarket(id)`     per CALLER-supplied marketId (flagged: pool-wide free
 *                              capacity is fungible; lockedByMarket is HHI/concentration
 *                              colour, NOT a per-market budget — §DEP-1/8.2)
 *   - `VolOracle.sigmaRef(token)` for the σ_ref the load stack bands against
 *
 * The component skews (baseLoad / utilSkew / dispSkew / total) come from the
 * `math.ts` `CvammPricing` TS port (parity-locked byte-equal to the deployed lib in
 * math.parity.test.ts). The on-chain `CvammPricing.loadComponents` IS deployed but
 * is DELEGATECALL-ONLY — a direct eth_call to it reverts — so the TS port is the
 * PERMANENT canonical source for the per-component decomposition; the lib runs
 * on-chain only via the core's delegatecall during pricing.
 *
 * GRACEFUL DEGRADATION: every read that can fail returns a typed degraded result
 * rather than throwing. `instYieldWad` is `undefined` until a subgraph is wired.
 * `getVaultState` returns `Degraded<VaultState>` — `{ available:false, reason }` when
 * the σ_ref read reverts (VolOracle uninitialized) or no RPC transport is reachable.
 * Writes return a typed envelope describing whether they were SENT or DEFERRED.
 */
import {
  encodeFunctionData,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { convexityVaultAbi, erc20Abi, inflexionCoreAbi, volOracleAbi } from './abis.js'
import { core, tokens } from './addresses.js'
import { loadComponents, regimeOf } from './math.js'
import { decodeLoadParams } from './decode.js'
import type {
  Degraded,
  DepositorPosition,
  LoadParams,
  Tranche,
  VaultState,
  WithdrawRequest,
} from './types.js'
import { TRANCHE_ENUM } from './types.js'

// ─── The two never-merged depositor claims (verbatim, attached to every surface) ──

/** CLAIM (B) — carried by every state/yield surface in this module. */
export const DEPOSITOR_CLAIM_B =
  'Depositor capital is NOT guaranteed. Junior is first-loss and captures most of ' +
  'the premium; senior is structurally protected from underwriting loss only (the ' +
  'junior-first waterfall, totalLocked ≤ juniorAssets), NOT from a systemic tail ' +
  '(USDC depeg, oracle/settlement failure, contract bug).'

/** CLAIM (A) — the LP-payout claim. Exposed here ONLY so callers can see it is
 *  DISTINCT and is never folded into a depositor yield/NAV field. The LP surface
 *  is where it is actually asserted. */
export const LP_CLAIM_A =
  'LPs are always paid — no bad debt in FULL (invariant I1), qualified by: capped ' +
  'payout + solvent USDC + oracle/settlement liveness. This is the LP surface claim ' +
  'and is NEVER merged into any depositor yield/NAV figure (claim B).'

// ─── Write-result envelope (graceful: a missing signer DEFERS, never throws) ──

/** A built-and-maybe-sent transaction. `status` reports SENT vs DEFERRED. */
export interface WriteResult {
  /** The encoded tx (always present, even when deferred). */
  tx: { to: Address; data: Hex; value: bigint }
  /** Tx hash iff it was actually broadcast. */
  txHash?: Hex
  status: 'sent' | 'deferred-no-wallet' | 'error'
  detail?: string
}

/** A staged multi-step write (used by `rebalance`, which has a cooldown in the
 *  middle and so cannot be a single tx). Each step is an independent WriteResult. */
export interface StagedWrite {
  steps: Array<{ label: string; result: WriteResult }>
  /** Always attached — rebalance crosses a withdrawal cooldown and cannot atomically settle. */
  note: string
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface DepositorClientOptions {
  /** The read client (required for reads). */
  publicClient: PublicClient
  /** The write client (optional — its absence DEFERS writes, never throws). */
  walletClient?: WalletClient
  /** Override the ConvexityVault address (defaults to the registry). */
  vaultAddress?: Address
  /** Override the VolOracle address (defaults to the registry). */
  volOracleAddress?: Address
  /** Override the USDC token (defaults to the registry; used for deposit approvals). */
  usdcAddress?: Address
  /** The oracle token the σ_ref / load stack is banded against (defaults to demoWeth). */
  sigmaToken?: Address
}

// ─── DepositorClient ──────────────────────────────────────────────────────────

export class DepositorClient {
  private readonly pub: PublicClient
  private readonly wallet: WalletClient | undefined
  private readonly vault: Address
  private readonly volOracle: Address
  private readonly usdc: Address
  private readonly sigmaToken: Address
  /** Cached loadParams (immutable post-freeze) — read once, reused across calls. */
  private loadParamsCache?: LoadParams

  constructor(opts: DepositorClientOptions) {
    this.pub = opts.publicClient
    this.wallet = opts.walletClient
    this.vault = opts.vaultAddress ?? core.convexityVault
    this.volOracle = opts.volOracleAddress ?? core.volOracle
    // USDC the vault holds — fall back to the registry USDC if not injected.
    this.usdc = opts.usdcAddress ?? defaultUsdc()
    // The demo markets band the σ_ref against dWETH; allow override for other pairs.
    this.sigmaToken = opts.sigmaToken ?? defaultSigmaToken()
  }

  // ─── loadParams (cached) ────────────────────────────────────────────────

  /** Read + cache `InflexionCore.loadParams()` (the cvAMM block; immutable post-freeze). */
  async getLoadParams(): Promise<LoadParams> {
    if (this.loadParamsCache !== undefined) return this.loadParamsCache
    const tuple = await this.pub.readContract({
      address: core.inflexionCore,
      abi: inflexionCoreAbi,
      functionName: 'loadParams',
      args: [],
    })
    const p = decodeLoadParams(tuple as Parameters<typeof decodeLoadParams>[0])
    this.loadParamsCache = p
    return p
  }

  // ─── DEP-1 / DEP-6: fine pool state ─────────────────────────────────────

  /**
   * Fine pool state — the DEP-1/DEP-6 composite. Returns a `Degraded<VaultState>`:
   * `{ available:false, reason }` when the σ_ref read reverts (VolOracle not
   * initialized for the token) or there is no reachable RPC. The component skews
   * come from the `math.ts` CvammPricing port (parity-tested).
   *
   * `marketIds` is CALLER-SUPPLIED and the resulting `lockedByMarket` is flagged
   * (the field name carries it; see the doc-comment) — free collateral is fungible
   * across all markets, so per-market free capacity is intentionally NOT exposed.
   */
  async getVaultState(opts?: { marketIds?: Hex[] }): Promise<Degraded<VaultState>> {
    let inv: readonly [bigint, bigint, bigint, bigint, bigint]
    let seniorAssets: bigint
    let juniorAssets: bigint
    let params: LoadParams
    try {
      const [invRaw, sa, ja, p] = await Promise.all([
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'inventory',
          args: [],
        }),
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'seniorAssets',
          args: [],
        }),
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'juniorAssets',
          args: [],
        }),
        this.getLoadParams(),
      ])
      inv = invRaw
      seniorAssets = sa
      juniorAssets = ja
      params = p
    } catch (e) {
      return { available: false, reason: degradeMessage('no-rpc', e) }
    }

    const [totalAssets, totalLocked, freeAssets, utilWad, concWad] = inv

    // σ_ref REVERTS if the VolOracle is uninitialized for the token → degrade.
    let sigmaRefWad: bigint
    try {
      sigmaRefWad = await this.pub.readContract({
        address: this.volOracle,
        abi: volOracleAbi,
        functionName: 'sigmaRef',
        args: [this.sigmaToken],
      })
    } catch (e) {
      return { available: false, reason: degradeMessage('vol-uninitialized', e) }
    }

    // Component skews from the TS port. `util = uWad`, `conc = hWad` (the HHI).
    const breakdown = loadComponents(sigmaRefWad, utilWad, concWad, params)
    const regime = regimeOf(sigmaRefWad, params)

    // Per-market locked — ONLY the caller-supplied ids (the field is for HHI/
    // concentration colour, NOT a per-market budget — free is pool-wide fungible).
    const lockedByMarket: Record<string, bigint> = {}
    const ids = opts?.marketIds ?? []
    if (ids.length > 0) {
      const locks = await Promise.all(
        ids.map((id) =>
          this.pub
            .readContract({
              address: this.vault,
              abi: convexityVaultAbi,
              functionName: 'lockedByMarket',
              args: [id],
            })
            .catch(() => undefined),
        ),
      )
      for (let i = 0; i < ids.length; i++) {
        const v = locks[i]
        // Skip a read that reverted rather than failing the whole composite.
        if (v !== undefined) lockedByMarket[ids[i] as string] = v
      }
    }

    const state: VaultState = {
      totalAssets,
      seniorAssets,
      juniorAssets,
      totalLocked,
      freeAssets,
      utilWad,
      concWad,
      baseLoadWad: breakdown.baseLoadWad,
      utilSkewWad: breakdown.utilSkewWad,
      dispSkewWad: breakdown.dispSkewWad,
      totalLoadWad: breakdown.totalLoadWad,
      lockedByMarket,
      sigmaRefWad,
      regime,
      // instYieldWad needs PremiumAccrued history → subgraph; undefined from live SDK.
      // (Left off entirely under exactOptionalPropertyTypes; readers treat absent = unknown.)
      capitalNotGuaranteed: true,
    }
    return { available: true, ...state }
  }

  // ─── DEP-3: my position (shares / assets / withdrawal queue) ─────────────

  /**
   * Depositor position — shares, NAV-converted assets, and any pending withdrawal
   * request per tranche. Returns a `Degraded<DepositorPosition>` if no RPC is
   * reachable. There is NO per-depositor "realized yield" getter on-chain — that
   * is a subgraph field (flagged: cumulative yield is absent from this live result).
   */
  async getPosition(owner: Address): Promise<Degraded<DepositorPosition>> {
    try {
      const [seniorShares, juniorShares, seniorWdRaw, juniorWdRaw] = await Promise.all([
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'seniorBalanceOf',
          args: [owner],
        }),
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'juniorBalanceOf',
          args: [owner],
        }),
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'seniorWithdraw',
          args: [owner],
        }),
        this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'juniorWithdraw',
          args: [owner],
        }),
      ])

      const [seniorAssets, juniorAssets] = await Promise.all([
        this.convertToAssets('senior', seniorShares),
        this.convertToAssets('junior', juniorShares),
      ])

      const now = BigInt(Math.floor(Date.now() / 1000))
      const base: DepositorPosition = {
        seniorShares,
        juniorShares,
        seniorAssets,
        juniorAssets,
        capitalNotGuaranteed: true,
      }
      const seniorWithdraw = toWithdrawRequest(seniorWdRaw, now)
      const juniorWithdraw = toWithdrawRequest(juniorWdRaw, now)
      const position: DepositorPosition =
        seniorWithdraw !== undefined && juniorWithdraw !== undefined
          ? { ...base, seniorWithdraw, juniorWithdraw }
          : seniorWithdraw !== undefined
            ? { ...base, seniorWithdraw }
            : juniorWithdraw !== undefined
              ? { ...base, juniorWithdraw }
              : base
      return { available: true, ...position }
    } catch (e) {
      return { available: false, reason: degradeMessage('no-rpc', e) }
    }
  }

  /** NAV-convert a share balance for a tranche (`convertToAssets`). */
  async convertToAssets(tranche: Tranche, shares: bigint): Promise<bigint> {
    if (shares === 0n) return 0n
    return this.pub.readContract({
      address: this.vault,
      abi: convexityVaultAbi,
      functionName: 'convertToAssets',
      args: [TRANCHE_ENUM[tranche], shares],
    })
  }

  /** The withdrawal cooldown (seconds) the vault enforces. */
  async getWithdrawalCooldown(): Promise<bigint> {
    return this.pub.readContract({
      address: this.vault,
      abi: convexityVaultAbi,
      functionName: 'withdrawalCooldown',
      args: [],
    })
  }

  // ─── DEP-7: regime (for senior↔junior rebalancing decisions) ────────────

  /**
   * The vol REGIME (calm/normal/stressed) — banded from σ_ref vs the loadParams
   * regime bands (NOT `sigmaComponents.binding`, which is which-EWMA-window-binds).
   * Returns a typed degraded result if σ_ref reverts (VolOracle uninitialized).
   */
  async getRegime(): Promise<
    | { available: true; regime: VaultState['regime']; sigmaRefWad: bigint }
    | { available: false; reason: string }
  > {
    try {
      const [sigmaRefWad, params] = await Promise.all([
        this.pub.readContract({
          address: this.volOracle,
          abi: volOracleAbi,
          functionName: 'sigmaRef',
          args: [this.sigmaToken],
        }),
        this.getLoadParams(),
      ])
      return { available: true, regime: regimeOf(sigmaRefWad, params), sigmaRefWad }
    } catch (e) {
      return { available: false, reason: degradeMessage('vol-uninitialized', e) }
    }
  }

  // ─── DEP-5: watch utilization (poll; trigger a deposit above a threshold) ──

  /**
   * Poll `utilizationWad()` on an interval; invoke `cb(util)` each tick, and call
   * `onThreshold` once when util first crosses `thresholdWad`. Returns a stop fn.
   * Errors during a poll are swallowed (graceful) and reported via `onError`.
   */
  watchUtilization(
    thresholdWad: bigint,
    handlers: {
      onTick?: (utilWad: bigint) => void
      onThreshold?: (utilWad: bigint) => void
      onError?: (err: unknown) => void
    },
    opts?: { intervalMs?: number },
  ): () => void {
    const intervalMs = opts?.intervalMs ?? 12_000
    let fired = false
    let stopped = false

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const util = await this.pub.readContract({
          address: this.vault,
          abi: convexityVaultAbi,
          functionName: 'utilizationWad',
          args: [],
        })
        handlers.onTick?.(util)
        if (!fired && util >= thresholdWad) {
          fired = true
          handlers.onThreshold?.(util)
        } else if (fired && util < thresholdWad) {
          // re-arm so a later re-crossing fires again
          fired = false
        }
      } catch (e) {
        handlers.onError?.(e)
      }
    }

    void tick()
    const handle = setInterval(() => void tick(), intervalMs)
    return () => {
      stopped = true
      clearInterval(handle)
    }
  }

  // ─── DEP-2 / DEP-4: writes (deposit / requestWithdrawal / withdraw) ──────

  /** Build the deposit calldata (no send) — handy for batching / inspection. */
  buildDeposit(tranche: Tranche, amount: bigint): { to: Address; data: Hex; value: bigint } {
    const data = encodeFunctionData({
      abi: convexityVaultAbi,
      functionName: 'deposit',
      args: [TRANCHE_ENUM[tranche], amount],
    })
    return { to: this.vault, data, value: 0n }
  }

  /** Build the USDC `approve(vault, amount)` calldata (a deposit pre-step). */
  buildApprove(amount: bigint): { to: Address; data: Hex; value: bigint } {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [this.vault, amount],
    })
    return { to: this.usdc, data, value: 0n }
  }

  /**
   * Deposit into a tranche. If `autoApprove` is set and the current allowance is
   * short, an `approve(vault, amount)` is sent first. Returns a `WriteResult` —
   * a missing wallet DEFERS (returns the built tx) rather than throwing.
   */
  async deposit(
    tranche: Tranche,
    amount: bigint,
    opts?: { autoApprove?: boolean; owner?: Address },
  ): Promise<WriteResult> {
    if (opts?.autoApprove) {
      const owner = opts.owner ?? this.wallet?.account?.address
      if (owner !== undefined) {
        try {
          const allowance = await this.pub.readContract({
            address: this.usdc,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner, this.vault],
          })
          if (allowance < amount) {
            const approveRes = await this.send(this.buildApprove(amount))
            // If the approve could not be sent (no wallet), surface that on deposit too.
            if (approveRes.status !== 'sent') return approveRes
          }
        } catch (e) {
          return { tx: this.buildDeposit(tranche, amount), status: 'error', detail: errMsg(e) }
        }
      }
    }
    return this.send(this.buildDeposit(tranche, amount))
  }

  /** Queue a withdrawal of `shares` from `tranche` (cooldown-gated on-chain). */
  async requestWithdrawal(tranche: Tranche, shares: bigint): Promise<WriteResult> {
    const data = encodeFunctionData({
      abi: convexityVaultAbi,
      functionName: 'requestWithdrawal',
      args: [TRANCHE_ENUM[tranche], shares],
    })
    return this.send({ to: this.vault, data, value: 0n })
  }

  /**
   * Claim a matured withdrawal from `tranche`. The junior-≥-locked gate is enforced
   * on-chain (the vault reverts `JuniorBelowLocked` if it would breach senior
   * protection); we surface that revert as a typed `error` WriteResult.
   */
  async withdraw(tranche: Tranche): Promise<WriteResult> {
    const data = encodeFunctionData({
      abi: convexityVaultAbi,
      functionName: 'withdraw',
      args: [TRANCHE_ENUM[tranche]],
    })
    return this.send({ to: this.vault, data, value: 0n })
  }

  // ─── DEP-7: rebalance senior↔junior (staged across the cooldown) ─────────

  /**
   * Rebalance `shares` from one tranche to another. There is NO atomic on-chain
   * rebalance — it is `requestWithdrawal(from)` → (wait the cooldown) →
   * `withdraw(from)` → `deposit(to)`. This helper SENDS step 1 (the request) now
   * and returns the BUILT (un-sent) steps 2 & 3 plus the unlock time, because the
   * cooldown sits between them. The caller drives step 2/3 after `unlockAt`.
   *
   * `toAmount` for the deposit cannot be known until the withdraw executes (NAV at
   * claim time); the returned deposit step is therefore a TEMPLATE the caller
   * finalises with the actually-withdrawn amount. Documented in `note`.
   */
  async rebalance(from: Tranche, to: Tranche, shares: bigint): Promise<StagedWrite> {
    if (from === to) {
      return {
        steps: [],
        note: 'rebalance no-op: from === to.',
      }
    }
    const requestRes = await this.requestWithdrawal(from, shares)

    // Build (do not send) the follow-up steps. The deposit amount is a placeholder
    // (0) — the caller substitutes the real withdrawn assets after step 2.
    const withdrawTx = {
      to: this.vault,
      data: encodeFunctionData({
        abi: convexityVaultAbi,
        functionName: 'withdraw',
        args: [TRANCHE_ENUM[from]],
      }),
      value: 0n,
    }
    const depositTx = this.buildDeposit(to, 0n)

    return {
      steps: [
        { label: `requestWithdrawal(${from}, ${shares})`, result: requestRes },
        {
          label: `withdraw(${from}) — SEND AFTER cooldown`,
          result: { tx: withdrawTx, status: 'deferred-no-wallet' },
        },
        {
          label: `deposit(${to}, <withdrawn assets>) — finalise amount post-withdraw`,
          result: { tx: depositTx, status: 'deferred-no-wallet' },
        },
      ],
      note:
        'Rebalance is staged across the withdrawal cooldown: step 1 (requestWithdrawal) ' +
        'is sent now; steps 2 (withdraw) and 3 (deposit) are returned as built txs to be ' +
        'sent after unlockAt. The step-3 deposit amount is a placeholder (0) — substitute ' +
        'the actual assets returned by step 2. Junior-≥-locked is enforced on-chain at withdraw.',
    }
  }

  // ─── Internal send (graceful: no wallet → DEFERRED, never throws) ────────

  private async send(tx: { to: Address; data: Hex; value: bigint }): Promise<WriteResult> {
    const wallet = this.wallet
    const account: Account | undefined = wallet?.account
    if (wallet === undefined || account === undefined) {
      return { tx, status: 'deferred-no-wallet' }
    }
    try {
      const txHash = await wallet.sendTransaction({
        account,
        chain: wallet.chain ?? null,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      })
      return { tx, txHash, status: 'sent' }
    } catch (e) {
      return { tx, status: 'error', detail: errMsg(e) }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map a `(shares, unlockAt)` withdraw tuple to a `WithdrawRequest`, or undefined
 *  when there is no pending request (shares == 0). */
function toWithdrawRequest(
  raw: readonly [bigint, bigint],
  now: bigint,
): WithdrawRequest | undefined {
  const [shares, unlockAt] = raw
  if (shares === 0n) return undefined
  const secondsRemaining = unlockAt > now ? unlockAt - now : 0n
  return { shares, unlockAt, secondsRemaining }
}

/** Build a stable degrade message from a reason + an optional caught error. */
function degradeMessage(reason: string, e?: unknown): string {
  return e === undefined ? reason : `${reason}: ${errMsg(e)}`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The registry USDC the vault settles in (the demo numéraire dUSDC on the live
 *  deploy — the markets settle against it). Overridable via `usdcAddress` opt. */
function defaultUsdc(): Address {
  return tokens.demoUsdc
}

/** The oracle token the σ_ref / load bands key off (demoWeth on the live deploy). */
function defaultSigmaToken(): Address {
  return tokens.demoWeth
}
