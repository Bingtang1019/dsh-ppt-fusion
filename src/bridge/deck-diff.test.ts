import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createFakeFileSystem } from '../../tests/support/fake-runner.ts'
import { OpcPackage } from './opc.ts'
import { diffAudit, diffRender, diffSemantic } from './deck-diff.ts'
import type { FusionFinding } from '../audit.ts'

/** A slide carrying `shapes` rectangles and optionally chart values. */
function slideXml(options: { shapes: number; chartValues?: readonly number[]; title?: string }): string {
  const shapes = Array.from({ length: options.shapes }, (_unused, index) => `<p:sp><p:nvSpPr><p:cNvPr id="${String(index + 2)}" name="shape${String(index)}"/></p:nvSpPr></p:sp>`).join('')
  const graphic = options.chartValues === undefined ? '' : '<p:graphicFrame/>'
  return `<p:sld><p:cSld>${options.title === undefined ? '' : `<p:sp><p:txBody><a:p><a:r><a:t>${options.title}</a:t></a:r></a:p></p:txBody></p:sp>`}${shapes}${graphic}</p:cSld></p:sld>`
}

/** A chart part with the given plotted values. */
function chartXml(values: readonly number[]): string {
  return `<c:chartSpace>${values.map((value, index) => `<c:ser><c:pt idx="${String(index)}"><c:v>${String(value)}</c:v></c:pt></c:ser>`).join('')}</c:chartSpace>`
}

/**
 * @param options.slides - one entry per slide.
 * @param options.chartOnSlide - 1-based slide carrying `ppt/charts/chart1.xml`.
 * @returns package bytes.
 */
async function deck(options: { slides: readonly string[]; chartOnSlide?: number; chart?: readonly number[]; core?: string }): Promise<Buffer> {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const relationships = [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' }]
  const rows: string[] = []
  options.slides.forEach((xml, offset) => {
    const index = offset + 1
    pkg.setPart(`ppt/slides/slide${String(index)}.xml`, xml)
    const slideRels = [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' }]
    if (options.chartOnSlide === index && options.chart !== undefined) {
      pkg.setPart('ppt/charts/chart1.xml', chartXml(options.chart))
      slideRels.push({ id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', target: '../charts/chart1.xml' })
    }
    pkg.setRelationships(`ppt/slides/slide${String(index)}.xml`, slideRels)
    relationships.push({ id: `rId${String(index + 1)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(index)}.xml` })
    rows.push(`<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 1)}"/>`)
  })
  pkg.setPart('ppt/presentation.xml', `<p:presentation><p:sldIdLst>${rows.join('')}</p:sldIdLst></p:presentation>`)
  pkg.setRelationships('ppt/presentation.xml', relationships)
  pkg.setPart('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>')
  pkg.setRelationships('ppt/slideMasters/slideMaster1.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme1.xml' },
  ])
  pkg.setPart('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout/>')
  pkg.setRelationships('ppt/slideLayouts/slideLayout1.xml', [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: '../slideMasters/slideMaster1.xml' }])
  pkg.setPart('ppt/theme/theme1.xml', '<a:theme/>')
  pkg.setPart('docProps/core.xml', options.core ?? '<cp:coreProperties><dcterms:created>2026-09-27T01:00:00Z</dcterms:created><cp:revision>1</cp:revision></cp:coreProperties>')
  return pkg.write()
}

/** @returns the package bytes with one part replaced. */
async function withPart(bytes: Buffer, part: string, xml: string): Promise<Buffer> {
  const pkg = await OpcPackage.read(bytes)
  pkg.setPart(part, xml)
  return pkg.write()
}
describe('semantic diff', () => {
  it('calls two exports of the same deck equal even when producer metadata differs', async () => {
    const left = await deck({ slides: [slideXml({ shapes: 2 }), slideXml({ shapes: 1 })] })
    const right = await deck({
      slides: [slideXml({ shapes: 2 }), slideXml({ shapes: 1 })],
      core: '<cp:coreProperties><dcterms:created>2026-09-27T09:00:00Z</dcterms:created><cp:revision>9</cp:revision></cp:coreProperties>',
    })
    const diff = await diffSemantic(left, right)
    expect(diff.equal).toBe(true)
    expect(diff.pages.every((page) => page.status === 'same')).toBe(true)
    expect(diff.summary).toMatch(/semantically identical/)
  })

  it('reports a modified page with the part that changed and the shape delta', async () => {
    const left = await deck({ slides: [slideXml({ shapes: 1 }), slideXml({ shapes: 2 })] })
    const right = await deck({ slides: [slideXml({ shapes: 1 }), slideXml({ shapes: 4 })] })
    const diff = await diffSemantic(left, right)
    expect(diff.equal).toBe(false)
    const page = diff.pages.find((entry) => entry.index === 2)
    expect(page?.status).toBe('modified')
    expect(page?.changedParts).toEqual(['ppt/slides/slide2.xml'])
    expect(page?.notes.some((note) => note.includes('p:sp +2'))).toBe(true)
    expect(diff.pages.find((entry) => entry.index === 1)?.status).toBe('same')
  })

  it('reports added and removed pages', async () => {
    const short = await deck({ slides: [slideXml({ shapes: 1 })] })
    const long = await deck({ slides: [slideXml({ shapes: 1 }), slideXml({ shapes: 3 })] })
    const grown = await diffSemantic(short, long)
    expect(grown.pages.find((entry) => entry.index === 2)?.status).toBe('added')
    expect(grown.summary).toMatch(/1 added/)
    const shrunk = await diffSemantic(long, short)
    expect(shrunk.pages.find((entry) => entry.index === 2)?.status).toBe('removed')
    expect(shrunk.summary).toMatch(/1 removed/)
  })

  it('tells chart data changes from formatting changes', async () => {
    const left = await deck({ slides: [slideXml({ shapes: 1 })], chartOnSlide: 1, chart: [1, 2, 3] })
    const dataChanged = await deck({ slides: [slideXml({ shapes: 1 })], chartOnSlide: 1, chart: [1, 2, 9] })
    const dataDiff = await diffSemantic(left, dataChanged)
    expect(dataDiff.pages[0]?.notes.some((note) => note.includes('(data)'))).toBe(true)

    const formatting = await deck({ slides: [slideXml({ shapes: 1 })], chartOnSlide: 1, chart: [1, 2, 3] })
    const renamed = await deck({ slides: [slideXml({ shapes: 1 })], chartOnSlide: 1, chart: [1, 2, 3] })
    expect((await diffSemantic(formatting, renamed)).equal).toBe(true)
  })

  it('reports a part that changed outside every slide', async () => {
    const left = await deck({ slides: [slideXml({ shapes: 1 })] })
    const right = await deck({ slides: [slideXml({ shapes: 1 })] })
    const patched = await withPart(right, 'ppt/presentation.xml', '<p:presentation sldSz="1"><p:sldIdLst><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>')
    const diff = await diffSemantic(left, patched)
    expect(diff.globalParts).toContain('ppt/presentation.xml')
    expect(diff.summary).toMatch(/shared part/)
  })

  it('attributes a theme change to the page that depends on it', async () => {
    const left = await deck({ slides: [slideXml({ shapes: 1 })] })
    const right = await withPart(await deck({ slides: [slideXml({ shapes: 1 })] }), 'ppt/theme/theme1.xml', '<a:theme><a:themeElements/></a:theme>')
    const diff = await diffSemantic(left, right)
    expect(diff.globalParts).not.toContain('ppt/theme/theme1.xml')
    expect(diff.pages[0]?.status).toBe('modified')
    expect(diff.pages[0]?.changedParts).toContain('ppt/theme/theme1.xml')
  })
})

describe('audit diff', () => {
  const finding = (rule: string, page: number, level: FusionFinding['level'] = 'error'): FusionFinding => ({ level, source: 'pptx', rule, message: `${rule} on ${String(page)}`, page })

  it('splits added, removed and unchanged findings', () => {
    const left = [finding('render-overflow', 2), finding('render-contrast', 4, 'warning')]
    const right = [finding('render-overflow', 2), finding('render-off-page', 5)]
    const delta = diffAudit(left, right)
    expect(delta.added.map((entry) => entry.rule)).toEqual(['render-off-page'])
    expect(delta.removed.map((entry) => entry.rule)).toEqual(['render-contrast'])
    expect(delta.unchanged).toBe(1)
    expect(delta.summary).toMatch(/1 added \(1 error/)
  })

  it('reports an unchanged audit', () => {
    const findings = [finding('render-overflow', 2)]
    expect(diffAudit(findings, [...findings]).summary).toMatch(/audit unchanged/)
  })
})

describe('render diff', () => {
  it('measures the share of differing pixels per page', async () => {
    const { default: sharp } = await import('sharp')
    const plain = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer()
    const halfBlack = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: { create: { width: 160, height: 180, channels: 3, background: { r: 0, g: 0, b: 0 } } }, left: 0, top: 0 }])
      .png()
      .toBuffer()
    const fs = createFakeFileSystem({ directories: [join(process.cwd(), 'tmp', 'render-a'), join(process.cwd(), 'tmp', 'render-b')] })
    fs.writeBytes(join(process.cwd(), 'tmp', 'render-a', 'page-0001.png'), plain)
    fs.writeBytes(join(process.cwd(), 'tmp', 'render-a', 'page-0002.png'), plain)
    fs.writeBytes(join(process.cwd(), 'tmp', 'render-b', 'page-0001.png'), plain)
    fs.writeBytes(join(process.cwd(), 'tmp', 'render-b', 'page-0002.png'), halfBlack)
    fs.writeBytes(join(process.cwd(), 'tmp', 'render-b', 'page-0003.png'), plain)
    const diff = await diffRender(join(process.cwd(), 'tmp', 'render-a'), join(process.cwd(), 'tmp', 'render-b'), { fs })
    expect(diff.compared).toBe(2)
    expect(diff.pages.find((page) => page.index === 1)?.rate).toBeLessThan(0.01)
    expect(diff.pages.find((page) => page.index === 2)?.rate).toBeGreaterThan(0.4)
    expect(diff.onlyRight).toEqual([3])
    expect(diff.summary).toMatch(/page\(s\) compared/)
  })

  it('reports nothing to compare when a side has no snapshots', async () => {
    const diff = await diffRender(null, null, { fs: createFakeFileSystem() })
    expect(diff.compared).toBe(0)
    expect(diff.summary).toMatch(/no pages to compare/)
  })
})