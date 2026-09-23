import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDesignProfile, DESIGN_PROFILE_VERSION } from './design-profile.ts'
import { DshPptFailure } from '../engine/errors.ts'

/** A valid profile shaped like the recorded reference fixture. */
const valid = {
  version: DESIGN_PROFILE_VERSION,
  canvas: { widthEmu: 12192000, heightEmu: 6858000 },
  palette: {
    bg: '#FFFFFF',
    title: '#0D0D0D',
    accent: '#577FD2',
    body: '#262626',
    muted: '#595959',
    watermark: '#F2F7FA',
    onAccent: '#FFFFFF',
  },
  fonts: { heading: 'MiSans', body: 'MiSans', number: 'Noto Sans SC' },
  typeScale: {
    cover: { title: { sizePt: 44, bold: true, color: '#000000', font: 'MiSans' }, body: { sizePt: 16, color: '#000000', font: 'MiSans' } },
    content: { title: { sizePt: 36, color: '#0D0D0D', font: 'MiSans' } },
  },
  roles: {
    cover: { titlePos: { x: 0.69, y: 3.08 }, columns: 1 },
    content: { titlePos: { x: 0.59, y: 0.58 }, columns: 2, columnsMax: 3, cardGapIn: 0.43 },
  },
  chrome: { sectionMarker: true, metaFooter: true, pageNumber: false },
  background: { mode: 'photo', overlayOpacity: 0.15 },
}

const failureOf = (raw: unknown): DshPptFailure => {
  try {
    parseDesignProfile(raw)
  } catch (error) {
    if (error instanceof DshPptFailure) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('parseDesignProfile', () => {
  it('accepts the recorded reference fixture', () => {
    const text = readFileSync(join(process.cwd(), 'fixtures', 'reference', 'profile.json'), 'utf8')
    // A profile is numeric: no deck text, no CJK, no paths may appear in it.
    expect(/[^\x20-\x7E\r\n\t]/.test(text)).toBe(false)
    const profile = parseDesignProfile(JSON.parse(text) as unknown)
    expect(profile.version).toBe(1)
    expect(profile.canvas).toEqual({ widthEmu: 12192000, heightEmu: 6858000 })
    expect(profile.palette.accent).toBe('#577FD2')
    expect(profile.fonts.number).toBe('Noto Sans SC')
    expect(profile.background.mode).toBe('photo')
  })

  it('accepts a hand-written profile and rejects unknown fields with their path', () => {
    expect(parseDesignProfile(valid).palette.title).toBe('#0D0D0D')
    expect(failureOf({ ...valid, extra: true }).message).toContain('extra')
    expect(failureOf({ ...valid, palette: { ...valid.palette, accent: '577FD2' } }).message).toContain('palette.accent')
    expect(failureOf({ ...valid, fonts: { ...valid.fonts, number: '' } }).message).toContain('fonts.number')
    expect(failureOf({ ...valid, background: { mode: 'generated', overlayOpacity: 0.2 } }).message).toContain('background.mode')
    expect(failureOf({ ...valid, background: { mode: 'photo', overlayOpacity: 2 } }).message).toContain('background.overlayOpacity')
  })

  it('rejects unknown roles and a profile without a canvas', () => {
    expect(failureOf({ ...valid, typeScale: { ...valid.typeScale, title: { title: { sizePt: 20, color: '#000000', font: 'Arial' } } } }).message).toContain('typeScale')
    const withoutCanvas = { ...valid } as Record<string, unknown>
    delete withoutCanvas.canvas
    expect(failureOf(withoutCanvas).message).toContain('canvas')
    expect(failureOf({ ...valid, version: 2 }).message).toContain('version')
  })

  it('names the file in a failure message', () => {
    expect(failureOf({}).message).toContain('design-profile.json')
  })
})
