#!/usr/bin/env node
// Format Rust crates (Stylus). Soft-skips if cargo isn't installed (Phase 0/1 friendly).
import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const manifest = 'packages/contracts/stylus/ILMath/Cargo.toml'
if (!existsSync(manifest)) {
  console.log('fmt:rust: no Cargo.toml yet — skipping')
  process.exit(0)
}

// Probe for cargo first — `execSync` with stdio:inherit on Windows can't distinguish
// "cargo missing" (cmd.exe error) from "cargo errored", so probe explicitly.
const probe = spawnSync('cargo', ['--version'], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
})
if (probe.status !== 0) {
  console.log('fmt:rust: cargo not installed — skipping (install rustup)')
  process.exit(0)
}

const check = process.argv.includes('--check') ? ' --check' : ''
try {
  execSync(`cargo fmt --manifest-path ${manifest}${check}`, { stdio: 'inherit' })
} catch (e) {
  process.exit(e.status ?? 1)
}
