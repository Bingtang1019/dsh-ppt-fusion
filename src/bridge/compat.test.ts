import { describe, expect, it } from 'vitest'
import { OpcPackage, REL, type Relationship } from './opc.ts'
import { applyCompatPass, findAlternateContents, inspectCompat, rasteriseWithSharp, serializeCompatReport } from './compat.ts'
import { COMPAT_LEVELS, loadCompatRegistry } from '../compat/registry.ts'

const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main'
const ASVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#123456"/></svg>'

/** Build a package whose slides carry the given XML, in `p:sldIdLst` order. */
function slidePackage(slides: readonly string[], slideRels: readonly (readonly Relationship[])[] = []): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const presentationRels: Relationship[] = []
  slides.forEach((xml, offset) => {
    const number = offset + 1
    const part = `ppt/slides/slide${String(number)}.xml`
    pkg.setPart(part, xml)
    const rels = slideRels[offset]
    if (rels !== undefined) pkg.setRelationships(part, rels)
    presentationRels.push({ id: `rId${String(number)}`, type: REL.slide, target: `slides/slide${String(number)}.xml` })
  })
  pkg.setPart(
    'ppt/presentation.xml',
    `<p:presentation><p:sldIdLst>${slides.map((_, offset) => `<p:sldId id="${String(256 + offset + 1)}" r:id="rId${String(offset + 1)}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  )
  pkg.setRelationships('ppt/presentation.xml', presentationRels)
  return pkg
}

/** The registry entry for one feature, so tests assert against the real policy. */
function feature(name: string): { minOffice: number; downgradeTo: string | null } {
  const entry = loadCompatRegistry().features.find((candidate) => candidate.feature === name)
  if (entry === undefined) throw new Error(`test asked for unknown feature ${name}`)
  return entry
}

describe('findAlternateContents', () => {
  it('records the choice ranges, the requires values and the fallback body', () => {
    const xml = `<p:sld><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="p159">A</mc:Choice><mc:Fallback>B</mc:Fallback></mc:AlternateContent></p:sld>`
    const blocks = findAlternateContents(xml)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.requires).toEqual(['p159'])
    expect(blocks[0]?.fallback).toBe('B')
    expect(blocks[0]?.choices).toHaveLength(1)
  })

  it('handles a nested block inside a choice', () => {
    const xml = `<mc:AlternateContent><mc:Choice Requires="a14"><mc:AlternateContent><mc:Choice Requires="w15"/><mc:Fallback>C</mc:Fallback></mc:AlternateContent></mc:Choice><mc:Fallback>D</mc:Fallback></mc:AlternateContent>`
    const blocks = findAlternateContents(xml)
    expect(blocks).toHaveLength(2)
    // Blocks close inner-first, so the nested one is recorded before its host.
    expect(blocks[0]?.requires).toEqual(['w15'])
    expect(blocks[0]?.fallback).toBe('C')
    expect(blocks[1]?.requires).toEqual(['a14'])
    expect(blocks[1]?.fallback).toBe('D')
  })
})

describe('compat scan and lint', () => {
  it('finds p14:dur and numbers the slide it sits on', () => {
    const pkg = slidePackage([`<p:sld><p:transition xmlns:p14="${P14}" p14:dur="400"><p:fade/></p:transition></p:sld>`])
    const inspection = inspectCompat(pkg, { level: 'standard' })
    expect(inspection.occurrences).toEqual([
      { feature: 'p14:dur', part: 'ppt/slides/slide1.xml', slide: 1, fallback: 'not-required', detail: 'p14:dur="400"' },
    ])
    expect(inspection.findings).toEqual([])
  })

  it('reports a partially wrapped MCE block instead of trusting it', () => {
    const pkg = slidePackage([`<p:sld><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="w15">A</mc:Choice></mc:AlternateContent></p:sld>`])
    const findings = inspectCompat(pkg, { level: 'max' }).findings
    expect(findings.map((finding) => finding.rule).sort()).toEqual(['mce-fallback-missing', 'namespace-undeclared', 'namespace-unregistered'])
    expect(findings.every((finding) => finding.level === 'error')).toBe(true)
  })

  it('reports an unclosed MCE block', () => {
    const pkg = slidePackage([`<p:sld><mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="a14">A</mc:Choice><mc:Fallback>B</mc:Fallback></p:sld>`])
    const findings = inspectCompat(pkg, { level: 'max' }).findings
    expect(findings.map((finding) => finding.rule)).toContain('mce-unclosed')
  })

  it('warns when a CJK run has no a:ea slot and stays quiet when it has one', () => {
    const missing = slidePackage([`<p:sld><p:txBody><a:p><a:r><a:rPr lang="zh-CN"/><a:t>\u4E2D\u6587</a:t></a:r></a:p></p:txBody></p:sld>`])
    const withSlot = slidePackage([`<p:sld><p:txBody><a:p><a:r><a:rPr lang="zh-CN"><a:ea typeface="SimSun"/></a:rPr><a:t>\u4E2D\u6587</a:t></a:r></a:p></p:txBody></p:sld>`])
    const warning = inspectCompat(missing, { level: 'standard' }).findings
    expect(warning.map((finding) => finding.rule)).toEqual(['compat-feature'])
    expect(warning[0]?.level).toBe('warning')
    expect(warning[0]?.message).toContain('a:ea')
    expect(inspectCompat(withSlot, { level: 'standard' }).findings).toEqual([])
  })

  it('treats duplicate p14:creationId values as an error, because the registry registers no downgrade', () => {
    const pkg = slidePackage([
      `<p:sld><p:timing xmlns:p14="${P14}" p14:creationId="111"><p:childTnLst p14:creationId="111"/></p:timing></p:sld>`,
    ])
    const findings = inspectCompat(pkg, { level: 'max' }).findings
    const duplicate = findings.find((finding) => finding.message.includes('duplicate'))
    expect(duplicate?.level).toBe('error')
    expect(duplicate?.message).toContain('no downgrade')
  })

  it('refuses an over-level chart when its registered downgrade needs content it cannot build', () => {
    const pkg = slidePackage(['<p:sld/>'])
    pkg.setPart('ppt/charts/chart1.xml', '<c:chartSpace><c:plotArea><c:treemapChart/></c:plotArea></c:chartSpace>')
    const safe = inspectCompat(pkg, { level: 'safe' }).findings
    expect(safe).toHaveLength(1)
    expect(safe[0]?.level).toBe('error')
    expect(safe[0]?.message).toContain('bar-chart')
    expect(safe[0]?.message).toContain('not implemented')
    expect(inspectCompat(pkg, { level: 'standard' }).findings).toEqual([])

    pkg.setPart('ppt/charts/chart1.xml', '<c:chartSpace><c:plotArea><c:mapChart/></c:plotArea></c:chartSpace>')
    const standard = inspectCompat(pkg, { level: 'standard' }).findings
    expect(standard).toHaveLength(1)
    expect(standard[0]?.message).toContain('Office 2019')
    expect(inspectCompat(pkg, { level: 'max' }).findings).toEqual([])
  })

  it('keeps the registry and the scanners from drifting apart', () => {
    const registry = loadCompatRegistry()
    const findings = inspectCompat(slidePackage(['<p:sld/>']), { level: 'standard', registry }).findings
    expect(findings.filter((finding) => finding.rule === 'feature-unscanned')).toEqual([])
    expect(COMPAT_LEVELS).toContain(inspectCompat(slidePackage(['<p:sld/>']), { level: 'max' }).level)
  })
})

describe('compat transform', () => {
  const morphSlide = `<p:sld><mc:AlternateContent xmlns:mc="m"><mc:Choice xmlns:p159="${P159}" xmlns:p14="${P14}" Requires="p159"><p:transition p14:dur="1000" p159:morph="byObject"><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition xmlns:p14="${P14}" p14:dur="1000"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent></p:sld>`

  it('unwraps the morph MCE block to its fallback at levels that forbid morph', async () => {
    const pkg = slidePackage([morphSlide])
    const report = await applyCompatPass(pkg, { level: 'standard' })
    expect(report.applied).toHaveLength(1)
    expect(report.applied[0]?.kind).toBe('downgrade')
    expect(report.applied[0]?.feature).toBe('morph-transition')
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(xml).not.toContain('mc:AlternateContent')
    expect(xml).not.toContain('p159:morph')
    expect(xml).toContain('<p:transition')
    expect(report.findings).toEqual([])
  })

  it('leaves morph alone at the max level, where it is allowed with its fallback', async () => {
    const pkg = slidePackage([morphSlide])
    const report = await applyCompatPass(pkg, { level: 'max' })
    expect(report.applied).toEqual([])
    expect(pkg.text('ppt/slides/slide1.xml')).toBe(morphSlide)
    expect(report.findings).toEqual([])
  })

  it('applies the registered fade downgrade to an unwrapped morph at max', async () => {
    const pkg = slidePackage([`<p:sld><p:transition xmlns:p14="${P14}" xmlns:p159="${P159}" p14:dur="1000" p159:morph="byObject"><p:fade/></p:transition></p:sld>`])
    const report = await applyCompatPass(pkg, { level: 'max' })
    expect(report.applied).toHaveLength(1)
    expect(report.applied[0]?.detail).toContain('p159:morph attribute removed')
    expect(pkg.text('ppt/slides/slide1.xml')).not.toContain('p159:morph')
    expect(pkg.text('ppt/slides/slide1.xml')).toContain('<p:fade/>')
    expect(report.findings).toEqual([])
  })

  it('replaces a bare p14 transition child with p:fade', async () => {
    const pkg = slidePackage([`<p:sld><p:transition xmlns:p14="${P14}"><p14:reveal/></p:transition></p:sld>`])
    const report = await applyCompatPass(pkg, { level: 'max' })
    expect(report.applied[0]?.detail).toContain('p14:reveal')
    expect(pkg.text('ppt/slides/slide1.xml')).toContain('<p:fade/>')
    expect(pkg.text('ppt/slides/slide1.xml')).not.toContain('p14:reveal')
    expect(report.findings).toEqual([])
  })
})

describe('compat stamp (B7)', () => {
  const slideWithSvgBlip = `<p:sld><p:pic><p:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541}"><asvg:svgBlip xmlns:asvg="${ASVG}" r:embed="rId3"/></a:ext></a:extLst></a:blip></p:blipFill></p:pic></p:sld>`

  function svgPackage(): OpcPackage {
    const pkg = slidePackage([slideWithSvgBlip], [[{ id: 'rId3', type: REL.image, target: '../media/image1.svg' }]])
    pkg.setPart('ppt/media/image1.svg', SVG)
    pkg.ensureContentType('ppt/media/image1.svg', 'image/svg+xml')
    return pkg
  }

  it('rasterises the referenced SVG with sharp and wires the PNG sibling', async () => {
    const pkg = svgPackage()
    const report = await applyCompatPass(pkg, { level: 'standard' })
    expect(report.applied).toHaveLength(1)
    expect(report.applied[0]?.kind).toBe('stamp')
    expect(pkg.has('ppt/media/image1.png')).toBe(true)
    expect(pkg.part('ppt/media/image1.png').subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(pkg.contentTypeOf('ppt/media/image1.png')).toBe('image/png')
    const xml = pkg.text('ppt/slides/slide1.xml')
    const embed = /\br:embed="([^"]+)"/.exec(xml)?.[1]
    const relationships = pkg.relationshipsOf('ppt/slides/slide1.xml')
    const rel = relationships.find((candidate) => candidate.id === embed)
    expect(rel?.target).toBe('../media/image1.png')
    expect(relationships).toHaveLength(2)
    expect(report.findings).toEqual([])
    expect(report.counts.stamps).toBe(1)
    expect(report.occurrences[0]?.fallback).toBe('complete')
  })

  it('uses an injected rasteriser without touching libvips', async () => {
    const pkg = svgPackage()
    const fake = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const report = await applyCompatPass(pkg, { level: 'safe', rasterise: async () => fake })
    expect(pkg.part('ppt/media/image1.png').equals(fake)).toBe(true)
    expect(report.applied[0]?.kind).toBe('stamp')
  })

  it('fails loudly when the SVG part is missing rather than stamping a broken link', async () => {
    const pkg = slidePackage([slideWithSvgBlip], [[{ id: 'rId3', type: REL.image, target: '../media/image1.svg' }]])
    await expect(applyCompatPass(pkg, { level: 'standard', rasterise: async () => Buffer.alloc(4) })).rejects.toMatchObject({ code: 'ContractViolation' })
  })

  it('rasterises a real SVG through the default sharp path', async () => {
    const png = await rasteriseWithSharp(Buffer.from(SVG))
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47')
    expect(png.length).toBeGreaterThan(50)
  })
})

describe('compat report', () => {
  it('is deterministic and carries the level, registry version and counts', async () => {
    const first = await applyCompatPass(slidePackage([`<p:sld><p:transition xmlns:p14="${P14}" p14:dur="400"><p:fade/></p:transition></p:sld>`]), { level: 'standard' })
    const second = await applyCompatPass(slidePackage([`<p:sld><p:transition xmlns:p14="${P14}" p14:dur="400"><p:fade/></p:transition></p:sld>`]), { level: 'standard' })
    expect(serializeCompatReport(first).replace(/"scannedAt": "[^"]+"/, '')).toBe(serializeCompatReport(second).replace(/"scannedAt": "[^"]+"/, ''))
    expect(first.schema).toBe('dsh-ppt-fusion.compat-report.v1')
    expect(first.level).toBe('standard')
    expect(first.registryVersion).toBe(loadCompatRegistry().version)
    expect(first.counts.occurrences).toBe(1)
    expect(feature('p14:dur').downgradeTo).toBeNull()
  })
})
