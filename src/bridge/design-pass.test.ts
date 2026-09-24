import { describe, expect, it } from 'vitest'
import { applyDesignProfile, type DesignPassPage } from './design-pass.ts'
import { OpcPackage } from './opc.ts'
import { listSlides } from './opc.ts'
import type { DesignProfile } from '../schema/design-profile.ts'

const SLIDE_SIZE = { cx: 12192000, cy: 6858000 }

/** The profile the fixtures below are authored against. */
const PROFILE: DesignProfile = {
  version: 1,
  canvas: { widthEmu: SLIDE_SIZE.cx, heightEmu: SLIDE_SIZE.cy },
  palette: { bg: '#FFFFFF', title: '#0D0D0D', accent: '#577FD2', body: '#262626', muted: '#595959', watermark: '#F2F7FA', onAccent: '#FFFFFF' },
  fonts: { heading: 'MiSans', body: 'MiSans', number: 'Noto Sans SC' },
  typeScale: {
    cover: { title: { sizePt: 44, bold: true, color: '#000000', font: 'MiSans' }, body: { sizePt: 16, color: '#000000', font: 'MiSans' } },
    section: { title: { sizePt: 34, bold: false, color: '#0D0D0D', font: 'MiSans' } },
    content: { title: { sizePt: 36, bold: false, color: '#0D0D0D', font: 'MiSans' }, body: { sizePt: 14, color: '#262626', font: 'MiSans' } },
    ending: { title: { sizePt: 54, bold: false, color: '#000000', font: 'MiSans' }, body: { sizePt: 16, color: '#000000', font: 'MiSans' } },
  },
  roles: {
    cover: { titlePos: { x: 0.69, y: 3.08 }, columns: 1 },
    section: { titlePos: { x: 0.64, y: 3.43 }, columns: 1, watermarkSizePt: 85 },
    content: { titlePos: { x: 0.59, y: 0.58 }, columns: 2, columnsMax: 3, cardGapIn: 0.43 },
    ending: { titlePos: { x: 0.69, y: 3.79 }, columns: 1 },
  },
  chrome: { sectionMarker: true, metaFooter: true, pageNumber: false },
  background: { mode: 'flat', overlayOpacity: 0 },
}

/** @returns the `a:r` XML for one run. */
function runXml(sz: number, color: string, text: string): string {
  return `<a:r><a:rPr lang="zh-CN" sz="${String(sz)}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="MiSans"/><a:ea typeface="MiSans"/></a:rPr><a:t>${text}</a:t></a:r>`
}

/** @returns one `p:sp` at the given inch position. */
function shapeXml(input: { x: number; y: number; w: number; h: number; runs: readonly string[]; name?: string }): string {
  const emu = (value: number): number => Math.round(value * 914400)
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="${input.name ?? 'shape'}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(emu(input.x))}" y="${String(emu(input.y))}"/><a:ext cx="${String(emu(input.w))}" cy="${String(emu(input.h))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${input.runs.join('')}</a:p></p:txBody></p:sp>`
}

/** @returns a content page with two card columns and a title in the preset's geometry. */
function contentSlide(): string {
  return [
    shapeXml({ x: 1, y: 1.48, w: 12.33, h: 0.8, runs: [runXml(4500, '1C1E23', 'Preset title')] }),
    shapeXml({ x: 1, y: 2.6, w: 4, h: 2, runs: [runXml(2000, '1E2A4A', 'Card A'), runXml(1800, '1C1E23', 'Body A1'), runXml(1800, '1C1E23', 'Body A2')] }),
    shapeXml({ x: 7, y: 2.6, w: 4, h: 2, runs: [runXml(2000, '1E2A4A', 'Card B'), runXml(1800, '1C1E23', 'Body B1'), runXml(1800, '1C1E23', 'Body B2')] }),
  ].join('')
}

/** @returns a section page whose preset face already carries a 90 pt watermark numeral. */
function sectionSlide(): string {
  return [
    shapeXml({ x: 0.69, y: 3.79, w: 5, h: 1, runs: [runXml(5400, '000000', 'Preset chapter')] }),
    shapeXml({ x: 8.96, y: 2.9, w: 1.77, h: 1.57, runs: [runXml(9000, 'F2F7FA', '03')] }),
  ].join('')
}

/** @returns a cover page with a preset-sized title and body. */
function coverSlide(): string {
  return shapeXml({ x: 1, y: 1.48, w: 6, h: 1, runs: [runXml(5400, '1C1E23', 'Preset cover'), runXml(1800, '1C1E23', 'Meta')] })
}

/** @returns a package with the given slides. */
function packageWith(slides: readonly string[]): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const rows: string[] = []
  const rels: { id: string; type: string; target: string }[] = []
  slides.forEach((shapes, offset) => {
    const index = offset + 1
    pkg.setPart(`ppt/slides/slide${String(index)}.xml`, `<p:sld><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr>${shapes}</p:spTree></p:cSld></p:sld>`)
    rels.push({ id: `rId${String(index)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(index)}.xml` })
    rows.push(`<p:sldId id="${String(255 + index)}" r:id="rId${String(index)}"/>`)
  })
  pkg.setPart('ppt/presentation.xml', `<p:presentation><p:sldSz cx="${String(SLIDE_SIZE.cx)}" cy="${String(SLIDE_SIZE.cy)}"/><p:sldIdLst>${rows.join('')}</p:sldIdLst></p:presentation>`)
  pkg.setRelationships('ppt/presentation.xml', rels)
  for (const name of pkg.names()) pkg.ensureContentType(name, 'application/xml')
  return pkg
}

/** The roles the pages are passed with. */
const contentPages: readonly DesignPassPage[] = [{ index: 1, role: 'content', standard: true }]
const sectionPages: readonly DesignPassPage[] = [{ index: 1, role: 'section', standard: true, section: 'Chapter One' }]
const coverPages: readonly DesignPassPage[] = [
  { index: 1, role: 'cover', standard: true },
  { index: 2, role: 'ending', standard: true },
]

describe('applyDesignProfile', () => {
  it('rewrites the title, body, accent and card gap on a content page', () => {
    const pkg = packageWith([contentSlide()])
    const report = applyDesignProfile(pkg, { profile: PROFILE, pages: contentPages })
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(report.titles).toBe(1)
    expect(report.bodies).toBe(4)
    expect(report.accents).toBe(2)
    expect(report.gaps).toBe(1)
    // Title: one ladder step down, at the profile anchor plus the corner-mark clearance.
    expect(xml).toContain('sz="3400"')
    expect(xml).toContain('<a:srgbClr val="0D0D0D"/>')
    expect(xml).toContain(`<a:off x="${String(Math.round((0.59 + 8 / 96) * 914400))}" y="${String(Math.round((0.58 + 8 / 96) * 914400))}"/>`)
    // Body runs take 14 pt / #262626; the accent runs take the profile accent.
    expect(xml).toContain('sz="1400"')
    expect(xml).toContain('<a:srgbClr val="262626"/>')
    expect(xml).toContain('<a:srgbClr val="577FD2"/>')
    // Column B moves to column A's right edge plus the 0.43 in gap.
    const moved = Math.round(1 * 914400 + 4 * 914400 + 0.43 * 914400)
    expect(xml).toContain(`x="${String(moved)}"`)
    expect(xml).not.toContain('sz="4500"')
    expect(xml).not.toContain('sz="1800"')
  })

  it('keeps the authored toc title anchor instead of the profile number column', () => {
    const tocProfile: DesignProfile = {
      ...PROFILE,
      typeScale: {
        ...PROFILE.typeScale,
        toc: { title: { sizePt: 40, bold: false, color: '#000000', font: 'Noto Sans SC' }, body: { sizePt: 20, color: '#595959', font: 'MiSans' } },
      },
      roles: { ...PROFILE.roles, toc: { titlePos: { x: 5.19, y: 1.79 }, columns: 3, columnsMax: 3, cardGapIn: 1.04 } },
    }
    const slide = [
      shapeXml({ x: 1, y: 1.2, w: 12.33, h: 0.55, runs: [runXml(3300, '1C1E23', '目录')] }),
      shapeXml({ x: 1, y: 1.94, w: 6.7, h: 2.14, runs: [] }),
      shapeXml({ x: 1.25, y: 2.99, w: 12.08, h: 0.28, runs: [runXml(1650, '1E2A4A', '原料准备')] }),
      shapeXml({ x: 8.12, y: 2.99, w: 5.22, h: 0.28, runs: [runXml(1650, '1E2A4A', '关键控制点')] }),
    ].join('')
    const pkg = packageWith([slide])
    applyDesignProfile(pkg, { profile: tocProfile, pages: [{ index: 1, role: 'toc', standard: true }] })
    const xml = pkg.text('ppt/slides/slide1.xml')
    const authored = `<a:off x="${String(Math.round(1 * 914400))}" y="${String(Math.round(1.2 * 914400))}"/>`
    expect(xml).toContain(authored)
    expect(xml).not.toContain(`x="${String(Math.round(5.19 * 914400))}"`)
    expect(xml).toContain('sz="4000"')
    expect(xml).toContain('sz="2000"')
  })

  it('lays a content page out as equal card columns with accent titles', () => {
    const slide = [
      shapeXml({ x: 0.59, y: 0.58, w: 12.33, h: 0.53, runs: [runXml(3600, '0D0D0D', 'Page title')] }),
      shapeXml({ x: 1, y: 2.04, w: 6.7, h: 4.33, runs: [], name: 'panel-a' }),
      shapeXml({ x: 1.25, y: 4.2, w: 12.08, h: 0.28, runs: [runXml(1400, '1C1E23', 'Card A')], name: 'title-a' }),
      shapeXml({ x: 1.25, y: 4.59, w: 12.08, h: 0.2, runs: [runXml(1200, '1C1E23', 'Body A')], name: 'body-a' }),
      shapeXml({ x: 7.87, y: 2.04, w: 4.47, h: 2.08, runs: [], name: 'panel-b' }),
      shapeXml({ x: 8.12, y: 3.07, w: 5.22, h: 0.28, runs: [runXml(1400, '1C1E23', 'Card B')], name: 'title-b' }),
      shapeXml({ x: 8.12, y: 3.47, w: 5.22, h: 0.2, runs: [runXml(1200, '1C1E23', 'Body B')], name: 'body-b' }),
      shapeXml({ x: 7.87, y: 4.29, w: 4.47, h: 2.08, runs: [], name: 'panel-c' }),
      shapeXml({ x: 8.12, y: 5.32, w: 5.22, h: 0.28, runs: [runXml(1400, '1C1E23', 'Card C')], name: 'title-c' }),
      shapeXml({ x: 8.12, y: 5.72, w: 5.22, h: 0.2, runs: [runXml(1200, '1C1E23', 'Body C')], name: 'body-c' }),
    ].join('')
    const pkg = packageWith([slide])
    const report = applyDesignProfile(pkg, { profile: PROFILE, pages: contentPages })
    const xml = pkg.text('ppt/slides/slide1.xml')
    const emu = (value: number): number => Math.round(value * 914400)
    const width = (12.34 - 1 - 2 * 0.43) / 3
    expect(report.cards).toBe(3)
    expect(xml).toContain(`<a:ext cx="${String(emu(width))}" cy="${String(emu(4.33))}"/>`)
    expect(xml).toContain(`<a:off x="${String(emu(1))}" y="${String(emu(2.04))}"/>`)
    expect(xml).toContain(`<a:off x="${String(emu(1 + width + 0.43))}" y="${String(emu(2.04))}"/>`)
    expect(xml).toContain(`<a:off x="${String(emu(1 + 2 * (width + 0.43)))}" y="${String(emu(2.04))}"/>`)
    // card titles take 20 pt accent, bodies the profile body size and colour.
    expect(xml.match(/sz="2000"/g) ?? []).toHaveLength(3)
    expect(xml.match(/sz="1400"/g) ?? []).toHaveLength(3)
  })

  it('rewrites an existing section watermark to the profile size', () => {
    const pkg = packageWith([sectionSlide()])
    const report = applyDesignProfile(pkg, { profile: PROFILE, pages: sectionPages })
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(report.markers).toBe(1)
    expect(xml).toContain('sz="8500"')
    expect(xml).not.toContain('sz="9000"')
    expect(xml).toContain('<a:srgbClr val="F2F7FA"/>')
  })

  it('adds the profile meta footer to cover and ending pages', () => {
    const pkg = packageWith([coverSlide(), coverSlide()])
    const report = applyDesignProfile(pkg, { profile: PROFILE, pages: coverPages, metaFooter: 'Probe Org' })
    expect(report.footers).toBe(2)
    for (const part of listSlides(pkg)) {
      const xml = pkg.text(part)
      expect(xml).toContain('dsh-profile-footer')
      expect(xml).toContain('Probe Org')
      expect(xml).toMatch(/z="1600"/)
    }
  })

  it('leaves deep pages untouched', () => {
    const pkg = packageWith([contentSlide()])
    const before = pkg.text('ppt/slides/slide1.xml')
    applyDesignProfile(pkg, { profile: PROFILE, pages: [{ index: 1, role: 'content', standard: false }] })
    expect(pkg.text('ppt/slides/slide1.xml')).toBe(before)
  })
})
