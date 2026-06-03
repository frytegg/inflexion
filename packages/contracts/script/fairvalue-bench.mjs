#!/usr/bin/env node
// P2.2 part 2 — on-node gas + accuracy benchmark of the Stylus `FairValueOracle`
// vs the Solidity reference, via a `FairValueProbe` on a local Arbitrum Nitro
// node. Mirrors script/stylus-bench.mjs (ILMath).
//
// WHY a bespoke harness: Foundry's revm can't execute Stylus WASM, so the Stylus
// branch only runs on the real Nitro node — measured via `cast call` (eth_call).
//
// Env:
//   LOCAL_RPC              L2 sequencer RPC        (default http://localhost:8547)
//   DEPLOYER_PRIVATE_KEY   funded L2 key on the dev node            (required)
//   STYLUS_FVO             deployed Stylus FairValueOracle address  (required)
//   SOL_FVO                deployed Solidity FairValueOracle (optional; deployed)
//   PROBE                  deployed FairValueProbe (optional; deployed if absent)
//
// Usage (from packages/contracts):  node script/fairvalue-bench.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = process.env.LOCAL_RPC ?? 'http://localhost:8547'
const KEY = process.env.DEPLOYER_PRIVATE_KEY
const STYLUS = process.env.STYLUS_FVO

const EXT = process.platform === 'win32' ? '.exe' : ''
const FORGE = `forge${EXT}`
const CAST = `cast${EXT}`

if (!KEY) throw new Error('DEPLOYER_PRIVATE_KEY is required')
if (!STYLUS) throw new Error('STYLUS_FVO (deployed Stylus address) is required')

const run = (bin, args) => execFileSync(bin, args, { cwd: CONTRACTS_DIR, encoding: 'utf8' })

function forgeCreate(what, ctorArgs = []) {
  const out = run(FORGE, [
    'create',
    what,
    '--rpc-url',
    RPC,
    '--private-key',
    KEY,
    '--broadcast',
    '--json',
    ...(ctorArgs.length ? ['--constructor-args', ...ctorArgs] : []),
  ])
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).deployedTo
}

function castCall(to, sig, args) {
  const out = run(CAST, ['call', to, sig, ...args.map(String), '--rpc-url', RPC])
  return out
    .trim()
    .split('\n')
    .map((l) => BigInt(l.trim().split(/\s+/)[0]))
}

// Dummy non-zero VolOracle (fairRate is pure; the vol read is never exercised here).
const DUMMY_VOL = '0x000000000000000000000000000000000000dEaD'
const SOL =
  process.env.SOL_FVO ?? forgeCreate('src/FairValueOracle.sol:FairValueOracle', [DUMMY_VOL])
const PROBE = process.env.PROBE ?? forgeCreate('script/FairValueProbe.sol:FairValueProbe')

console.log(`RPC               ${RPC}`)
console.log(`Stylus FairValue  ${STYLUS}`)
console.log(`Solidity FairValue ${SOL}`)
console.log(`FairValueProbe    ${PROBE}\n`)

const fixtures = JSON.parse(
  readFileSync(join(CONTRACTS_DIR, 'script/fairvalue_fixtures.json'), 'utf8'),
)
const sig =
  'bench(address,address,uint256,uint256,uint256,uint256)(uint256,uint256,uint256,uint256)'
const WAD = 10n ** 18n

const absdiff = (x, y) => (x > y ? x - y : y - x)
const fmtErr = (wad) => (Number(wad) / 1e18).toExponential(2) // abs error on fairRate

let worstStylus = 0n
let worstSol = 0n
const gasS = []
const gasSo = []
console.log(
  'label                       stylus≈      sol≈     |Stylus-HP|  |Sol-HP|   gasStylus  gasSol  ratio',
)
for (const f of fixtures) {
  const [vStylus, vSol, gasStylus, gasSol] = castCall(PROBE, sig, [
    STYLUS,
    SOL,
    f.a,
    f.b,
    f.sigma,
    f.dur,
  ])
  const hp = BigInt(f.hp)
  const dS = absdiff(vStylus, hp)
  const dSo = absdiff(vSol, hp)
  if (dS > worstStylus) worstStylus = dS
  if (dSo > worstSol) worstSol = dSo
  gasS.push(Number(gasStylus))
  gasSo.push(Number(gasSol))
  const ratio = Number(gasStylus) / Number(gasSol)
  console.log(
    `${f.label.padEnd(26)} ${(Number(vStylus) / 1e18).toFixed(5)}  ${(Number(vSol) / 1e18).toFixed(5)}  ` +
      `${fmtErr(dS).padStart(9)}  ${fmtErr(dSo).padStart(9)}  ${String(gasStylus).padStart(8)}  ${String(gasSol).padStart(6)}  ${ratio.toFixed(2)}x`,
  )
}

const mean = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length)
console.log(
  `\nGas (mean over ${fixtures.length}):  Stylus=${mean(gasS)}  Solidity=${mean(gasSo)}  ratio=${(mean(gasS) / mean(gasSo)).toFixed(2)}x (stylus/sol)`,
)
console.log(
  `Worst |fairRate - HP|:  Stylus=${fmtErr(worstStylus)}   Solidity(A&S)=${fmtErr(worstSol)}`,
)
console.log(
  worstStylus < 1_000_000_000_000n
    ? 'Stylus matches the closed form to machine precision (< 1e-6 wei-scale); Solidity is A&S-limited.'
    : 'WARN: Stylus accuracy worse than expected — investigate.',
)
