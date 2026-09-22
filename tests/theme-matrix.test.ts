import { describe, expect, it } from 'vitest'
import { MATRIX_THEMES, compareMatrix, type ThemeMatrix, type ThemeSnapshot } from './theme-matrix.ts'

/** @returns a snapshot that only the fingerprint distinguishes. */
function snapshot(fingerprint: string): ThemeSnapshot {
  return {
    validate: { ok: true, sources: ['manifest'], findings: [] },
    render: {
      slides: 2,
      merge: { replaced: 0, imported: 0, multiMaster: false },
      compat: { level: 'standard', counts: { occurrences: 2, downgrades: 0, stamps: 0, warnings: 0 } },
      postflight: { status: 'none', qualityGate: 'none', slides: 0 },
      artifacts: { base: fingerprint, deep: null, merged: fingerprint },
    },
    audit: { ok: true, sources: ['manifest'], findings: [], skipped: [] },
    paletteFindings: 0,
    fingerprint,
  }
}

/** @returns a recorded matrix whose six themes all share one fingerprint. */
function matrix(overrides: Partial<ThemeMatrix> = {}): ThemeMatrix {
  return {
    schemaVersion: 1,
    fixtureVersion: 1,
    upstream: { pptwise: '0.35.0', 'ppt-master': '0.1.128' },
    themes: Object.fromEntries(MATRIX_THEMES.map((theme) => [theme, snapshot('a'.repeat(64))])),
    ...overrides,
  }
}

describe('compareMatrix', () => {
  it('reports no problem for an identical matrix', () => {
    expect(compareMatrix(matrix(), matrix())).toEqual([])
  })

  it('fails the gate when an upstream pin changes', () => {
    const recorded = matrix({ upstream: { pptwise: '0.35.0', 'ppt-master': '0.1.127' } })
    expect(compareMatrix(recorded, matrix())).toEqual(['ppt-master 0.1.127 -> 0.1.128'])
  })

  it('fails the gate when a theme snapshot changes', () => {
    const fresh = matrix()
    const changed = { ...fresh, themes: { ...fresh.themes, terminal: snapshot('b'.repeat(64)) } }
    expect(compareMatrix(matrix(), changed)).toEqual(['terminal: snapshot changed'])
  })

  it('fails the gate when the schema version moves', () => {
    expect(compareMatrix(matrix({ schemaVersion: 0 }), matrix())).toContain('schemaVersion 0 != 1')
  })
})
