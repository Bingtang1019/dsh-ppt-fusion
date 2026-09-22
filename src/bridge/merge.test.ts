import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { OpcPackage, auditPackage, listSlides, resolveTarget } from './opc.ts'
import { mergeDeep } from './merge.ts'
import { findAlternateContents } from './compat.ts'
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

/** Add a slide to a package built by `deckWithChart`, wired into `p:sldIdLst`. */
function addSlide(pkg: OpcPackage, number: number, xml: string): void {
  pkg.setPart(`ppt/slides/slide${String(number)}.xml`, xml)
  pkg.setPart('ppt/presentation.xml', pkg.text('ppt/presentation.xml').replace('</p:sldIdLst>', `<p:sldId id="${String(256 + number)}" r:id="rId${String(number + 1)}"/></p:sldIdLst>`))
  pkg.setRelationships('ppt/presentation.xml', [
    ...pkg.relationshipsOf('ppt/presentation.xml'),
    { id: `rId${String(number + 1)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(number)}.xml` },
  ])
  pkg.ensureContentType(`ppt/slides/slide${String(number)}.xml`, CONTENT_TYPES['ppt/slides/slide1.xml'] ?? 'application/xml')
}

describe('merge compatibility discipline', () => {
  it('migrates an mc:AlternateContent pair without splitting it, image relationship included', async () => {
    const MCE = '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><mc:Choice Requires="a14"><a14:m>x</a14:m></mc:Choice><mc:Fallback><a:t>linear</a:t></mc:Fallback></mc:AlternateContent>'
    const base = deckWithChart()
    const deep = deckWithChart()
    deep.setPart('ppt/slides/slide1.xml', `<p:sld>${MCE}<p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:sld>`)
    deep.setRelationships('ppt/slides/slide1.xml', [
      { id: 'rId1', type: LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: CHART, target: '../charts/chart1.xml' },
      { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: '../media/image1.png' },
    ])
    deep.setPart('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    deep.ensureContentType('ppt/media/image1.png', 'image/png')

    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    const slide = merged.text('ppt/slides/slide1.xml')
    const blocks = findAlternateContents(slide)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.requires).toEqual(['a14'])
    expect(blocks[0]?.fallback).toContain('linear')
    expect(slide).toContain('mc:Choice')
    // The image the pair wraps came from the deep deck, so its relationship and part
    // must have been imported and rewritten together with the block.
    const imported = report.imported['ppt/media/image1.png']
    expect(imported).toBeDefined()
    const imageRel = merged.relationshipsOf('ppt/slides/slide1.xml').find((rel) => rel.type.endsWith('/image'))
    expect(imageRel?.target).toBe('../media/image1.png')
    expect(merged.has('ppt/media/image1.png')).toBe(true)
    expect(auditPackage(merged, { requireSingleMaster: true })).toEqual([])
  })

  it('renumbers duplicate p14:creationId values in every merged slide, deterministically', async () => {
    const base = deckWithChart()
    base.setPart('ppt/slides/slide1.xml', '<p:sld xmlns:p14="urn:p14" p14:creationId="3"><p:sp/></p:sld>')
    addSlide(base, 2, '<p:sld xmlns:p14="urn:p14" p14:creationId="3"><p:sp p14:creationId="3"/><p:sp p14:creationId="9"/></p:sld>')
    const deep = deckWithChart()
    deep.setPart('ppt/slides/slide1.xml', '<p:sld xmlns:p14="urn:p14" p14:creationId="5"><p:sp p14:creationId="5"/></p:sld>')

    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    expect(report.renumberedCreationIds).toBe(2)
    const ids = (name: string): number[] => [...merged.text(name).matchAll(/p14:creationId="(\d+)"/g)].map((match) => Number(match[1]))
    expect(ids('ppt/slides/slide1.xml')).toEqual([5, 6])
    expect(ids('ppt/slides/slide2.xml')).toEqual([3, 10, 9])
    // A second merge of the same inputs produces the same numbering.
    const again = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    expect(again.merged.text('ppt/slides/slide2.xml')).toBe(merged.text('ppt/slides/slide2.xml'))
    expect(auditPackage(merged, { requireSingleMaster: true })).toEqual([])
  })
})

describe('notes closure discipline', () => {
  const NOTES_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'
  const NOTES_MASTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster'
  const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
  const THEME_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'

  it('imports a notes closure without duplicating the replaced slide, and keeps its theme', async () => {
    const base = deckWithChart()
    const deep = deckWithChart()
    deep.setRelationships('ppt/slides/slide1.xml', [
      { id: 'rId1', type: LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: NOTES_SLIDE, target: '../notesSlides/notesSlide1.xml' },
    ])
    deep.setPart('ppt/notesSlides/notesSlide1.xml', '<p:notes/>')
    deep.setRelationships('ppt/notesSlides/notesSlide1.xml', [
      // A notes slide points back at its slide: the closure must resolve that to the
      // replaced base slide instead of importing a second copy of it.
      { id: 'rId1', type: SLIDE_REL, target: '../slides/slide1.xml' },
      { id: 'rId2', type: NOTES_MASTER, target: '../notesMasters/notesMaster1.xml' },
    ])
    deep.setPart('ppt/notesMasters/notesMaster1.xml', '<p:notesMaster/>')
    deep.setRelationships('ppt/notesMasters/notesMaster1.xml', [
      { id: 'rId1', type: THEME_REL, target: '../theme/theme2.xml' },
    ])
    deep.setPart('ppt/theme/theme2.xml', '<a:theme name="notes"/>')
    for (const name of ['ppt/notesSlides/notesSlide1.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/theme/theme2.xml']) {
      deep.ensureContentType(name, 'application/xml')
    }

    const { merged, report } = await mergeDeep({ base, deep, routes: [{ index: 1, deepSlide: 1 }] })
    expect(merged.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(1)
    const notesPart = report.imported['ppt/notesSlides/notesSlide1.xml']
    expect(notesPart).toBeDefined()
    const back = merged.relationshipsOf(notesPart ?? '').find((rel) => rel.type === SLIDE_REL)
    expect(back?.target).toBe('../slides/slide1.xml')
    const masterPart = report.imported['ppt/notesMasters/notesMaster1.xml']
    expect(masterPart).toBeDefined()
    const themeRel = merged.relationshipsOf(masterPart ?? '').find((rel) => rel.type === THEME_REL)
    expect(themeRel).toBeDefined()
    const themePart = themeRel === undefined ? '' : resolveTarget(masterPart ?? '', themeRel.target)
    expect(merged.has(themePart)).toBe(true)
    expect(auditPackage(merged, { requireSingleMaster: true })).toEqual([])
  })
})
