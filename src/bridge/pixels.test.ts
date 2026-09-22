import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { collectPixelFindings, deltaE76, sampleSvgColours } from './pixels.ts'
import { allowedPalette, type TokensFile } from '../schema/tokens.ts'

const SVG = (rect: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="${rect}"/></svg>`

/** The real brief token snapshot, so the assertions run against a shipped palette. */
const TOKENS: TokensFile = (JSON.parse(readFileSync('fixtures/themes/brief.tokens.json', 'utf8')) as { tokens: TokensFile }).tokens
const PALETTE = allowedPalette(TOKENS)

describe('deltaE76', () => {
  it('is zero for identical colours and about 100 for black against white', () => {
    expect(deltaE76('#123456', '#123456')).toBe(0)
    expect(deltaE76('#000000', '#FFFFFF')).toBeGreaterThan(99)
    expect(deltaE76('#000000', '#FFFFFF')).toBeLessThan(101)
  })

  it('separates near colours from far ones', () => {
    expect(deltaE76('#FF0000', '#EE0000')).toBeLessThan(7)
    expect(deltaE76('#FF0000', '#00FF00')).toBeGreaterThan(80)
  })
})

describe('sampleSvgColours', () => {
  it('returns the exact fill and its coverage', async () => {
    const samples = await sampleSvgColours(Buffer.from(SVG('#123456')))
    expect(samples).toHaveLength(1)
    expect(samples[0]?.hex).toBe('#123456')
    expect(samples[0]?.coverage).toBeCloseTo(1, 2)
  })

  it('drops colours below the coverage floor', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#123456"/><rect width="2" height="2" fill="#FF00FF"/></svg>`
    const samples = await sampleSvgColours(Buffer.from(svg))
    expect(samples.map((sample) => sample.hex)).toEqual(['#123456'])
  })
})

describe('collectPixelFindings', () => {
  it('stays quiet when every sampled colour is in the palette', async () => {
    const colour = PALETTE[0] ?? '#1E2A4A'
    const findings = await collectPixelFindings(TOKENS, [{ page: 3, path: 'p03.svg', svg: SVG(colour) }])
    expect(findings).toEqual([])
  })

  it('reports a page whose dominant colour is far from every palette colour', async () => {
    const findings = await collectPixelFindings(TOKENS, [{ page: 3, path: 'p03.svg', svg: SVG('#FF00FF') }])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.level).toBe('warning')
    expect(findings[0]?.page).toBe(3)
    expect(findings[0]?.rule).toBe('palette-delta-e')
    expect(findings[0]?.message).toContain('#FF00FF')
    expect(findings[0]?.message).toContain('coverage 100.0 %')
  })
})
