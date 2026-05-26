#!/usr/bin/env node
// Spins up a local Arbitrum Nitro dev node forking Arbitrum One.
// Clones OffchainLabs/nitro-testnode into ~/.il-swap/nitro on first run.
// Requires Docker running; on Windows requires bash (WSL or Git Bash).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = join(homedir(), '.il-swap')
const DIR = join(BASE, 'nitro')
const REPO = 'https://github.com/OffchainLabs/nitro-testnode.git'

if (!existsSync(DIR)) {
  console.log(`📥 Cloning nitro-testnode → ${DIR}`)
  if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true })
  execSync(`git clone --recurse-submodules ${REPO} "${DIR}"`, { stdio: 'inherit' })
}

console.log('🚀 Starting local Nitro dev node (Arbitrum One fork).')
console.log('   Requires Docker running. On Windows, bash via WSL or Git Bash.')
console.log('   Stop with Ctrl-C.\n')

const posixDir = DIR.replace(/\\/g, '/')
const bashCmd = './test-node.bash --init-force --no-tokenbridge --no-l3-token-bridge'

try {
  execSync(`bash -c "cd '${posixDir}' && ${bashCmd}"`, { stdio: 'inherit' })
} catch {
  console.error(
    '\n❌ dev-node failed. Checklist: Docker running? bash available (WSL/Git Bash on Windows)?',
  )
  process.exit(1)
}
