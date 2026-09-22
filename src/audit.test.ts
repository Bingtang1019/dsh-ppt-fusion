import { describe, expect, it } from 'vitest'
import { buildReport, collectPaletteFindings, formatFindings, paintedColors } from './audit.ts'
import { exportTokens, parseThemeFile } from './schema/tokens.ts'
import { fakeThemeDocument } from '../tests/support/fake-pptwise.ts'

const tokens = exportTokens(parseThemeFile(fakeThemeDocument('brief')), { kind: 'preset', preset: 'brief' })

describe('paintedColors', () => {
  it('reads fill, stroke and stop-color, including style-attribute form', () => {
    const svg = '<rect fill="#1e2a4a"/><path stroke="#F5C518"/><stop stop-color="#fff"/><rect style="fill: #3b76a8"/>'
    expect(paintedColors(svg)).toEqual(['#1E2A4A', '#F5C518', '#FFFFFF', '#3B76A8'])
  })

  it('expands three-digit shorthand so it compares against the palette', () => {
    expect(paintedColors('<rect fill="#abc"/>')).toEqual(['#AABBCC'])
  })

  it('ignores non-hex paint values', () => {
    expect(paintedColors('<rect fill="none"/><rect fill="url(#grad)"/>')).toEqual([])
  })
})

describe('collectPaletteFindings', () => {
  it('reports a page that paints outside the palette', () => {
    const findings = collectPaletteFindings(tokens, [
      { page: 3, path: 'deep/p03/page.svg', svg: '<rect fill="#1E2A4A"/><rect fill="#FF0000"/>' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ level: 'warning', source: 'palette', page: 3, rule: 'palette-unknown-color' })
    expect(findings[0]?.message).toContain('#FF0000')
  })

  it('accepts palette colours, neutrals and case differences', () => {
    const findings = collectPaletteFindings(tokens, [
      { page: 1, path: 'deep/p01/page.svg', svg: '<rect fill="#f5c518"/><rect fill="#ffffff"/><rect stroke="#000000"/>' },
    ])
    expect(findings).toEqual([])
  })

  it('reports each unknown colour once per page', () => {
    const findings = collectPaletteFindings(tokens, [
      { path: 'a.svg', svg: '<rect fill="#FF0000"/><rect fill="#FF0000"/><rect stroke="#00FF00"/>' },
    ])
    expect(findings[0]?.message).toContain('#FF0000')
    expect(findings[0]?.message).toContain('#00FF00')
    expect(findings[0]?.message.match(/#FF0000/g)).toHaveLength(1)
  })
})

describe('buildReport', () => {
  it('is ok with warnings and not ok with an error', () => {
    expect(buildReport([{ level: 'warning', source: 'palette', rule: 'r', message: 'm' }], ['palette']).ok).toBe(true)
    expect(buildReport([{ level: 'error', source: 'theme', rule: 'r', message: 'm' }], ['theme']).ok).toBe(false)
  })
})

describe('formatFindings', () => {
  it('renders level, source, page and rule', () => {
    expect(formatFindings([{ level: 'error', source: 'deep', page: 2, rule: 'deep-page-missing-file', message: 'missing' }])).toBe(
      '[ERROR] deep page 2: deep-page-missing-file: missing',
    )
  })
})
