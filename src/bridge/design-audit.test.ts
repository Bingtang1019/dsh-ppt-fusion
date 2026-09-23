import { describe, expect, it } from 'vitest'
import { auditDesignPackage, DESIGN_DELTA_E_LIMIT, DESIGN_POSITION_TOLERANCE_IN, DESIGN_SIZE_TOLERANCE_PT } from './design-audit.ts'
import { OpcPackage } from './opc.ts'
import type { DesignProfile } from '../schema/design-profile.ts'
import type { FusionFinding } from '../audit.ts'

const SLIDE_SIZE = { cx: 12192000, cy: 6858000 }

/** The synthetic deck's design profile; the baseline XML reproduces it exactly. */
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

/** One text run in the generated slide XML. */
interface RunSpec {
  readonly sizePt: number
  readonly color: string
  readonly text: string
  readonly bold?: boolean
}

/** @returns the `a:r` XML for one styled run. */
function runXml(spec: RunSpec): string {
  const bold = spec.bold === true ? ' b="1"' : ''
  return `<a:r><a:rPr lang="zh-CN" sz="${String(Math.round(spec.sizePt * 100))}"${bold} dirty="0"><a:solidFill><a:srgbClr val="${spec.color.slice(1)}"/></a:solidFill><a:latin typeface="MiSans"/><a:ea typeface="MiSans"/></a:rPr><a:t>${spec.text}</a:t></a:r>`
}

/** @returns one `p:sp` with a text frame of runs at the given inch position. */
function shapeXml(input: { x: number; y: number; w: number; h: number; runs: readonly RunSpec[] }): string {
  const emu = (value: number): number => Math.round(value * 914400)
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(emu(input.x))}" y="${String(emu(input.y))}"/><a:ext cx="${String(emu(input.w))}" cy="${String(emu(input.h))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${input.runs.map(runXml).join('')}</a:p></p:txBody></p:sp>`
}

/** @returns a title shape at the role's anchor. */
function title(x: number, y: number, spec: RunSpec): string {
  return shapeXml({ x, y, w: 4, h: 1, runs: [spec] })
}

/** @returns the cover slide XML. */
function cover(meta: boolean): string {
  return [title(0.69, 3.08, { sizePt: 44, color: '#000000', text: '封面标题', bold: true }), ...(meta ? [shapeXml({ x: 1, y: 6.3, w: 3, h: 0.4, runs: [{ sizePt: 16, color: '#000000', text: '汇报人：测试' }] })] : [])].join('')
}

/** @returns the section slide XML. */
function section(watermark: boolean): string {
  return [
    title(0.64, 3.43, { sizePt: 34, color: '#0D0D0D', text: '第一章' }),
    ...(watermark ? [shapeXml({ x: 9, y: 1, w: 3, h: 2, runs: [{ sizePt: 85, color: '#F2F7FA', text: '01' }] })] : []),
  ].join('')
}

/** @returns one content slide with two columns and the given title/body/accent overrides. */
function content(input: { columns?: number; titleSize?: number; titleColor?: string; bodyColor?: string; accentColor?: string; pageNumber?: boolean } = {}): string {
  const columns = input.columns ?? 2
  const shapes = [title(0.59, 0.58, { sizePt: input.titleSize ?? 36, color: input.titleColor ?? '#0D0D0D', text: '内容页标题' })]
  const bodyColor = input.bodyColor ?? '#262626'
  for (let column = 0; column < columns; column += 1) {
    const x = 0.59 + column * 4.43
    shapes.push(
      shapeXml({ x, y: 1.2, w: 4, h: 0.5, runs: [{ sizePt: 20, color: input.accentColor ?? '#577FD2', text: `卡片${String(column + 1)}` }] }),
      shapeXml({
        x,
        y: 1.8,
        w: 4,
        h: 2,
        runs: [
          { sizePt: 14, color: bodyColor, text: `正文${String(column + 1)}上` },
          { sizePt: 14, color: bodyColor, text: `正文${String(column + 1)}下` },
        ],
      }),
    )
  }
  if (input.pageNumber === true) shapes.push(shapeXml({ x: 6.5, y: 7.0, w: 0.5, h: 0.3, runs: [{ sizePt: 12, color: '#595959', text: '3' }] }))
  return shapes.join('')
}

/** @returns the ending slide XML. */
function ending(meta: boolean): string {
  return [title(0.69, 3.79, { sizePt: 54, color: '#000000', text: '谢谢' }), ...(meta ? [shapeXml({ x: 1, y: 6.3, w: 3, h: 0.4, runs: [{ sizePt: 16, color: '#000000', text: '汇报人：测试' }] })] : [])].join('')
}

/** @returns a package with the synthetic deck's slides in presentation order. */
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

/** @returns the baseline deck: cover / section / two content pages / ending. */
function baseline(overrides: { content?: Parameters<typeof content>[0] } = {}): OpcPackage {
  return packageWith([cover(true), section(true), content(overrides.content), content(overrides.content), ending(true)])
}

/** The synthetic deck's slide roles, as a storyboard would declare them. */
const ROLES = new Map<number, 'cover' | 'section' | 'content' | 'ending'>([
  [1, 'cover'],
  [2, 'section'],
  [3, 'content'],
  [4, 'content'],
  [5, 'ending'],
])

/** @returns the findings for one package. */
function audit(pkg: OpcPackage, profile: DesignProfile = PROFILE): FusionFinding[] {
  return auditDesignPackage(pkg, { profile, roles: ROLES })
}

/** @returns the subset of findings with the given rule. */
function rules(findings: readonly FusionFinding[], rule: string): FusionFinding[] {
  return findings.filter((finding) => finding.rule === rule)
}

describe('auditDesignPackage', () => {
  it('accepts a deck that reproduces the profile', () => {
    expect(audit(baseline())).toEqual([])
  })

  it('reports wrong title and body sizes and colours', () => {
    expect(rules(audit(baseline({ content: { titleSize: 31 } })), 'design-role-title-font').map((finding) => finding.message)).toEqual([
      expect.stringContaining(`36 ±${String(DESIGN_SIZE_TOLERANCE_PT)} pt`),
    ])
    expect(rules(audit(baseline({ content: { titleColor: '#FF0000' } })), 'design-role-title-font').some((finding) => finding.message.includes('title colour'))).toBe(true)
    expect(rules(audit(baseline({ content: { bodyColor: '#FF0000' } })), 'design-role-title-font').some((finding) => finding.message.includes('body colour'))).toBe(true)
  })

  it('reports an off-profile accent colour and title anchor', () => {
    const accent = rules(audit(baseline({ content: { accentColor: '#00FF00' } })), 'design-accent-body-color')
    expect(accent).toHaveLength(1)
    expect(accent[0]?.message).toContain(`ΔE`)
    const wrongAnchor = packageWith([cover(true), section(true), shapeXml({ x: 0.2, y: 0.58, w: 4, h: 1, runs: [{ sizePt: 36, color: '#0D0D0D', text: '内容页标题' }] }), content(), ending(true)])
    const geometry = rules(audit(wrongAnchor), 'design-role-geometry')
    expect(geometry.some((finding) => finding.message.includes(`${String(DESIGN_POSITION_TOLERANCE_IN)} in`))).toBe(true)
  })

  it('reports a wrong column count and a missing section watermark', () => {
    expect(rules(audit(baseline({ content: { columns: 1 } })), 'design-role-geometry').some((finding) => finding.message.includes('column'))).toBe(true)
    expect(rules(audit(packageWith([cover(true), section(false), content(), content(), ending(true)])), 'design-section-marker')).toHaveLength(1)
  })

  it('reports chrome drift: an extra page number or a missing meta footer', () => {
    expect(rules(audit(baseline({ content: { pageNumber: true } })), 'design-chrome-match').some((finding) => finding.message.includes('page numbers'))).toBe(true)
    expect(rules(audit(packageWith([cover(false), section(true), content(), content(), ending(false)])), 'design-chrome-match').some((finding) => finding.message.includes('meta footer'))).toBe(true)
  })

  it('warns when the deck plays a role the profile does not describe', () => {
    const profile: DesignProfile = { ...PROFILE, typeScale: { ...PROFILE.typeScale, content: undefined }, roles: { ...PROFILE.roles, content: undefined } }
    const findings = audit(baseline(), profile)
    expect(rules(findings, 'design-role-unprofiled').every((finding) => finding.level === 'warning')).toBe(true)
    expect(findings.some((finding) => finding.level === 'error')).toBe(false)
  })

  it('names the colour tolerance it enforces', () => {
    expect(DESIGN_DELTA_E_LIMIT).toBe(3)
  })
})
