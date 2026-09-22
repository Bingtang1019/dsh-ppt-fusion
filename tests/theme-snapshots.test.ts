import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { catalogIds, captureThemes, readSnapshot, tempFrontend, tryResolvePptwise, SNAPSHOT_DIR } from './support/theme-snapshots.ts'
import { exportTokens, parseThemeFile } from '../src/schema/tokens.ts'

const cli = tryResolvePptwise()

/**
 * Cheap structural checks plus one real re-capture.
 *
 * The full 24-theme re-capture lives in `pnpm themes:verify` (tests/themes-verify.ts)
 * because driving the upstream CLI 24 times synchronously blocks the test worker
 * past vitest's RPC timeout. This file keeps the snapshot set honest in the unit
 * suite: the catalog is complete, every entry has a fixture, and one theme is
 * re-captured from the real upstream and compared field by field.
 */
describe.skipIf(cli === null)('factory theme token snapshots', () => {
  const ids = cli === null ? [] : catalogIds(cli)

  it('covers the whole factory catalog', () => {
    expect(ids).toHaveLength(24)
  })

  it('records every catalog entry under fixtures/themes', () => {
    const missing = ids.filter((id) => readSnapshot(id) === null)
    expect(missing, `${SNAPSHOT_DIR} is missing snapshots`).toEqual([])
  })

  it('records a master projection that shares the token palette', () => {
    for (const id of ids) {
      const snapshot = readSnapshot(id)
      expect(snapshot?.master.themeId, id).toBe(id)
      expect(snapshot?.master.palette, id).toEqual([...new Set(snapshot?.master.palette ?? [])].sort())
      expect(snapshot?.master.palette.length, id).toBeGreaterThan(0)
    }
  })

  it('re-captures one preset from the installed upstream without drift', { timeout: 60_000 }, () => {
    const recorded = readSnapshot('brief')
    expect(recorded).not.toBeNull()
    expect(captureThemes(['brief']).brief).toEqual(recorded)
  })

  it('exports exactly the style groups the theme file carries (golden, field by field)', { timeout: 60_000 }, () => {
    if (cli === null) return
    const { frontend } = tempFrontend(cli)
    const written = frontend.themeNew({ from: 'terminal', output: 'theme.json', id: 'terminal' })
    const theme = parseThemeFile(JSON.parse(readFileSync(written.outputFile, 'utf8')))
    const tokens = exportTokens(theme, { kind: 'preset', preset: 'terminal' })
    expect(tokens.colors).toEqual(theme.style.colors)
    expect(tokens.fonts).toEqual(theme.style.fonts)
    expect(tokens.shape).toEqual(theme.style.shape ?? {})
    expect(tokens.defaultBackgrounds).toEqual(theme.style.defaultBackgrounds ?? {})
    expect(tokens.themeId).toBe(theme.id)
  })
})