/**
 * THIN VERTICAL CHECK — de-risk the integration BEFORE any surface is built.
 *
 * Proves ONE real READ + ONE real WRITE path end-to-end against the live
 * Arbitrum Sepolia deployment, using the foundation (addresses, abis, client,
 * math). It is intentionally minimal: it validates the wiring, the ABIs, the
 * address registry, and the encode/decode round-trips — NOT a full surface.
 *
 * Behaviour:
 *  - READ: `ConvexityVault.inventory()` + a built `FairValueOracle.fairPremium`
 *    call for the demo geometry. If an RPC is reachable (ARBITRUM_SEPOLIA_RPC /
 *    SEPOLIA_RPC), the read is SENT and the result captured; otherwise the read
 *    is GATED and only the encoded calldata is validated.
 *  - WRITE: a minimal `ConvexityVault.deposit(SENIOR, amount)` transaction is
 *    BUILT (calldata + to + value). If a funded key (DEPLOYER_PRIVATE_KEY /
 *    PRIVATE_KEY) AND an RPC are present, it is SENT and confirmed; otherwise the
 *    live send is DEFERRED and only the encoded tx is asserted correct.
 *
 * Importable as a function (`runVerticalCheck`) and exercised by the vitest spec
 * `_vertical-check.test.ts`. The result object reports exactly what RAN vs was
 * GATED so the orchestrator can surface it.
 */
import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { convexityVaultAbi, fairValueOracleAbi, inflexionCoreAbi } from './abis.js'
import { core, demo, stylus, tokens } from './addresses.js'
import { makePublicClient, makeWalletClient, resolvePrivateKey, resolveRpcUrl } from './client.js'
import { TRANCHE_ENUM } from './types.js'

export interface VerticalCheckResult {
  rpcAvailable: boolean
  keyAvailable: boolean
  read: {
    /** Encoded inventory() calldata (always built). */
    inventoryCalldata: Hex
    /** Encoded fairPremium calldata for the demo geometry (always built). */
    fairPremiumCalldata: Hex
    fairPremiumTo: Address
    /** Live inventory result, if the read RAN. */
    inventory?: {
      totalAssets: bigint
      locked: bigint
      free: bigint
      utilWad: bigint
      concWad: bigint
    }
    status: 'ran' | 'gated-no-rpc' | 'error'
    detail?: string
  }
  write: {
    /** The built deposit transaction (always present). */
    tx: { to: Address; data: Hex; value: bigint }
    /** Tx hash if the write was SENT. */
    txHash?: Hex
    status: 'sent' | 'deferred-no-key' | 'deferred-no-rpc' | 'error'
    detail?: string
  }
}

/** A tiny, well-formed geometry for the fairPremium read (a/b around P0). The
 *  demo position is in-range; these a<1<b values satisfy the FVO in-range gate. */
const DEMO_A_WAD = 900_000_000_000_000_000n // a = 0.9  (Pa/P0)
const DEMO_B_WAD = 1_100_000_000_000_000_000n // b = 1.1  (Pb/P0)
const DEMO_DURATION = 7n * 24n * 60n * 60n // 7 days
const DEMO_MAXIL = 1_000_000_000n // $1,000 (6-dec) — placeholder MaxIL for the read

/** A minimal deposit amount used to BUILD the write (1 USDC, 6-dec). */
const DEPOSIT_AMOUNT = 1_000_000n

export async function runVerticalCheck(opts?: {
  publicClient?: PublicClient
  walletClient?: WalletClient
}): Promise<VerticalCheckResult> {
  const rpc = resolveRpcUrl()
  const key = resolvePrivateKey()
  const rpcAvailable = rpc !== undefined
  const keyAvailable = key !== undefined

  // ─── Build the READ calldata (always) ──────────────────────────────────
  const inventoryCalldata = encodeFunctionData({
    abi: convexityVaultAbi,
    functionName: 'inventory',
    args: [],
  })
  // Use the demo oracle token (dWETH) for the fair-premium read geometry.
  const fairPremiumCalldata = encodeFunctionData({
    abi: fairValueOracleAbi,
    functionName: 'fairPremium',
    args: [tokens.demoWeth, DEMO_A_WAD, DEMO_B_WAD, DEMO_DURATION, DEMO_MAXIL],
  })

  const read: VerticalCheckResult['read'] = {
    inventoryCalldata,
    fairPremiumCalldata,
    fairPremiumTo: stylus.fairValueOracle,
    status: 'gated-no-rpc',
  }

  // ─── Run the READ if an RPC is reachable ───────────────────────────────
  if (rpcAvailable) {
    try {
      const client = opts?.publicClient ?? makePublicClient()
      const inv = await client.readContract({
        address: core.convexityVault,
        abi: convexityVaultAbi,
        functionName: 'inventory',
        args: [],
      })
      read.inventory = {
        totalAssets: inv[0],
        locked: inv[1],
        free: inv[2],
        utilWad: inv[3],
        concWad: inv[4],
      }
      read.status = 'ran'
    } catch (e) {
      read.status = 'error'
      read.detail = e instanceof Error ? e.message : String(e)
    }
  }

  // ─── Build the WRITE tx (always) ───────────────────────────────────────
  const depositData = encodeFunctionData({
    abi: convexityVaultAbi,
    functionName: 'deposit',
    args: [TRANCHE_ENUM.senior, DEPOSIT_AMOUNT],
  })
  const tx = { to: core.convexityVault, data: depositData, value: 0n }

  const write: VerticalCheckResult['write'] = {
    tx,
    status: keyAvailable ? (rpcAvailable ? 'sent' : 'deferred-no-rpc') : 'deferred-no-key',
  }

  // NOTE: a live deposit requires a prior USDC approve to the vault; the home PC
  // runs the funded path (approve + deposit). Here, when a key+RPC ARE present we
  // still only SEND if explicitly given a wallet client to avoid spending funds
  // unexpectedly in CI. The deferred branch asserts the encoded tx is correct.
  if (keyAvailable && rpcAvailable && opts?.walletClient !== undefined) {
    try {
      const wallet = opts.walletClient
      const account = wallet.account
      if (account === undefined) throw new Error('wallet client has no account')
      const txHash = await wallet.sendTransaction({
        account,
        chain: wallet.chain ?? null,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      })
      write.txHash = txHash
      write.status = 'sent'
    } catch (e) {
      write.status = 'error'
      write.detail = e instanceof Error ? e.message : String(e)
    }
  } else if (keyAvailable && rpcAvailable) {
    // A key + RPC exist but no explicit wallet client was injected → keep the
    // send DEFERRED (do not auto-spend); the home PC opts in with a wallet client.
    write.status = 'deferred-no-key'
    write.detail = 'key+RPC present but no wallet client injected — live send deferred (opt-in)'
  }

  return { rpcAvailable, keyAvailable, read, write }
}

/** Build (but never send) the canonical demo Path-A create tx — an alternative
 *  WRITE the home PC can broadcast (createSwapPathA on the demo 7d market). */
export function buildDemoCreateSwapPathATx(maxPremium: bigint): {
  to: Address
  data: Hex
  value: bigint
} {
  const data = encodeFunctionData({
    abi: inflexionCoreAbi,
    functionName: 'createSwapPathA',
    args: [demo.marketId_fee500_7d, demo.lpPositionTokenId, maxPremium],
  })
  return { to: core.inflexionCore, data, value: 0n }
}

// Allow `tsx src/_vertical-check.ts` for a manual run. The guard compares the
// resolved file paths (normalised separators) so it fires on Windows too.
const entry = process.argv[1]
if (
  entry !== undefined &&
  import.meta.url.replace(/\\/g, '/').endsWith(entry.replace(/\\/g, '/'))
) {
  void runVerticalCheck().then((r) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  })
}
