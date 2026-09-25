import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import semver from 'semver'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The DSH runtime lines this plugin must stay installable on (ADR-079). */
const RUNTIME_LINES = ['0.1.2-rc.1', '0.1.7-rc.2']

/** DSH packages whose peer ranges the runtime compatibility gate evaluates. */
const DSH_PEERS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools']

/** @returns the parsed package manifest. */
function manifest(): { name: string; version: string; peerDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string; peerDependencies?: Record<string, string> }
}

describe('dsh peer governance (ADR-079)', () => {
  it('declares every host package the plugin binds to', () => {
    const peers = manifest().peerDependencies ?? {}
    for (const name of [...DSH_PEERS, '@deepseek-ai/cordis']) expect(peers[name]).toBeTruthy()
  })

  it('keeps the dsh peers compatible with both supported runtime lines', () => {
    const peers = manifest().peerDependencies ?? {}
    for (const name of DSH_PEERS) {
      const range = peers[name]
      expect(range, `${name} has no range`).toBeTruthy()
      for (const runtime of RUNTIME_LINES) {
        // The runtime gate evaluates prereleases against the range (includePrerelease).
        expect(semver.satisfies(runtime, range ?? '', { includePrerelease: true }), `${String(name)} ${String(range)} rejects dsh ${runtime}`).toBe(true)
      }
    }
  })

  it('keeps the cordis peer compatible with both supported runtime lines', () => {
    const peers = manifest().peerDependencies ?? {}
    const range = peers['@deepseek-ai/cordis']
    expect(range).toBeTruthy()
    for (const cordis of ['4.0.2', '4.0.4']) {
      expect(semver.satisfies(cordis, range ?? '', { includePrerelease: true }), `${String(range)} rejects cordis ${cordis}`).toBe(true)
    }
  })
})
