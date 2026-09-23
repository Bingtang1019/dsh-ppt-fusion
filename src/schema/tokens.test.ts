import { describe, expect, it } from 'vitest'
import { allowedPalette, exportTokens, masterDesign, parseThemeFile, tokensEqual } from './tokens.ts'
import { fakeThemeDocument } from '../../tests/support/fake-pptwise.ts'

const theme = parseThemeFile(fakeThemeDocument('brief'))

describe('parseThemeFile', () => {
  it('accepts a v2 theme and keeps unmodelled fields for pass-through', () => {
    const parsed = parseThemeFile(fakeThemeDocument('acme'))
    expect(parsed.id).toBe('acme')
    expect(parsed.menu).toEqual(fakeThemeDocument('acme').menu)
  })

  it('rejects a document without the style groups', () => {
    expect(() => parseThemeFile({ id: 'x' })).toThrow()
  })

  it('rejects a palette that is not an array of strings', () => {
    const broken = fakeThemeDocument('x') as { style: { colors: Record<string, unknown> } }
    broken.style.colors.chartPalette = 'nope'
    expect(() => parseThemeFile(broken)).toThrow()
  })
})

describe('exportTokens', () => {
  it('copies every token group the deep pages consume', () => {
    const tokens = exportTokens(theme, { kind: 'preset', preset: 'brief', upstream: '0.35.0' })
    expect(tokens.schema).toBe('dsh-ppt-fusion.tokens.v1')
    expect(tokens.themeId).toBe('brief')
    expect(tokens.colors).toEqual(theme.style.colors)
    expect(tokens.fonts).toEqual(theme.style.fonts)
    expect(tokens.shape).toEqual(theme.style.shape)
    expect(tokens.defaultBackgrounds).toEqual(theme.style.defaultBackgrounds)
    expect(tokens.source).toEqual({ kind: 'preset', preset: 'brief', upstream: '0.35.0' })
  })

  it('does not alias the upstream arrays', () => {
    const tokens = exportTokens(theme, { kind: 'preset', preset: 'brief' })
    tokens.colors.chartPalette.push('#000000')
    expect(theme.style.colors.chartPalette).not.toContain('#000000')
  })
})

describe('allowedPalette', () => {
  it('collects every colour literal, uppercased and sorted, including backgrounds', () => {
    const tokens = exportTokens(theme, { kind: 'preset', preset: 'brief' })
    const palette = allowedPalette(tokens)
    expect(palette).toContain('#1E2A4A')
    expect(palette).toContain('#F5C518')
    expect(palette).toContain('#F7F6F2')
    expect(palette).toEqual([...palette].sort())
    expect(new Set(palette).size).toBe(palette.length)
  })

  it('includes both stops of a gradient background, which the ledger and terminal presets use', () => {
    const gradient = fakeThemeDocument('ledger', {
      style: {
        ...(fakeThemeDocument('ledger').style as Record<string, unknown>),
        defaultBackgrounds: {
          cover: { kind: 'gradient', from: '#151B23', to: '#0C1016', direction: 'tb' },
          content: { kind: 'color', value: '#0C1016' },
        },
      },
    })
    const palette = allowedPalette(exportTokens(parseThemeFile(gradient), { kind: 'preset', preset: 'ledger' }))
    expect(palette).toContain('#151B23')
    expect(palette).toContain('#0C1016')
  })

  it('accepts a monospaced stack, which three presets ship', () => {
    const withMono = fakeThemeDocument('terminal', {
      style: {
        ...(fakeThemeDocument('terminal').style as Record<string, unknown>),
        fonts: { heading: ['Arial'], body: ['Arial'], mono: ['Consolas', 'monospace'] },
      },
    })
    expect(parseThemeFile(withMono).style.fonts.mono).toEqual(['Consolas', 'monospace'])
  })

  it('rejects a mono stack given as a bare string, which no preset does', () => {
    const broken = fakeThemeDocument('x', {
      style: {
        ...(fakeThemeDocument('x').style as Record<string, unknown>),
        fonts: { heading: ['Arial'], body: ['Arial'], mono: 'Consolas' },
      },
    })
    expect(() => parseThemeFile(broken)).toThrow()
  })
})

describe('masterDesign', () => {
  it('maps token groups onto the authoring role names', () => {
    const master = masterDesign(exportTokens(theme, { kind: 'preset', preset: 'brief' }))
    expect(master).toMatchObject({
      slideBackground: '#F7F6F2',
      cardFill: '#FFFFFF',
      structure: '#1E2A4A',
      accent: '#F5C518',
      bodyText: '#1C1E23',
      secondaryText: '#5B6069',
      line: '#DDDCD4',
      dataSeries: ['#1E2A4A', '#F5C518', '#3B76A8', '#797D86'],
    })
    expect(master.palette.length).toBeGreaterThan(8)
    expect(master.guidance).toContain('only with these literals')
  })
})

describe('tokensEqual', () => {
  it('ignores key order but not values', () => {
    expect(tokensEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true)
    expect(tokensEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
})
