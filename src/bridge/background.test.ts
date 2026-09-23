import { describe, expect, it } from 'vitest'
import { BACKGROUND_CONTRAST_FLOOR, applyProfileBackgrounds, backgroundContrast, designRoleFor } from './background.ts'
import { svgBackground } from './svg-background.ts'
import { applyCompatPass } from './compat.ts'
import { OpcPackage, listSlides, resolveTarget } from './opc.ts'
import { DshPptFailure } from '../engine/errors.ts'
import type { DesignProfile } from '../schema/design-profile.ts'

const SLIDE_SIZE = { cx: 12192000, cy: 6858000 }

/** The reference-like profile: light canvas, dark inks, quiet accent tints. */
const PROFILE: DesignProfile = {
  version: 1,
  canvas: { widthEmu: SLIDE_SIZE.cx, heightEmu: SLIDE_SIZE.cy },
  palette: { bg: '#FFFFFF', title: '#0D0D0D', accent: '#577FD2', body: '#262626', muted: '#595959', watermark: '#F2F7FA', onAccent: '#FFFFFF' },
  fonts: { heading: 'MiSans', body: 'MiSans', number: 'Noto Sans SC' },
  typeScale: {},
  roles: {},
  chrome: { sectionMarker: true, metaFooter: true, pageNumber: false },
  background: { mode: 'svg', overlayOpacity: 0.15 },
}

/** @returns a slide with an empty shape tree. */
function slideXml(): string {
  return '<p:sld><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr></p:spTree></p:cSld></p:sld>'
}

/** @returns a package with `count` empty slides in presentation order. */
function miniPackage(count: number): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const rows: string[] = []
  const rels: { id: string; type: string; target: string }[] = []
  for (let index = 1; index <= count; index += 1) {
    pkg.setPart(`ppt/slides/slide${String(index)}.xml`, slideXml())
    rels.push({ id: `rId${String(index)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(index)}.xml` })
    rows.push(`<p:sldId id="${String(255 + index)}" r:id="rId${String(index)}"/>`)
  }
  pkg.setPart('ppt/presentation.xml', `<p:presentation><p:sldSz cx="${String(SLIDE_SIZE.cx)}" cy="${String(SLIDE_SIZE.cy)}"/><p:sldIdLst>${rows.join('')}</p:sldIdLst></p:presentation>`)
  pkg.setRelationships('ppt/presentation.xml', rels)
  for (const name of pkg.names()) pkg.ensureContentType(name, 'application/xml')
  return pkg
}

const pages = [
  { index: 1, role: 'cover' as const },
  { index: 2, role: 'content' as const },
  { index: 3, role: 'ending' as const },
]

describe('svgBackground', () => {
  it('is deterministic and paints only its declared palette colours', () => {
    const first = svgBackground('content', PROFILE)
    const second = svgBackground('content', PROFILE)
    expect(first.svg).toBe(second.svg)
    const literals = [...first.svg.matchAll(/#[0-9A-F]{6}/g)].map((match) => match[0])
    expect(literals.length).toBeGreaterThan(0)
    for (const literal of literals) expect(first.colours).toContain(literal)
  })

  it('composes a different background per role on the profile canvas', () => {
    expect(svgBackground('cover', PROFILE).svg).not.toBe(svgBackground('content', PROFILE).svg)
    expect(svgBackground('cover', PROFILE).svg).toContain('width="1280" height="720"')
  })
})

describe('backgroundContrast', () => {
  it('keeps the reference palette above the floor', () => {
    const generated = svgBackground('content', PROFILE)
    expect(backgroundContrast(PROFILE, generated.colours, PROFILE.background.overlayOpacity)).toBeGreaterThanOrEqual(BACKGROUND_CONTRAST_FLOOR)
  })
})

describe('applyProfileBackgrounds', () => {
  it('inserts one SVG picture and overlay per slide, behind the content', () => {
    const pkg = miniPackage(3)
    const report = applyProfileBackgrounds(pkg, { profile: PROFILE, pages })
    expect(report.mode).toBe('svg')
    expect(report.application).toBe('svg')
    expect(report.parts).toHaveLength(3)
    expect(report.minContrast).toBeGreaterThanOrEqual(BACKGROUND_CONTRAST_FLOOR)
    for (const part of report.parts) expect(pkg.has(part)).toBe(true)
    for (const slide of listSlides(pkg)) {
      const xml = pkg.text(slide)
      expect(xml).toContain('dsh-background-overlay')
      expect(xml).toContain('<asvg:svgBlip')
      expect(xml.indexOf('dsh-background')).toBeLessThan(xml.indexOf('</p:spTree>'))
      const rels = pkg.relationshipsOf(slide)
      expect(rels.some((rel) => rel.type.endsWith('/image'))).toBe(true)
    }
  })

  it('writes identical parts for identical inputs', () => {
    const left = miniPackage(2)
    const right = miniPackage(2)
    applyProfileBackgrounds(left, { profile: PROFILE, pages: pages.slice(0, 2) })
    applyProfileBackgrounds(right, { profile: PROFILE, pages: pages.slice(0, 2) })
    for (const part of ['ppt/media/dsh-bg-cover.svg', 'ppt/media/dsh-bg-content.svg']) {
      expect(left.part(part).equals(right.part(part))).toBe(true)
    }
    expect(left.text('ppt/slides/slide1.xml')).toBe(right.text('ppt/slides/slide1.xml'))
  })

  it('leaves the SVG for the compat pass to stamp with a PNG sibling', async () => {
    const pkg = miniPackage(2)
    applyProfileBackgrounds(pkg, { profile: PROFILE, pages: pages.slice(0, 2) })
    const report = await applyCompatPass(pkg, { level: 'standard', rasterise: async () => Buffer.from('png-bytes') })
    expect(report.counts.stamps).toBe(2)
    for (const slide of listSlides(pkg)) {
      const xml = pkg.text(slide)
      const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(xml)?.[1]
      expect(embed).toBeDefined()
      const target = resolveTarget(slide, pkg.relationshipsOf(slide).find((rel) => rel.id === embed)?.target ?? '')
      expect(target.endsWith('.png')).toBe(true)
      expect(pkg.has(target)).toBe(true)
      expect(pkg.names().some((name) => name.endsWith('.svg'))).toBe(true)
    }
  })

  it('writes a solid p:bg fill for flat and for an unattached picture mode', () => {
    const flat: DesignProfile = { ...PROFILE, background: { mode: 'flat', overlayOpacity: 0 } }
    const flatPkg = miniPackage(2)
    const flatReport = applyProfileBackgrounds(flatPkg, { profile: flat, pages: pages.slice(0, 2) })
    expect(flatReport.application).toBe('flat')
    expect(flatPkg.text('ppt/slides/slide1.xml')).toContain('<a:srgbClr val="#FFFFFF"/>')
    expect(flatPkg.text('ppt/slides/slide1.xml')).not.toContain('dsh-background')
    const photo: DesignProfile = { ...PROFILE, background: { mode: 'photo', overlayOpacity: 0.2 } }
    const photoPkg = miniPackage(1)
    const photoReport = applyProfileBackgrounds(photoPkg, { profile: photo, pages: pages.slice(0, 1) })
    expect(photoReport.application).toBe('flat')
    expect(photoReport.notes.join(' ')).toContain('asset reference')
  })

  it('refuses a background that drops a text ink below the floor and a page mismatch', () => {
    const faint: DesignProfile = { ...PROFILE, palette: { ...PROFILE.palette, body: '#F0F0F0' } }
    expect(failureCode(() => applyProfileBackgrounds(miniPackage(1), { profile: faint, pages: pages.slice(0, 1) }))).toBe('ContractViolation')
    expect(failureCode(() => applyProfileBackgrounds(miniPackage(2), { profile: PROFILE, pages: pages.slice(0, 1) }))).toBe('ContractViolation')
  })

  it('maps chrome-only roles onto design roles', () => {
    expect(designRoleFor('quote')).toBe('content')
    expect(designRoleFor('data')).toBe('content')
    expect(designRoleFor('cover')).toBe('cover')
    expect(designRoleFor('ending')).toBe('ending')
  })
})

/** @returns the DshPptFailure code of `run`, or a marker when it did not throw one. */
function failureCode(run: () => unknown): string {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}
