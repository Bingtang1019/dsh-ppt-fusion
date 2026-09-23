import { createHash } from 'node:crypto'
import { DshPptFailure } from '../engine/errors.ts'
import { isPageNumberSkipped, type ChromePosition, type ChromeRole, type FusionChrome } from '../schema/fusion.ts'
import type { TokensFile } from '../schema/tokens.ts'
import { listSlides, type OpcPackage } from './opc.ts'

/**
 * The deck-level chrome pass (V6 WP1, ADR-058).
 *
 * `deck.fusion.json` declares what every page should carry; this pass is the one
 * place those shapes are written, after the merge and after motion, so standard
 * pages and deep pages end up with the same chrome. The pass is idempotent: its
 * own shapes are recognized by stable names and replace themselves, and baked
 * page numbers drawn by a page layout are removed by signature first.
 */

/** One page's chrome inputs, in slide order. */
export interface ChromePage {
  readonly index: number
  readonly role: ChromeRole
  readonly section?: string
}

/** Inputs for one chrome pass. */
export interface ChromeOptions {
  readonly chrome: FusionChrome
  readonly pages: readonly ChromePage[]
  readonly tokens: TokensFile
}

/** What one slide received. */
export interface ChromeSlideReport {
  readonly index: number
  readonly pageNumber: boolean
  readonly footer: boolean
  readonly section: boolean
  /** Baked page-number shapes this pass removed. */
  readonly stripped: number
}

/** Result of a chrome pass. */
export interface ChromeReport {
  readonly slides: readonly ChromeSlideReport[]
}

/** 1 inch in EMU; every geometry constant below is expressed with it. */
const EMU_PER_INCH = 914400
/** Outer margin for the four anchors. */
const MARGIN = Math.round(EMU_PER_INCH / 2)
/** Header baseline. */
const HEADER_Y = 274638
/** Every chrome box is this tall. */
const BOX_HEIGHT = 228600
/** 9 pt in hundredths of a point. */
const FONT_SIZE = 900
const PAGE_NUMBER_WIDTH = 1371600
const FOOTER_WIDTH = 5486400
const SECTION_WIDTH = 4572000
/** Fallback slide size: 16:9 in EMU, used only when presentation.xml is unreadable. */
const DEFAULT_SLIDE = { cx: 12192000, cy: 6858000 }

/** Stable shape names, so a re-run replaces its own shapes instead of stacking them. */
const CHROME_NAMES = ['chrome-page-number', 'chrome-footer', 'chrome-section', 'chrome-logo'] as const

interface Box {
  readonly x: number
  readonly y: number
  readonly cx: number
  readonly cy: number
  readonly align: 'l' | 'r'
}

/** @returns the box for one anchor; `width` is the anchor's fixed column width. */
function boxFor(position: ChromePosition, width: number, slide: { cx: number; cy: number }): Box {
  const right = position.endsWith('-right')
  const header = position.startsWith('header')
  return {
    x: right ? slide.cx - MARGIN - width : MARGIN,
    y: header ? HEADER_Y : slide.cy - MARGIN - BOX_HEIGHT,
    cx: width,
    cy: BOX_HEIGHT,
    align: right ? 'r' : 'l',
  }
}

/** @returns the slide canvas size from presentation.xml, with a 16:9 fallback. */
export function slideSize(pkg: OpcPackage): { cx: number; cy: number } {
  const xml = pkg.has('ppt/presentation.xml') ? pkg.text('ppt/presentation.xml') : ''
  const match = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(xml)
  if (match === null) return DEFAULT_SLIDE
  return { cx: Number(match[1]), cy: Number(match[2]) }
}

/**
 * @param seed - stable string identifying one injected field.
 * @returns a UUID-shaped id derived from the seed (SHA-1, version-5 layout) so two
 *   runs over the same deck produce byte-identical parts (T2).
 */
export function deterministicFieldId(seed: string): string {
  const hex = createHash('sha1').update(seed).digest('hex')
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** @returns the next free `p:cNvPr` id for one slide. */
function nextShapeId(xml: string): number {
  let max = 0
  for (const match of xml.matchAll(/<p:cNvPr id="(\d+)"/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max + 1
}

/** @returns XML text with the five predefined entities escaped. */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** @returns an attribute value with quotes and the markup-significant entities escaped. */
function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;')
}

/** @returns the run properties every chrome shape uses (theme muted colour, body font). */
function runProperties(tokens: TokensFile): string {
  const color = escapeAttribute(tokens.colors.muted)
  const typeface = escapeAttribute(tokens.fonts.body[0] ?? 'Calibri')
  return `<a:rPr lang="en-US" sz="${String(FONT_SIZE)}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${typeface}"/></a:rPr>`
}

/**
 * @param options.shapeId - free shape id on this slide.
 * @param options.name - stable chrome shape name.
 * @param options.box - anchor geometry.
 * @param options.tokens - deck tokens for colour and font.
 * @param options.runs - body content (`a:r` or `a:fld` elements).
 * @returns one text-box shape.
 */
function textBox(options: { shapeId: number; name: string; box: Box; tokens: TokensFile; runs: string }): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${String(options.shapeId)}" name="${options.name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${String(options.box.x)}" y="${String(options.box.y)}"/>` +
    `<a:ext cx="${String(options.box.cx)}" cy="${String(options.box.cy)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="${options.box.align}"/>${options.runs}</a:p></p:txBody></p:sp>`
  )
}

/** @returns a plain text run. */
function textRun(tokens: TokensFile, text: string): string {
  return `<a:r>${runProperties(tokens)}<a:t>${escapeText(text)}</a:t></a:r>`
}

/** @returns the native slide-number field `preview` shows as ‹#›. */
function slideNumberField(tokens: TokensFile, seed: string): string {
  return `<a:fld id="{${deterministicFieldId(seed)}}" type="slidenum">${runProperties(tokens)}<a:t>${escapeText('‹#›')}</a:t></a:fld>`
}

/**
 * A baked page number, by signature rather than by name.
 *
 * The engines draw page numbers as ordinary text boxes with generic names, so the
 * shape has to be recognized by what it is: a small translucent single-number
 * badge in the bottom band, right of centre. Everything else — a body figure, a
 * full-opacity number, a large numeral — is left alone.
 *
 * @param shape - one `<p:sp>` block.
 * @param slide - slide canvas size.
 * @returns whether the block is a baked page number.
 */
export function isBakedPageNumber(shape: string, slide: { cx: number; cy: number }): boolean {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape)
  const ext = /<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(shape)
  if (off === null || ext === null) return false
  const [x, y, width, height] = [Number(off[1]), Number(off[2]), Number(ext[1]), Number(ext[2])]
  // Bottom band, still inside the canvas: where both engines park a page-number
  // badge — observed as a full-width bar at y=5494020 on 16:9.
  if (y < slide.cy * 0.7) return false
  if (y + height > slide.cy * 1.02 || height > slide.cy * 0.25) return false
  // A wide bar spans the footer regardless of its origin; a small badge sits in the
  // right half. A mid-sized box is body content.
  const wideBar = width >= slide.cx * 0.5
  const smallBadge = x >= slide.cx / 2 && width <= slide.cx * 0.25 && height <= slide.cy * 0.1
  if (!wideBar && !smallBadge) return false
  const texts = [...shape.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1] ?? '')
  if (texts.length !== 1 || !/^\d{1,3}$/.test(texts[0] ?? '')) return false
  if (!/algn="r"/.test(shape)) return false
  const alpha = /<a:alpha val="(\d+)"\/>/.exec(shape)
  if (alpha === null) return false
  return Number(alpha[1]) <= 60000
}

/**
 * Apply a deck's chrome contract to a merged package, in place.
 *
 * @param pkg - merged package; mutated.
 * @param options - the contract, one entry per slide, and the deck's tokens.
 * @returns what each slide received; `stripped` counts removed baked page numbers.
 * @throws DshPptFailure `ContractViolation` when the page list does not cover the deck.
 */
export function applyChrome(pkg: OpcPackage, options: ChromeOptions): ChromeReport {
  const slides = listSlides(pkg)
  const byIndex = new Map(options.pages.map((page) => [page.index, page]))
  if (options.pages.length !== slides.length) {
    throw new DshPptFailure('ContractViolation', `chrome pages cover ${String(options.pages.length)} slide(s) but the deck has ${String(slides.length)}`, {
      detail: { pages: options.pages.length, slides: slides.length },
    })
  }
  const size = slideSize(pkg)
  const reports: ChromeSlideReport[] = []

  for (const [offset, slidePart] of slides.entries()) {
    const index = offset + 1
    const page = byIndex.get(index) ?? { index, role: 'content' as ChromeRole }
    let xml = pkg.text(slidePart)

    // 1. Remove this pass's own shapes, then any baked page number.
    for (const name of CHROME_NAMES) xml = xml.replace(chromeShapePattern(name), '')
    let stripped = 0
    xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) => {
      if (!isBakedPageNumber(shape, size)) return shape
      stripped += 1
      return ''
    })

    const shapes: string[] = []
    let shapeId = nextShapeId(xml)
    const pageNumber = options.chrome.pageNumber
    if (pageNumber !== undefined && pageNumber.show !== false && !isPageNumberSkipped(options.chrome, page.role)) {
      const box = boxFor(pageNumber.position ?? 'footer-right', PAGE_NUMBER_WIDTH, size)
      shapes.push(textBox({ shapeId: shapeId++, name: 'chrome-page-number', box, tokens: options.tokens, runs: slideNumberField(options.tokens, `page-number:${String(index)}`) }))
    }
    const footer = options.chrome.footer
    if (footer !== undefined) {
      const box = boxFor(footer.position ?? 'footer-left', FOOTER_WIDTH, size)
      shapes.push(textBox({ shapeId: shapeId++, name: 'chrome-footer', box, tokens: options.tokens, runs: textRun(options.tokens, footer.text) }))
    }
    const section = options.chrome.section
    if (section !== undefined && page.section !== undefined) {
      const box = boxFor(section.position ?? 'header-left', SECTION_WIDTH, size)
      shapes.push(textBox({ shapeId: shapeId++, name: 'chrome-section', box, tokens: options.tokens, runs: textRun(options.tokens, page.section) }))
    }

    if (shapes.length > 0) xml = xml.replace('</p:spTree>', `${shapes.join('')}</p:spTree>`)
    pkg.setPart(slidePart, xml)
    reports.push({
      index,
      pageNumber: shapes.some((shape) => shape.includes('chrome-page-number')),
      footer: shapes.some((shape) => shape.includes('chrome-footer')),
      section: shapes.some((shape) => shape.includes('chrome-section')),
      stripped,
    })
  }

  return { slides: reports }
}

/** @returns a pattern matching one whole shape by its stable chrome name. */
function chromeShapePattern(name: string): RegExp {
  return new RegExp(`<p:sp>(?:(?!</p:sp>)[\\s\\S])*name="${name}"(?:(?!</p:sp>)[\\s\\S])*</p:sp>`)
}

/** One page's chrome inputs derived from the manifest and the IR. */
export function chromePagesFrom(
  pages: readonly { readonly index: number; readonly section?: string }[],
  roleFor: (index: number) => ChromeRole,
): ChromePage[] {
  return pages.map((page) => ({ index: page.index, role: roleFor(page.index), ...(page.section === undefined ? {} : { section: page.section }) }))
}
