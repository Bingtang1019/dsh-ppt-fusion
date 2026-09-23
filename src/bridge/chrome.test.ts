import { describe, expect, it } from 'vitest'
import { applyChrome, auditChrome, chromePagesFrom, deterministicFieldId, isBakedPageNumber, slideSize } from './chrome.ts'
import { OpcPackage } from './opc.ts'
import { defaultChrome } from '../schema/fusion.ts'
import type { FusionFinding } from '../audit.ts'
import type { TokensFile } from '../schema/tokens.ts'
import { DshPptFailure } from '../engine/errors.ts'

const TOKENS = {
  schema: 'dsh-ppt-fusion.tokens.v1',
  themeId: 'brief',
  source: { kind: 'preset', preset: 'brief' },
  colors: {
    bg: '#FFFFFF',
    surface: '#FFFFFF',
    primary: '#F5C518',
    accent: '#1E2A4A',
    text: '#1C1E23',
    muted: '#5B6069',
    border: '#DDDCD4',
    chartPalette: ['#1E2A4A'],
  },
  fonts: { heading: ['Georgia'], body: ['Arial'] },
  shape: {},
  defaultBackgrounds: {},
} as unknown as TokensFile

const SLIDE_SIZE = { cx: 12192000, cy: 6858000 }

/** The baked badge pptwise's content layout draws: bottom-right, translucent, one number. */
const BAKED = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Text 16"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="10515600" y="5494020"/><a:ext cx="914400" cy="457200"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr algn="r"/><a:r><a:rPr><a:solidFill><a:srgbClr val="5B6069"><a:alpha val="30000"/></a:srgbClr></a:solidFill></a:rPr><a:t>02</a:t></a:r></a:p></p:txBody></p:sp>`

/** The same badge as pptwise actually renders it: a full-width bottom bar. */
const BAKED_BAR = `<p:sp><p:nvSpPr><p:cNvPr id="10" name="Text 8"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="5494020"/><a:ext cx="11277600" cy="731520"/></a:xfrm></p:spPr><p:txBody><a:bodyPr wrap="none"/><a:p><a:pPr algn="r"/><a:r><a:rPr lang="en-US" sz="4800"><a:solidFill><a:srgbClr val="5B6069"><a:alpha val="30000"/></a:srgbClr></a:solidFill></a:rPr><a:t>02</a:t></a:r></a:p></p:txBody></p:sp>`

/** A legit body figure: centred, opaque, large — must survive the strip. */
const BODY_DIGIT = `<p:sp><p:nvSpPr><p:cNvPr id="10" name="big-number"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1371600" y="2743200"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>42</a:t></a:r></a:p></p:txBody></p:sp>`

/** @returns a slide with the given shapes inside its shape tree. */
function slideXml(shapes = ''): string {
  return `<p:sld><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>${shapes}</p:spTree></p:cSld></p:sld>`
}

/** @returns a package with `slides` slides, each carrying the same shapes. */
function miniPackage(slides: number, shapes = ''): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const rows: string[] = []
  const rels: { id: string; type: string; target: string }[] = []
  for (let index = 1; index <= slides; index += 1) {
    pkg.setPart(`ppt/slides/slide${String(index)}.xml`, slideXml(shapes))
    rels.push({ id: `rId${String(index)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(index)}.xml` })
    rows.push(`<p:sldId id="${String(255 + index)}" r:id="rId${String(index)}"/>`)
  }
  pkg.setPart('ppt/presentation.xml', `<p:presentation><p:sldSz cx="${String(SLIDE_SIZE.cx)}" cy="${String(SLIDE_SIZE.cy)}"/><p:sldIdLst>${rows.join('')}</p:sldIdLst></p:presentation>`)
  pkg.setRelationships('ppt/presentation.xml', rels)
  for (const name of pkg.names()) pkg.ensureContentType(name, 'application/xml')
  return pkg
}

const pages = (roles: readonly ('cover' | 'content' | 'ending')[], sections: Record<number, string> = {}) =>
  chromePagesFrom(
    roles.map((_role, offset) => ({ index: offset + 1, ...(sections[offset + 1] === undefined ? {} : { section: sections[offset + 1] }) })),
    (index) => roles[index - 1] ?? 'content',
  )

describe('slideSize', () => {
  it('reads the canvas from presentation.xml and falls back to 16:9', () => {
    expect(slideSize(miniPackage(1))).toEqual(SLIDE_SIZE)
    const bare = new OpcPackage()
    expect(slideSize(bare)).toEqual({ cx: 12192000, cy: 6858000 })
  })
})

describe('deterministicFieldId', () => {
  it('is stable per seed, UUID-shaped, and differs across seeds', () => {
    const first = deterministicFieldId('page-number:2')
    expect(first).toBe(deterministicFieldId('page-number:2'))
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first).not.toBe(deterministicFieldId('page-number:3'))
  })
})

describe('isBakedPageNumber', () => {
  it('recognizes the translucent bottom-right badge the layout draws', () => {
    expect(isBakedPageNumber(BAKED, SLIDE_SIZE)).toBe(true)
    expect(isBakedPageNumber(BAKED_BAR, SLIDE_SIZE)).toBe(true)
  })

  it('leaves body figures, opaque numbers and large numerals alone', () => {
    expect(isBakedPageNumber(BODY_DIGIT, SLIDE_SIZE)).toBe(false)
    expect(isBakedPageNumber(BAKED.replace('val="30000"', 'val="100000"'), SLIDE_SIZE)).toBe(false)
    expect(isBakedPageNumber(BAKED.replace('>02<', '>2026<'), SLIDE_SIZE)).toBe(false)
    expect(isBakedPageNumber(BAKED.replace('y="5494020"', 'y="2743200"'), SLIDE_SIZE)).toBe(false)
    expect(isBakedPageNumber(BAKED.replace('<a:pPr algn="r"/>', '<a:pPr algn="l"/>'), SLIDE_SIZE)).toBe(false)
    expect(isBakedPageNumber('<p:sp><p:nvSpPr><p:cNvPr id="3" name="x"/></p:nvSpPr></p:sp>', SLIDE_SIZE)).toBe(false)
  })
})

describe('applyChrome', () => {
  it('injects one native slide-number field on non-skipped pages only', () => {
    const pkg = miniPackage(3)
    const report = applyChrome(pkg, { chrome: defaultChrome(), pages: pages(['cover', 'content', 'ending']), tokens: TOKENS })
    const [first, second, third] = pkg.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => pkg.text(name))
    expect(first).not.toContain('type="slidenum"')
    expect(second).toContain('type="slidenum"')
    expect(third).not.toContain('type="slidenum"')
    expect(report.slides.map((slide) => slide.pageNumber)).toEqual([false, true, false])
  })

  it('strips the baked page number and keeps a body figure', () => {
    const pkg = miniPackage(1, BAKED + BODY_DIGIT)
    const report = applyChrome(pkg, { chrome: defaultChrome(), pages: pages(['content']), tokens: TOKENS })
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(report.slides[0]?.stripped).toBe(1)
    expect(xml).not.toContain('>02<')
    expect(xml).toContain('>42<')
    expect(xml).toContain('type="slidenum"')
  })

  it('writes footer and section with identical geometry on every page', () => {
    const pkg = miniPackage(2)
    const chrome = { ...defaultChrome(), footer: { text: 'Acme 2026 Q3', position: 'footer-left' as const }, section: { position: 'header-left' as const } }
    applyChrome(pkg, { chrome, pages: pages(['content', 'content'], { 1: 'Intro', 2: 'Intro' }), tokens: TOKENS })
    const [first, second] = ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'].map((name) => pkg.text(name))
    for (const xml of [first, second]) {
      expect(xml).toContain('chrome-footer')
      expect(xml).toContain('Acme 2026 Q3')
      expect(xml).toContain('chrome-section')
      expect(xml).toContain('Intro')
    }
    const offsets = (xml: string): string[] => [...xml.matchAll(/name="chrome-(?:footer|section)"[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/>/g)].map((match) => `${match[1]},${match[2]}`)
    expect(offsets(first!)).toEqual(offsets(second!))
  })

  it('is idempotent and byte-stable across two runs', () => {
    const first = miniPackage(2, BAKED)
    const second = miniPackage(2, BAKED)
    applyChrome(first, { chrome: defaultChrome(), pages: pages(['content', 'content']), tokens: TOKENS })
    const once = first.text('ppt/slides/slide1.xml')
    applyChrome(first, { chrome: defaultChrome(), pages: pages(['content', 'content']), tokens: TOKENS })
    expect(first.text('ppt/slides/slide1.xml')).toBe(once)
    applyChrome(second, { chrome: defaultChrome(), pages: pages(['content', 'content']), tokens: TOKENS })
    expect(second.text('ppt/slides/slide1.xml')).toBe(once)
  })

  it('rejects a page list that does not cover the deck', () => {
    const pkg = miniPackage(2)
    expect(() => applyChrome(pkg, { chrome: defaultChrome(), pages: pages(['content']), tokens: TOKENS })).toThrowError(DshPptFailure)
  })
})

describe('chromePagesFrom', () => {
  it('maps manifest pages onto roles and keeps sections', () => {
    const entries = chromePagesFrom([{ index: 1 }, { index: 2, section: 'Intro' }], (index) => (index === 1 ? 'cover' : 'content'))
    expect(entries).toEqual([
      { index: 1, role: 'cover' },
      { index: 2, role: 'content', section: 'Intro' },
    ])
  })
})

describe('auditChrome', () => {
  const contract = {
    ...defaultChrome(),
    footer: { text: 'Acme 2026 Q3', position: 'footer-left' as const },
    section: { position: 'header-left' as const },
  }
  const plan = (roles: readonly ('cover' | 'content' | 'ending')[], sections: Record<number, string> = {}) => pages(roles, sections)
  const rulesOf = (findings: FusionFinding[]) => findings.map((finding) => finding.rule)

  it('reports nothing for a package that satisfies the contract', () => {
    const pkg = miniPackage(3)
    applyChrome(pkg, { chrome: contract, pages: plan(['cover', 'content', 'ending'], { 2: 'Intro' }), tokens: TOKENS })
    expect(auditChrome(pkg, { chrome: contract, pages: plan(['cover', 'content', 'ending'], { 2: 'Intro' }) })).toEqual([])
  })

  it('reports a missing page-number field and a chrome shape on a skipped page', () => {
    const pkg = miniPackage(2)
    applyChrome(pkg, { chrome: contract, pages: plan(['content', 'content']), tokens: TOKENS })
    // Audited as if the first page were a cover: it carries chrome it must not.
    const findings = auditChrome(pkg, { chrome: contract, pages: plan(['cover', 'content']) })
    expect(rulesOf(findings)).toContain('chrome-skip')
    const withoutField = miniPackage(1)
    const report = auditChrome(withoutField, { chrome: contract, pages: plan(['content']) })
    expect(rulesOf(report)).toContain('chrome-coverage')
    expect(rulesOf(report)).toContain('chrome-footer-text')
  })

  it('reports geometry drift, footer text drift and section mismatch', () => {
    const pkg = miniPackage(2)
    applyChrome(pkg, { chrome: contract, pages: plan(['content', 'content'], { 1: 'Intro', 2: 'Intro' }), tokens: TOKENS })
    pkg.setPart('ppt/slides/slide2.xml', pkg.text('ppt/slides/slide2.xml').replace('<a:off x="457200"', '<a:off x="914400"').replace('Acme 2026 Q3', 'Other'))
    const findings = auditChrome(pkg, {
      chrome: contract,
      pages: plan(['content', 'content'], { 1: 'Intro', 2: 'Results' }),
    })
    expect(rulesOf(findings)).toContain('chrome-geometry')
    expect(rulesOf(findings)).toContain('chrome-footer-text')
    expect(rulesOf(findings)).toContain('chrome-section')
  })

  it('reports a baked page number that survived the pass', () => {
    const pkg = miniPackage(1, BAKED_BAR)
    const findings = auditChrome(pkg, { chrome: contract, pages: plan(['content']) })
    expect(rulesOf(findings)).toContain('chrome-baked-strip')
  })

  it('warns when chrome overlaps an existing shape', () => {
    const overlap = `<p:sp><p:nvSpPr><p:cNvPr id="7" name="hero"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="5943600"/><a:ext cx="1828800" cy="457200"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`
    const pkg = miniPackage(1, overlap)
    applyChrome(pkg, { chrome: contract, pages: plan(['content']), tokens: TOKENS })
    const findings = auditChrome(pkg, { chrome: contract, pages: plan(['content']) })
    expect(rulesOf(findings)).toContain('chrome-overlap')
    expect(findings.find((finding) => finding.rule === 'chrome-overlap')?.level).toBe('warning')
  })

  it('does not warn when the only overlap is the page background', () => {
    const background = `<p:sp><p:nvSpPr><p:cNvPr id="6" name="bg"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(SLIDE_SIZE.cx)}" cy="${String(SLIDE_SIZE.cy)}"/></a:xfrm></p:spPr><p:txBody><a:p/></p:txBody></p:sp>`
    const pkg = miniPackage(1, background)
    applyChrome(pkg, { chrome: contract, pages: plan(['content']), tokens: TOKENS })
    expect(rulesOf(auditChrome(pkg, { chrome: contract, pages: plan(['content']) }))).not.toContain('chrome-overlap')
  })
})
