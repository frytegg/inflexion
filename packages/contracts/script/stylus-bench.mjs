#!/usr/bin/env node
// Task 2.11 (equivalence) + 2.12 (gas) — on-node cross-check of the Stylus
// `ILMath` against the Solidity reference `ILMath`, via a `StylusProbe`
// deployed to a local Arbitrum Nitro dev node.
//
// WHY a bespoke harness and not a `forge test`: Foundry's local revm cannot
// execute Stylus WASM. The Stylus branch only runs on the real Nitro node, so
// the cross-check + gas measurement happen via `cast call` (eth_call) against
// the node — using the same Foundry toolchain (`forge create`, `cast`).
//
// Env:
//   LOCAL_RPC        L2 sequencer RPC          (default http://localhost:8547)
//   DEPLOYER_PRIVATE_KEY  funded L2 key on the dev node            (required)
//   STYLUS_ILMATH    deployed Stylus ILMath address               (required)
//   SOL_ILMATH       deployed Solidity ILMath (optional; deployed if absent)
//   PROBE            deployed StylusProbe     (optional; deployed if absent)
//
// Usage (run from packages/contracts):
//   node script/stylus-bench.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = process.env.LOCAL_RPC ?? 'http://localhost:8547'
const KEY = process.env.DEPLOYER_PRIVATE_KEY
const STYLUS = process.env.STYLUS_ILMATH

// Node's execFile doesn't apply PATHEXT, so name the .exe explicitly on Windows.
const EXT = process.platform === 'win32' ? '.exe' : ''
const FORGE = `forge${EXT}`
const CAST = `cast${EXT}`

if (!KEY) throw new Error('DEPLOYER_PRIVATE_KEY is required')
if (!STYLUS) throw new Error('STYLUS_ILMATH (deployed Stylus address) is required')

const Q = (label, args) => {
  try {
    return execFileSync(FORGE, args, { cwd: CONTRACTS_DIR, encoding: 'utf8' })
  } catch (e) {
    throw new Error(`${label} failed: ${e.stderr || e.message}`)
  }
}

// ── BigInt integer sqrt → Q64.96 sqrt price (matches ILMath.t.sol _sqrtPriceX96)
function isqrt(n) {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) >> 1n
  while (y < x) {
    x = y
    y = (x + n / x) >> 1n
  }
  return x
}
const sqrtPriceX96 = (price) => isqrt(BigInt(price) << 192n)

// ── Deploy a contract with `forge create`, return its address
function forgeCreate(what) {
  const out = Q(`forge create ${what}`, [
    'create',
    what,
    '--rpc-url',
    RPC,
    '--private-key',
    KEY,
    '--broadcast',
    '--json',
  ])
  // forge prints a banner line before the JSON on some versions; grab the JSON object.
  const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  return json.deployedTo
}

// ── cast call → array of BigInt return values
function castCall(to, sig, args) {
  const out = execFileSync(CAST, ['call', to, sig, ...args.map(String), '--rpc-url', RPC], {
    cwd: CONTRACTS_DIR,
    encoding: 'utf8',
  })
  // Each return value on its own line; cast may append a hex form in parens — take the leading decimal.
  return out
    .trim()
    .split('\n')
    .map((l) => BigInt(l.trim().split(/\s+/)[0]))
}

const SOL = process.env.SOL_ILMATH ?? forgeCreate('src/ILMath.sol:ILMath')
const PROBE = process.env.PROBE ?? forgeCreate('script/StylusProbe.sol:StylusProbe')

console.log(`RPC          ${RPC}`)
console.log(`Stylus ILMath ${STYLUS}`)
console.log(`Solidity ILMath ${SOL}`)
console.log(`StylusProbe  ${PROBE}\n`)

// price, Pa, Pb, L — same family as ILMath.t.sol (P0=100, Pa=80, Pb=125)
const FIXTURES = [
  { name: 'canonical [80,100,125] L=1e18', P: 100, Pa: 80, Pb: 125, L: 10n ** 18n },
  { name: 'tight [90,100,110] L=1e18', P: 100, Pa: 90, Pb: 110, L: 10n ** 18n },
  { name: 'eth-scale [1500,2000,2500] L=5e18', P: 2000, Pa: 1500, Pb: 2500, L: 5n * 10n ** 18n },
]
// Anchor: canonical MaxIL from quant/tests/test_il.py (× 1e18 scaling)
const ANCHOR_MAXIL = 139_320_225_002_101_320n
const TOL = 10_000n // wei — same tolerance band as test_fixture_maxIL_matchesPython

const sig =
  'bench(address,address,uint256,uint256,uint256,uint128)(uint256,uint256,uint256,uint256)'
let failures = 0
const rows = []

for (const f of FIXTURES) {
  const [vStylus, vSol, gasStylus, gasSol] = castCall(PROBE, sig, [
    STYLUS,
    SOL,
    sqrtPriceX96(f.P),
    sqrtPriceX96(f.Pa),
    sqrtPriceX96(f.Pb),
    f.L,
  ])
  const diff = vStylus > vSol ? vStylus - vSol : vSol - vStylus
  const ratio = gasSol === 0n ? 0 : Number(gasStylus) / Number(gasSol)
  const ok = diff <= TOL
  if (!ok) failures++
  rows.push({ name: f.name, vStylus, vSol, diff, gasStylus, gasSol, ratio, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${f.name}`)
  console.log(`     stylus=${vStylus}  sol=${vSol}  |diff|=${diff} wei`)
  console.log(
    `     gas: stylus=${gasStylus}  sol=${gasSol}  ratio=${ratio.toFixed(2)}x (stylus/sol)`,
  )
}

// Anchor check on the canonical fixture's Solidity value
const anchorDiff =
  rows[0].vSol > ANCHOR_MAXIL ? rows[0].vSol - ANCHOR_MAXIL : ANCHOR_MAXIL - rows[0].vSol
console.log(
  `\nAnchor (canonical MaxIL vs quant fixture): sol=${rows[0].vSol} expected≈${ANCHOR_MAXIL} |diff|=${anchorDiff} wei`,
)
if (anchorDiff > TOL) {
  failures++
  console.log('FAIL anchor diff exceeds tolerance')
}

const avgRatio = rows.reduce((s, r) => s + r.ratio, 0) / rows.length
console.log(`\nMean gas ratio (stylus/sol) over ${rows.length} fixtures: ${avgRatio.toFixed(2)}x`)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll equivalence checks passed.')
