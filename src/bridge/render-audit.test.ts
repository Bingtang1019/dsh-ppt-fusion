import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createFakeFileSystem, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { auditRenderedPages, offPageFindings, overlapFindings, type RenderSlideGeometry } from './render-audit.ts'

const root = 'C:/deck/.dsh-ppt/render'
const canvas = { width: 12_192_000, height: 6_858_000 }

/** @param shapes - SVG rectangles drawn onto a white canvas. @returns PNG bytes. */
async function page(shapes: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ffffff"/>${shapes}</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** @param fs - fake filesystem. @param engine - engine id. @param pages - page files by index. @param bytes - page bytes by index. */
function snapshot(fs: FakeFileSystem, engine: string, pages: readonly number[], bytes: Map<number, Buffer>): void {
  const files = pages.map((index) => ({ index, file: `page-${String(index).padStart(4, '0')}.png`, width: 1280, height: 720, bytes: 10, sha256: 'x' }))
  fs.writeText(`${root}/${engine}/manifest.json`, JSON.stringify({ schemaVersion: 1, engine, engineVersion: 'test', cacheKey: 'k', source: 'out/deck.pptx', sourceSha256: 's', scale: 1, dpi: 96, maxPages: 30, maxPixels: 16_777_216, pages: files }))
  for (const index of pages) {
    const bytesForPage = bytes.get(index)
    if (bytesForPage === undefined) continue
    fs.writeBytes(`${root}/${engine}/page-${String(index).padStart(4, '0')}.png`, bytesForPage)
  }
}

/** @returns one slide whose single text box covers a tenth of the canvas. */
function slideWithBox(text = '正文', watermark = false): RenderSlideGeometry {
  return {
    index: 1,
    canvas,
    boxes: [{ x: 600_000, y: 600_000, w: 3_000_000, h: 1_000_000, text, sizePt: 14, watermark }],
  }
}

describe('auditRenderedPages', () => {
  it('reports a blank page and a decodable text page differently', async () => {
    const blank = createFakeFileSystem()
    snapshot(blank, 'libreoffice', [1], new Map([[1, await page('')]]))
    const blankSummary = await auditRenderedPages({ renderRoot: root, renderRelative: '.dsh-ppt/render', slideCount: 1, slides: [slideWithBox()], chrome: null, fs: blank })
    expect(blankSummary.engines).toEqual(['libreoffice'])
    expect(blankSummary.findings.map((finding) => finding.rule)).toContain('render-content-loss')
    expect(blankSummary.findings.map((finding) => finding.rule)).toContain('render-tofu')

    const inked = createFakeFileSystem()
    snapshot(inked, 'libreoffice', [1], new Map([[1, await page('<rect x="70" y="70" width="300" height="90" fill="#262626"/>')]]))
    const inkedSummary = await auditRenderedPages({ renderRoot: root, renderRelative: '.dsh-ppt/render', slideCount: 1, slides: [slideWithBox()], chrome: null, fs: inked })
    expect(inkedSummary.findings.map((finding) => finding.rule)).not.toContain('render-content-loss')
    expect(inkedSummary.findings.map((finding) => finding.rule)).not.toContain('render-tofu')
  })

  it('skips snapshots that are absent or carry the wrong page count', async () => {
    const missing = createFakeFileSystem()
    const empty = await auditRenderedPages({ renderRoot: root, renderRelative: '.dsh-ppt/render', slideCount: 2, slides: [slideWithBox()], chrome: null, fs: missing })
    expect(empty.engines).toEqual([])
    expect(empty.skipped).toContain('renderpages')

    const short = createFakeFileSystem()
    snapshot(short, 'powerpoint', [1], new Map([[1, await page('<rect x="70" y="70" width="300" height="90" fill="#262626"/>')]]))
    const summary = await auditRenderedPages({ renderRoot: root, renderRelative: '.dsh-ppt/render', slideCount: 2, slides: [slideWithBox()], chrome: null, fs: short })
    expect(summary.findings.map((finding) => finding.rule)).toContain('render-page-count')
  })

  it('reports overlapping and off-canvas text boxes from geometry alone', () => {
    const overlapping: RenderSlideGeometry = {
      index: 3,
      canvas,
      boxes: [
        { x: 0, y: 0, w: 2_000_000, h: 1_000_000, text: 'a', sizePt: 14, watermark: false },
        { x: 100_000, y: 100_000, w: 1_000_000, h: 500_000, text: 'b', sizePt: 14, watermark: false },
      ],
    }
    expect(overlapFindings([overlapping]).map((finding) => finding.rule)).toEqual(['render-overlap'])
    const outside: RenderSlideGeometry = {
      index: 4,
      canvas,
      boxes: [{ x: canvas.width - 100_000, y: 0, w: 5_000_000, h: 1_000_000, text: 'c', sizePt: 14, watermark: false }],
    }
    expect(offPageFindings([outside]).map((finding) => finding.rule)).toEqual(['render-off-page'])
    const watermark: RenderSlideGeometry = {
      index: 5,
      canvas,
      boxes: [{ x: canvas.width + 5_000_000, y: 0, w: 1_000_000, h: 1_000_000, text: '01', sizePt: 85, watermark: true }],
    }
    expect(offPageFindings([watermark])).toEqual([])
  })

  it('flags a page-number mark when the chrome declares none', async () => {
    const fs = createFakeFileSystem()
    snapshot(fs, 'libreoffice', [1], new Map([[1, await page('<rect x="1150" y="670" width="80" height="40" fill="#595959"/>')]]))
    const summary = await auditRenderedPages({
      renderRoot: root,
      renderRelative: '.dsh-ppt/render',
      slideCount: 1,
      slides: [{ ...slideWithBox(), role: 'content' }],
      chrome: { pageNumber: false, metaFooter: false, sectionMarker: false },
      fs,
    })
    expect(summary.findings.map((finding) => finding.rule)).toContain('render-chrome')
  })
})