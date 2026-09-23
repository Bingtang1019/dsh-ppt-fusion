import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertProfileContrast, chartPaletteFrom, contrastRatio, mixHex, relativeLuminance, themeFromProfile } from './profile-theme.ts'
import { parseDesignProfile } from '../schema/design-profile.ts'
import { parseThemeFile } from '../schema/tokens.ts'
import { fakeThemeDocument } from '../../tests/support/fake-pptwise.ts'

const profile = parseDesignProfile(JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'reference', 'profile.json'), 'utf8')) as unknown)
const base = parseThemeFile(fakeThemeDocument('brief'))

describe('profile colour math', () => {
  it('computes WCAG contrast, luminance and mixes', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1)
    expect(relativeLuminance('#000000')).toBe(0)
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080')
    expect(contrastRatio('#262626', '#FFFFFF')).toBeGreaterThan(12)
  })

  it('derives five deterministic, distinct chart series from the accent', () => {
    const palette = chartPaletteFrom('#577FD2')
    expect(palette).toHaveLength(5)
    expect(palette[0]).toBe('#577FD2')
    expect(new Set(palette).size).toBeGreaterThanOrEqual(4)
    expect(chartPaletteFrom('#577FD2')).toEqual(palette)
  })
})

describe('themeFromProfile', () => {
  it('maps the reference palette and fonts while keeping the preset id, menu and shape', () => {
    const theme = themeFromProfile(base, profile)
    expect(theme.id).toBe('brief')
    expect(theme.label).toBe(base.label)
    expect(theme.style.colors.bg).toBe('#FFFFFF')
    expect(theme.style.colors.primary).toBe('#0D0D0D')
    expect(theme.style.colors.accent).toBe('#577FD2')
    expect(theme.style.colors.text).toBe('#262626')
    expect(theme.style.colors.muted).toBe('#595959')
    expect(theme.style.colors.chartPalette?.[0]).toBe('#577FD2')
    // pptwise paints marked runs in emphasisInk; the mapping omits it so the engine
    // falls back to accent instead of a white-on-white combination.
    expect('emphasisInk' in theme.style.colors).toBe(false)
    expect(theme.style.fonts.heading[0]).toBe('MiSans')
    expect(theme.style.fonts.body[0]).toBe('MiSans')
    expect(theme.menu).toEqual(base.menu)
    expect(theme.style.shape).toEqual(base.style.shape)
    expect(theme.style.defaultBackgrounds?.content).toEqual({ kind: 'color', value: '#FFFFFF' })
  })

  it('reports a failing palette instead of adjusting it', () => {
    const broken = { ...profile, palette: { ...profile.palette, body: '#EEEEEE' } }
    expect(() => assertProfileContrast(broken)).toThrowError(/WCAG/)
    try {
      assertProfileContrast(broken)
    } catch (error) {
      expect((error as Error).message).toContain('body/bg')
    }
    expect(() => themeFromProfile(base, broken)).toThrowError(/WCAG/)
  })
})
