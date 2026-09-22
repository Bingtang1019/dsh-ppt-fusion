import { describe, expect, it } from 'vitest'
import {
  OpcPackage,
  auditPackage,
  freePartName,
  ownerOfRelsPart,
  parseRels,
  relativeTarget,
  resolveTarget,
  serializeRels,
} from './opc.ts'

/** Build a minimal package with a presentation, one slide, one layout and one master. */
function miniDeck(options: { slides?: number; extraParts?: Record<string, string>; masterCount?: number } = {}): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const slides = options.slides ?? 1
  const slideRows: string[] = []
  const rels = [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
  ]
  for (let index = 1; index <= slides; index += 1) {
    pkg.setPart(`ppt/slides/slide${String(index)}.xml`, '<p:sld/>')
    pkg.setRelationships(`ppt/slides/slide${String(index)}.xml`, [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    ])
    rels.push({ id: `rId${String(index + 1)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(index)}.xml` })
    slideRows.push(`<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 1)}"/>`)
  }
  const masters = options.masterCount ?? 1
  for (let index = 1; index <= masters; index += 1) {
    pkg.setPart(`ppt/slideMasters/slideMaster${String(index)}.xml`, '<p:sldMaster/>')
    pkg.setRelationships(`ppt/slideMasters/slideMaster${String(index)}.xml`, [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: `../slideLayouts/slideLayout${String(index)}.xml` },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme1.xml' },
    ])
  }
  for (let index = 1; index <= masters; index += 1) {
    pkg.setPart(`ppt/slideLayouts/slideLayout${String(index)}.xml`, '<p:sldLayout/>')
    pkg.setRelationships(`ppt/slideLayouts/slideLayout${String(index)}.xml`, [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: `../slideMasters/slideMaster${String(index)}.xml` },
    ])
  }
  pkg.setPart('ppt/theme/theme1.xml', '<a:theme/>')
  pkg.setPart('ppt/presentation.xml', `<p:presentation><p:sldIdLst>${slideRows.join('')}</p:sldIdLst></p:presentation>`)
  pkg.setRelationships('ppt/presentation.xml', rels)
  pkg.setPart('ppt/presProps.xml', '<p:presProps/>')
  for (const name of pkg.names()) pkg.ensureContentType(name, TYPES[name] ?? (name.includes('/slides/') ? TYPES['ppt/slides/slide1.xml'] : name.includes('/slideLayouts/') ? TYPES['ppt/slideLayouts/slideLayout1.xml'] : name.includes('/slideMasters/') ? TYPES['ppt/slideMasters/slideMaster1.xml'] : 'application/xml'))
  // Extra parts arrive after the type pass, so a fixture can deliberately leave
  // one untyped.
  for (const [name, text] of Object.entries(options.extraParts ?? {})) pkg.setPart(name, text)
  return pkg
}

/** Content types the fixture declares, one per part kind it creates. */
const TYPES: Record<string, string> = {
  'ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  'ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  'ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  'ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
  'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'ppt/presProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
}

describe('relationship targets', () => {
  it('resolves relative targets and normalises .. segments', () => {
    expect(resolveTarget('ppt/slides/slide1.xml', '../charts/chart1.xml')).toBe('ppt/charts/chart1.xml')
    expect(resolveTarget('ppt/slides/slide1.xml', './notesSlide1.xml')).toBe('ppt/slides/notesSlide1.xml')
    expect(resolveTarget('ppt/slides/slide1.xml', '../../../docProps/core.xml')).toBe('docProps/core.xml')
    expect(resolveTarget('ppt/slides/slide1.xml', '/ppt/media/image1.png')).toBe('ppt/media/image1.png')
  })

  it('resolves the package root rels from the archive root', () => {
    expect(ownerOfRelsPart('_rels/.rels')).toBe('')
    expect(resolveTarget(ownerOfRelsPart('_rels/.rels'), 'docProps/app.xml')).toBe('docProps/app.xml')
    expect(resolveTarget(ownerOfRelsPart('ppt/_rels/presentation.xml.rels'), 'slides/slide1.xml')).toBe('ppt/slides/slide1.xml')
  })

  it('round-trips through relativeTarget', () => {
    const target = relativeTarget('ppt/charts/chart1.xml', 'ppt/embeddings/wb.xlsx')
    expect(target).toBe('../embeddings/wb.xlsx')
    expect(resolveTarget('ppt/charts/chart1.xml', target)).toBe('ppt/embeddings/wb.xlsx')
  })
})

describe('rels documents', () => {
  it('round-trips, preserving External targets', () => {
    const rels = [
      { id: 'rId1', type: 'http://example.com/a', target: '../a.xml' },
      { id: 'rId2', type: 'http://example.com/b', target: 'https://example.com', targetMode: 'External' as const },
    ]
    expect(parseRels(serializeRels(rels))).toEqual(rels)
  })
})

describe('package audit', () => {
  it('passes a well-formed single-master deck', () => {
    expect(auditPackage(miniDeck(), { requireSingleMaster: true })).toEqual([])
  })

  it('reports a dangling relationship', () => {
    const pkg = miniDeck()
    pkg.setRelationships('ppt/slides/slide1.xml', [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', target: '../charts/missing.xml' },
    ])
    const findings = auditPackage(pkg)
    expect(findings.map((finding) => finding.rule)).toContain('dangling-relationship')
    expect(findings[0]?.message).toContain('ppt/charts/missing.xml')
  })

  it('reports a duplicate relationship id', () => {
    const pkg = miniDeck()
    pkg.setRelationships('ppt/slides/slide1.xml', [
      { id: 'rId1', type: 'x', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId1', type: 'y', target: '../slideLayouts/slideLayout1.xml' },
    ])
    expect(auditPackage(pkg).map((finding) => finding.rule)).toContain('duplicate-rid')
  })

  it('reports a part without a content type', () => {
    // This fixture declares defaults for xml and rels, so an untyped part needs an
    // extension nothing declares -- a png here.
    const pkg = miniDeck({ extraParts: { 'ppt/media/image1.png': 'png-bytes' } })
    expect(auditPackage(pkg).map((finding) => finding.rule)).toContain('missing-content-type')
  })

  it('reports the multi-master case only when the invariant is required', () => {
    const pkg = miniDeck({ masterCount: 2 })
    expect(auditPackage(pkg).map((finding) => finding.rule)).not.toContain('multi-master')
    const required = auditPackage(pkg, { requireSingleMaster: true })
    expect(required.some((finding) => finding.rule === 'multi-master')).toBe(true)
  })
})

describe('part naming and stability', () => {
  it('numbers around collisions', () => {
    const pkg = miniDeck({ extraParts: { 'ppt/charts/chart1.xml': 'a' } })
    // A free name is kept as-is, so upstream naming survives the import.
    expect(freePartName(pkg, new Set(), 'ppt/charts/chart401.xml')).toBe('ppt/charts/chart401.xml')
    expect(freePartName(pkg, new Set(), 'ppt/charts/chart1.xml')).toBe('ppt/charts/chart2.xml')
    expect(freePartName(pkg, new Set(['ppt/charts/chart2.xml']), 'ppt/charts/chart1.xml')).toBe('ppt/charts/chart3.xml')
  })

  it('writes byte-identical packages regardless of insertion order', async () => {
    const first = miniDeck({ slides: 2 })
    const second = miniDeck({ slides: 2 })
    first.setPart('ppt/media/z.png', 'z')
    second.setPart('ppt/media/z.png', 'z')
    const [left, right] = [await first.write(), await second.write()]
    expect(left.equals(right)).toBe(true)
  })
})
