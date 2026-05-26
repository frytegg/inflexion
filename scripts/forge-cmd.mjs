#!/usr/bin/env node
// Runs `forge <args>` inside packages/contracts (so root pnpm scripts don't need cd).
import { spawnSync } from 'node:child_process'

const r = spawnSync('forge', process.argv.slice(2), {
  stdio: 'inherit',
  cwd: 'packages/contracts',
  shell: process.platform === 'win32',
})
process.exit(r.status ?? 1)
