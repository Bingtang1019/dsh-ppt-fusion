import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
// The declared lines and the union they produce live in one module (ADR-090): the generator
// writes package.json from it and `pnpm prepack` refuses a manifest that drifted.
import { COVERED_PATCH_LINES, DSH_PEERS, RUNTIME_LINES, dshPeerRange, governanceProblems, unsupportedLines } from '../scripts/runtime-lines.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns the parsed package manifest. */
function manifest(): { name: string; version: string; peerDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string; peerDependencies?: Record<string, string> }
}

describe('dsh peer governance (ADR-079, ADR-090)', () => {
  it('declares every host package the plugin binds to', () => {
    const peers = manifest().peerDependencies ?? {}
    for (const name of [...DSH_PEERS, '@deepseek-ai/cordis']) expect(peers[name]).toBeTruthy()
  })

  it('carries exactly the union the declared lines generate', () => {
    const peers = manifest().peerDependencies ?? {}
    const generated = dshPeerRange(COVERED_PATCH_LINES)
    for (const name of DSH_PEERS) {
      expect(peers[name], `${name} differs from the generated union; run \`node scripts/gen-peer-union.mjs\``).toBe(generated)
    }
  })

  it('keeps the declared lists consistent', () => {
    expect(governanceProblems(RUNTIME_LINES, COVERED_PATCH_LINES)).toEqual([])
  })

  it('keeps the dsh peers compatible with every supported runtime line', () => {
    const peers = manifest().peerDependencies ?? {}
    for (const name of DSH_PEERS) {
      const range = peers[name]
      expect(range, `${name} has no range`).toBeTruthy()
      for (const runtime of RUNTIME_LINES) {
        // The runtime gate evaluates prereleases against the range (includePrerelease).
        expect(semver.satisfies(runtime, range ?? '', { includePrerelease: true }), `${String(name)} ${String(range)} rejects dsh ${runtime}`).toBe(true)
        // npm/pnpm do NOT include prereleases unless a comparator carries the same
        // major.minor.patch tuple with its own prerelease tag, so the range needs an
        // explicit branch per supported minor line (awesome-dsh-plugin's rule). A new
        // supported line must extend the union here or npm installs break.
        expect(semver.satisfies(runtime, range ?? ''), `${String(name)} ${String(range)} does not admit ${runtime} under npm semantics`).toBe(true)
      }
    }
  })

  it('keeps the cordis peer compatible with the runtimes the plugin boots in', () => {
    const peers = manifest().peerDependencies ?? {}
    const range = peers['@deepseek-ai/cordis']
    expect(range).toBeTruthy()
    for (const cordis of ['4.0.2', '4.0.4']) {
      expect(semver.satisfies(cordis, range ?? '', { includePrerelease: true }), `${String(range)} rejects cordis ${cordis}`).toBe(true)
    }
  })

  it('does not admit the next unmeasured lines', () => {
    const peers = manifest().peerDependencies ?? {}
    for (const name of DSH_PEERS) {
      const range = peers[name] ?? ''
      for (const line of unsupportedLines(COVERED_PATCH_LINES)) {
        expect(semver.satisfies(line, range), `${String(name)} ${range} silently admits the unmeasured line ${line}`).toBe(false)
        expect(semver.satisfies(line, range, { includePrerelease: true }), `${String(name)} ${range} silently admits ${line} at the gate`).toBe(false)
      }
    }
  })
})