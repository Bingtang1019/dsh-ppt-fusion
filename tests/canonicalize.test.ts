import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { canonicalize, compareCanonical, describeComparison } from './support/canonicalize.ts'

/** The workbook's own core properties, in the shape a real embedded package uses. */
function nestedCore(created: string): string {
  return `<cp:coreProperties><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`
}

/** Build a minimal package; `core` and `workbook` are the interesting knobs. */
async function packageBytes(options: { core?: string; chart?: string; workbook?: Record<string, string> } = {}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'docProps/core.xml',
    `<cp:coreProperties><dc:title></dc:title><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${options.core ?? '2026-09-22T05:00:00Z'}</dcterms:created></cp:coreProperties>`,
  )
  zip.file('ppt/charts/chart1.xml', options.chart ?? '<c:chartSpace><c:ser><c:val>1</c:val></c:ser></c:chartSpace>')
  const workbook = new JSZip()
  workbook.file('[Content_Types].xml', '<Types/>')
  for (const [name, text] of Object.entries(options.workbook ?? { 'docProps/core.xml': nestedCore('2026-09-22T05:00:00Z') })) {
    workbook.file(name, text)
  }
  zip.file('ppt/embeddings/wb1.xlsx', await workbook.generateAsync({ type: 'nodebuffer' }))
  zip.file('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('canonicalize', () => {
  it('ignores producer timestamps and revision counters', async () => {
    const first = await canonicalize(await packageBytes({ core: '2026-09-22T05:00:00Z' }))
    const second = await canonicalize(await packageBytes({ core: '2026-09-22T09:31:11Z' }))
    expect(describeComparison(compareCanonical(first, second))).toContain('semantically equal')
  })

  it('recurses into an embedded workbook, which is where M0 measured the only real difference', async () => {
    const first = await canonicalize(await packageBytes({ workbook: { 'docProps/core.xml': nestedCore('2026-09-22T05:00:00Z') } }))
    const second = await canonicalize(await packageBytes({ workbook: { 'docProps/core.xml': nestedCore('2026-09-22T09:31:11Z') } }))
    expect(compareCanonical(first, second).equal).toBe(true)
  })

  it('still sees a real change inside the workbook', async () => {
    const first = await canonicalize(await packageBytes({ workbook: { 'xl/worksheets/sheet1.xml': '<sheetData><row>1</row></sheetData>' } }))
    const second = await canonicalize(await packageBytes({ workbook: { 'xl/worksheets/sheet1.xml': '<sheetData><row>2</row></sheetData>' } }))
    const comparison = compareCanonical(first, second)
    expect(comparison.equal).toBe(false)
    expect(comparison.differences.join(' ')).toContain('wb1.xlsx')
  })

  it('reports a changed chart and a changed binary part', async () => {
    const base = await canonicalize(await packageBytes())
    const chart = await canonicalize(await packageBytes({ chart: '<c:chartSpace><c:ser><c:val>2</c:val></c:ser></c:chartSpace>' }))
    expect(compareCanonical(base, chart).differences).toEqual(['differs: ppt/charts/chart1.xml'])

    const zip = await JSZip.loadAsync(await packageBytes())
    zip.file('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x48]))
    const other = await canonicalize(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(compareCanonical(base, other).differences).toEqual(['differs: ppt/media/image1.png'])
  })

  it('reports a part that only one package has', async () => {
    const withExtra = await packageBytes()
    const zip = await JSZip.loadAsync(withExtra)
    zip.file('ppt/slides/slide9.xml', '<p:sld/>')
    const other = await canonicalize(await zip.generateAsync({ type: 'nodebuffer' }))
    const comparison = compareCanonical(await canonicalize(withExtra), other)
    expect(comparison.differences).toEqual(['only in B: ppt/slides/slide9.xml'])
  })
})
