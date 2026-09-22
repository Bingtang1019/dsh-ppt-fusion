import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { OpcPackage, auditPackage, listSlides } from './opc.ts'
import { mergeDeep } from './merge.ts'
import { DshPptFailure } from '../engine/errors.ts'

const LAYOUT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart'
const PACKAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package'

/** A deck whose slide 1 carries a chart and an embedded workbook. */
function deckWithChart(options: { chartXml?: string; workbook?: string } = {}): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  pkg.setPart('ppt/slides/slide1.xml', '<p:sld><p:sp/></p:sld>')
  pkg.setRelationships('ppt/slides/slide1.xml', [
    { id: 'rId1', type: LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: CHART, target: '../charts/chart1.xml' },
  ])
  pkg.setPart('ppt/charts/chart1.xml', options.chartXml ?? '<c:chartSpace/>')
  pkg.setRelationships('ppt/charts/chart1.xml', [{ id: 'rId1', type: PACKAGE, target: '../embeddings/wb1.xlsx' }])
  pkg.setPart('ppt/embeddings/wb1.xlsx', options.workbook ?? 'workbook-bytes')
  pkg.setPart('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout/>')
  pkg.setRelationships('ppt/slideLayouts/slideLayout1.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: '../slideMasters/slideMaster1.xml' },
  ])
  pkg.setPart('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>')
  pkg.setPart('ppt/theme/theme1.xml', '<a:theme/>')
  pkg.setPart('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>')
  pkg.setRelationships('ppt/presentation.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
  ])
  for (const name of ['ppt/slides/slide1.xml', 'ppt/charts/chart1.xml', 'ppt/embeddings/wb1.xlsx', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml', 'ppt/presentation.xml']) {
    pkg.ensureContentType(name, CONTENT_TYPES[name] ?? 'application/xml')
  }
  return pkg
}

const CONTENT_TYPES: Record<string, string> = {
  'ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  'ppt/charts/chart1.xml': 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  'ppt/embeddings/wb1.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  'ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  'ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
  'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
}

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('mergeDeep', () => {
  it('replaces a base slide, imports its closure and keeps one master', async () => {
    const base = deckWithChart({ chartXml: '<c:chartSpace/>' })
    const deep = deckWithChart({ chartXml: '<c:chartSpace>deep</c:chartSpace>', workbook: 'deep-workbook' })
    deep.setPart('ppt/charts/chart1.xml', '<c:chartSpace>deep</c:chartSpace>')
    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    expect(report.replaced).toEqual([{ index: 1, basePart: 'ppt/slides/slide1.xml', deepPart: 'ppt/slides/slide1.xml' }])
    expect(merged.text('ppt/slides/slide1.xml')).toContain('<p:sld><p:sp/></p:sld>')
    // Both decks name their chart `chart1.xml`; the contents differ, so the deep
    // one is imported under a new name and the base's stays where it was.
    expect(report.imported['ppt/charts/chart1.xml']).toBe('ppt/charts/chart2.xml')
    expect(merged.text('ppt/charts/chart2.xml')).toContain('deep')
    expect(merged.text('ppt/charts/chart1.xml')).toContain('<c:chartSpace/>')
    expect(auditPackage(merged, { requireSingleMaster: true }).map((finding) => finding.rule + ': ' + finding.message)).toEqual([])
    expect(merged.names().filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name))).toHaveLength(1)
  })

  it('remaps the deep slide onto the base layout, so no deep layout is imported', async () => {
    const base = deckWithChart()
    const deep = deckWithChart()
    deep.setPart('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout>deep</p:sldLayout>')
    deep.setRelationships('ppt/slides/slide1.xml', [
      { id: 'rId1', type: LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: CHART, target: '../charts/chart1.xml' },
    ])
    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    expect(merged.text('ppt/slideLayouts/slideLayout1.xml')).not.toContain('deep')
    expect(report.layoutRemap['ppt/slides/slide1.xml']).toBe('ppt/slideLayouts/slideLayout1.xml')
    expect(report.dropped.some((name) => name.includes('slideLayouts'))).toBe(true)
    expect(report.multiMaster).toBe(false)
  })

  it('reuses an identical part instead of importing a duplicate', async () => {
    const shared = '<c:chartSpace>identical</c:chartSpace>'
    const base = deckWithChart({ chartXml: shared, workbook: 'same-workbook' })
    const deep = deckWithChart({ chartXml: shared, workbook: 'same-workbook' })
    const { report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    expect(Object.keys(report.reused).length).toBeGreaterThan(0)
  })

  it('renames an imported part whose name the base already uses for different content', async () => {
    const base = deckWithChart({ chartXml: '<c:chartSpace>base</c:chartSpace>' })
    const deep = deckWithChart({ chartXml: '<c:chartSpace>deep</c:chartSpace>' })
    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    const importedChart = report.imported['ppt/charts/chart1.xml']
    expect(importedChart).not.toBe('ppt/charts/chart1.xml')
    expect(merged.text(importedChart ?? '')).toContain('deep')
    expect(merged.text('ppt/charts/chart1.xml')).toContain('base')
    // The slide must point at the imported chart, not the base's.
    const rels = merged.relationshipsOf('ppt/slides/slide1.xml')
    expect(rels.some((rel) => rel.type === CHART && rel.target.includes(String(importedChart).replace('ppt/charts/', '')))).toBe(true)
  })

  it('rewrites the imported chart relationship to its workbook', async () => {
    const base = deckWithChart({ chartXml: '<c:chartSpace>base</c:chartSpace>', workbook: 'base-wb' })
    const deep = deckWithChart({ chartXml: '<c:chartSpace>deep</c:chartSpace>', workbook: 'deep-wb' })
    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    const chart = report.imported['ppt/charts/chart1.xml'] ?? ''
    const workbook = report.imported['ppt/embeddings/wb1.xlsx'] ?? ''
    const rels = merged.relationshipsOf(chart)
    expect(rels[0]?.target).toBe(`../embeddings/${workbook.replace('ppt/embeddings/', '')}`)
    expect(merged.text(chart)).toContain('deep')
  })

  it('merges several routes in deck order and preserves the slide list', async () => {
    const base = deckWithChart()
    base.setPart('ppt/slides/slide2.xml', '<p:sld>two</p:sld>')
    base.setRelationships('ppt/slides/slide2.xml', [{ id: 'rId1', type: LAYOUT, target: '../slideLayouts/slideLayout1.xml' }])
    base.setPart(
      'ppt/presentation.xml',
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>',
    )
    base.setRelationships('ppt/presentation.xml', [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' },
      { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide2.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
    ])
    base.ensureContentType('ppt/slides/slide2.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml')
    const deep = deckWithChart({ chartXml: '<c:chartSpace>deep-one</c:chartSpace>' })
    deep.setPart('ppt/slides/slide2.xml', '<p:sld>deep-two</p:sld>')
    deep.setRelationships('ppt/slides/slide2.xml', [{ id: 'rId1', type: LAYOUT, target: '../slideLayouts/slideLayout1.xml' }])
    deep.setPart(
      'ppt/presentation.xml',
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>',
    )
    deep.setRelationships('ppt/presentation.xml', [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' },
      { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide2.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
    ])
    const { merged, report } = await mergeDeep({
      base,
      deep,
      routes: [
        { index: 1, deepSlide: 1 },
        { index: 2, deepSlide: 2 },
      ],
    })
    expect(report.replaced.map((entry) => entry.index)).toEqual([1, 2])
    expect(listSlides(merged)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
    expect(merged.text('ppt/slides/slide2.xml')).toContain('deep-two')
  })

  it('is byte-stable for identical inputs (tier T2 for our own writer)', async () => {
    const base = deckWithChart()
    const deep = deckWithChart({ chartXml: '<c:chartSpace>deep</c:chartSpace>' })
    const first = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    const second = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    const [left, right] = [await first.merged.write(), await second.merged.write()]
    expect(createHash('sha256').update(left).digest('hex')).toBe(createHash('sha256').update(right).digest('hex'))
  })

  it('refuses a route beyond either deck', async () => {
    const base = deckWithChart()
    const deep = deckWithChart()
    expect(await codeOf(() => mergeDeep({ base, deep, routes: [{ index: 2, deepSlide: 1 }] }))).toBe('ContractViolation')
    expect(await codeOf(() => mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 3 }] }))).toBe('ContractViolation')
    expect(await codeOf(() => mergeDeep({ base, deep, routes: [] }))).toBe('ContractViolation')
  })

  it('takes the multi-master escape hatch only when asked', async () => {
    const base = deckWithChart()
    const deep = deckWithChart()
    deep.setPart('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster>deep</p:sldMaster>')
    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }], merge: { allowMultiMaster: true } })
    expect(report.multiMaster).toBe(true)
    expect(report.dropped).toEqual([])
    const masters = merged.names().filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name))
    expect(masters.length).toBeGreaterThanOrEqual(1)
    const rels = merged.relationshipsOf('ppt/presentation.xml')
    expect(rels.filter((rel) => rel.type.endsWith('/slideMaster')).length).toBe(masters.length)
    expect(merged.text('ppt/presentation.xml')).toContain('sldMasterIdLst')
  })
})
