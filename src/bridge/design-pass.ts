import { DshPptFailure } from '../engine/errors.ts'
import { listSlides, type OpcPackage } from './opc.ts'
import { slideSize } from './chrome.ts'
import { EMU_PER_INCH, chooseTitle, isGrey, isNumberLike, shapeGeometry, shapeRuns, simpleLuminance, type SlideRun } from './slide-text.ts'
import type { DesignProfile, DesignRole, DesignRoleGeometry } from '../schema/design-profile.ts'

/**
 * The profile design pass (V7.2 B5b).
 *
 * pptwise IR has no per-shape geometry: layouts own positions and sizes, so a deck
 * built from a preset renders that preset's typography no matter how the components
 * are chosen. This pass runs on the merged package before the font pass and rewrites
 * the standard pages to the profile's language:
 *
 * - the representative title shape takes the role's size, colour and anchor;
 * - the dominant body-size runs take the role's body size and colour, while accent
 *   runs and other tiers keep theirs;
 * - a content page's card panels are laid out as equal columns with the profile's gap,
 *   their card titles taking the design language's 20 pt accent and their bodies the
 *   role's body style;
 * - toc card columns are re-spaced to the profile's card gap;
 * - a section page without a watermark gets the profile's watermark numeral, and
 *   cover/ending pages get the meta footer the profile expects.
 *
 * Deep pages keep their authored composition: their SVG already carries the profile's
 * sizes when the SKILL is followed, and moving deep composition shapes would desync
 * the authored artwork. The audit judges both page kinds afterwards.
 */

/** One page the pass may rewrite. */
export interface DesignPassPage {
  /** 1-based deck position. */
  readonly index: number
  readonly role: DesignRole
  /** True for pptwise (standard) pages; deep pages are left alone. */
  readonly standard: boolean
  /** Section label used for the watermark numeral, when the manifest declares one. */
  readonly section?: string
}

/** Options for {@link applyDesignProfile}. */
export interface DesignPassOptions {
  readonly profile: DesignProfile
  readonly pages: readonly DesignPassPage[]
  /** Footer text for cover/ending pages; no footer is added when it is empty. */
  readonly metaFooter?: string
}

/** What one pass rewrote. */
export interface DesignPassReport {
  readonly titles: number
  readonly bodies: number
  readonly accents: number
  readonly gaps: number
  readonly cards: number
  readonly markers: number
  readonly footers: number
}

/** Card-title size the design-language reference fixes for content cards. */
export const CARD_TITLE_SIZE_PT = 20

/**
 * Clearance the design language keeps between a content-page title and the theme's
 * corner mark, in inches — the 8 px the S27 review asked for at 96 dpi.
 */
export const CONTENT_TITLE_NUDGE_IN = 8 / 96

/** Distance between a card's edge and the shapes inside it, in inches. */
const CARD_PADDING_IN = 0.35

/** Card title/body/icon offsets from the card's top edge, measured on the reference page. */
const CARD_TITLE_OFFSET_IN = 1.14
const CARD_BODY_OFFSET_IN = 1.91
const CARD_ICON_OFFSET_IN = 0.3

/** Minimum panel area (square inches) that counts as a content card. */
const CARD_MIN_AREA_IN2 = 1.5

/** One top-level shape with its position in the slide XML. */
interface ShapeRecord {
  readonly start: number
  readonly end: number
  readonly xml: string
  readonly name: string
  readonly geometry: { x: number; y: number; w: number; h: number } | null
  readonly runs: SlideRun[]
}

/** One pending splice into the slide XML. */
interface Edit {
  readonly start: number
  readonly end: number
  readonly replacement: string
}

/** Style facts a run rewrite can set. */
interface StyleSpec {
  readonly sizePt?: number
  readonly color?: string
  readonly bold?: boolean
}

/** @param openTag - an `a:rPr`/`a:defRPr`/`a:endParaRPr` open tag. @param spec - style to apply. @returns the tag with size/bold rewritten. */
function rewriteOpenTag(openTag: string, spec: StyleSpec): string {
  let tag = openTag
  if (spec.sizePt !== undefined) {
    const size = String(Math.round(spec.sizePt * 100))
    tag = /\bsz="\d+"/.test(tag) ? tag.replace(/\bsz="\d+"/, `sz="${size}"`) : tag.replace(/^(<a:\w+)/, `$1 sz="${size}"`)
  }
  if (spec.bold !== undefined) {
    tag = /\bb="[^"]*"/.test(tag) ? tag.replace(/\bb="[^"]*"/, spec.bold ? 'b="1"' : 'b="0"') : spec.bold ? tag.replace(/^(<a:\w+)/, '$1 b="1"') : tag
  }
  return tag
}

/** @param element - one property element. @param spec - style to apply. @returns the element with its size/bold/colour rewritten. */
function stylePropertyElement(element: string, spec: StyleSpec): string {
  const match = /^<a:(\w+)\b[^>]*?(\/?)>/.exec(element)
  if (match === null) return element
  const name = match[1] ?? 'rPr'
  const open = rewriteOpenTag(match[0], spec)
  const fill = spec.color === undefined ? '' : `<a:solidFill><a:srgbClr val="${spec.color.replace(/^#/, '')}"/></a:solidFill>`
  if (match[2] === '/') {
    if (fill === '') return open
    const pairedOpen = rewriteOpenTag(`${match[0].slice(0, -2)}>`, spec)
    return `${pairedOpen}${fill}</a:${name}>`
  }
  let inner = element.slice(match[0].length)
  if (fill !== '') {
    const existing = /<a:solidFill>[\s\S]*?<\/a:solidFill>/.exec(inner)
    inner = existing !== null ? inner.replace(existing[0], fill) : `${fill}${inner}`
  }
  return `${open}${inner}`
}

/** @param xml - shape XML. @param spec - style applied to every property element. @returns the rewritten XML. */
function styleAllRuns(xml: string, spec: StyleSpec): string {
  return xml
    .replace(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\/>/g, (element) => stylePropertyElement(element, spec))
    .replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*>[\s\S]*?<\/a:\1>/g, (element) => stylePropertyElement(element, spec))
}

/** @param run - one `a:r` element. @returns its explicit size and colour. */
function runFacts(run: string): { sizePt?: number; color?: string } {
  const open = /<a:rPr\b[^>]*>/.exec(run)
  const size = open === null ? null : /\bsz="(\d+)"/.exec(open[0])
  const color = /<a:solidFill>\s*<a:srgbClr val="#?([0-9A-Fa-f]{6})"/.exec(run)
  return {
    ...(size === null ? {} : { sizePt: Number(size[1]) / 100 }),
    ...(color === null ? {} : { color: `#${(color[1] ?? '').toUpperCase()}` }),
  }
}

/**
 * @param xml - shape XML.
 * @param predicate - decides which runs are rewritten from their explicit facts.
 * @param spec - the style applied to the selected runs.
 * @returns the rewritten XML and how many runs were changed.
 */
function styleRunsWhere(xml: string, predicate: (facts: { sizePt?: number; color?: string }) => boolean, spec: StyleSpec): { xml: string; count: number } {
  let count = 0
  const rewritten = xml.replace(/<a:r>[\s\S]*?<\/a:r>/g, (run) => {
    if (!predicate(runFacts(run))) return run
    count += 1
    return run.replace(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/, (element) => stylePropertyElement(element, spec))
  })
  return { xml: rewritten, count }
}

/** @param xml - one slide part. @returns its top-level shape records with positions. */
function shapeRecords(xml: string): ShapeRecord[] {
  const groups = [...xml.matchAll(/<p:grpSp\b[^>]*>[\s\S]*?<\/p:grpSp>/g)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const)
  const records: ShapeRecord[] = []
  for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const start = match.index ?? 0
    if (groups.some(([from, to]) => start >= from && start < to)) continue
    const shape = match[0]
    records.push({
      start,
      end: start + shape.length,
      xml: shape,
      name: /<p:cNvPr[^>]*\bname="([^"]*)"/.exec(shape)?.[1] ?? '',
      geometry: shapeGeometry(shape),
      runs: shapeRuns(shape),
    })
  }
  return records
}

/** The slide's representative title run and where it lives. */
interface TitleChoice {
  readonly index: number
  readonly runIndex: number
  readonly run: SlideRun
}

/** @param records - shape records. @returns the shape and run holding the slide's title run, or null. */
function chooseTitleShape(records: readonly ShapeRecord[]): TitleChoice | null {
  let best: TitleChoice | null = null
  for (const [index, record] of records.entries()) {
    const chosen = chooseTitle(record.runs)
    if (chosen === null) continue
    const runIndex = record.runs.indexOf(chosen.run)
    if (best === null || chosen.run.sizePt > best.run.sizePt || (chosen.run.sizePt === best.run.sizePt && chosen.run.y < best.run.y)) {
      best = { index, runIndex, run: chosen.run }
    }
  }
  return best
}

/** @param values - typed values. @returns the most common value, ties broken by first appearance. */
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>()
  let best: T | undefined
  let bestCount = 0
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** @param geometry - shape bounds. @param canvas - slide size. @returns true when the shape spans most of the canvas. */
function isFullCanvas(geometry: { w: number; h: number } | null, canvas: { cx: number; cy: number }): boolean {
  return geometry !== null && geometry.w >= canvas.cx * 0.9 && geometry.h >= canvas.cy * 0.9
}

/** @param xml - slide XML. @param edits - splices with original indices. @returns the rewritten XML. */
function applyEdits(xml: string, edits: readonly Edit[]): string {
  let result = xml
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    if (edit.start < 0 || edit.end > result.length || edit.start > edit.end) continue
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}

/** @param xml - slide XML. @param shapes - shape XML to append. @returns the XML with `shapes` inserted before `</p:spTree>`. */
function appendShapes(xml: string, shapes: string): string {
  const close = xml.lastIndexOf('</p:spTree>')
  if (close === -1) throw new DshPptFailure('ContractViolation', 'a slide has no p:spTree to append chrome into', { detail: {} })
  return `${xml.slice(0, close)}${shapes}${xml.slice(close)}`
}

/** @param xml - slide XML. @returns the next free `p:cNvPr` id. */
function nextShapeId(xml: string): number {
  let max = 0
  for (const match of xml.matchAll(/<p:cNvPr id="(\d+)"/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max + 1
}

/** @returns one text shape XML with a single run. */
function textShape(id: number, name: string, text: string, spec: { x: number; y: number; w: number; h: number }, run: StyleSpec): string {
  const emu = (value: number): number => Math.round(value * EMU_PER_INCH)
  const properties = styleAllRuns('<a:rPr lang="zh-CN" dirty="0"><a:latin typeface="MiSans"/><a:ea typeface="MiSans"/></a:rPr>', run)
  return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(emu(spec.x))}" y="${String(emu(spec.y))}"/><a:ext cx="${String(emu(spec.w))}" cy="${String(emu(spec.h))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${properties}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

/**
 * @param xml - shape XML.
 * @param x - new left edge, EMU.
 * @param y - new top edge, EMU.
 * @param w - new width, EMU.
 * @param h - new height, EMU.
 * @returns the shape with its transform rewritten.
 */
function placeShape(xml: string, x: number, y: number, w: number, h: number): string {
  const emu = (value: number): number => Math.round(value)
  return xml
    .replace(/<a:off x="-?\d+" y="-?\d+"\/>/, `<a:off x="${String(emu(x))}" y="${String(emu(y))}"/>`)
    .replace(/<a:ext cx="\d+" cy="\d+"\/>/, `<a:ext cx="${String(emu(w))}" cy="${String(emu(h))}"/>`)
}

/**
 * @param profile - validated design profile.
 * @param role - the design role whose title is being written.
 * @returns the next smaller title size in the profile's own ladder, or the role's size
 *   when the ladder has no smaller step. A content title takes this step so the theme's
 *   corner mark does not crowd it.
 */
export function steppedTitleSizePt(profile: DesignProfile, role: DesignRole): number | undefined {
  const size = profile.typeScale[role]?.title?.sizePt
  if (size === undefined) return undefined
  const smaller = Object.values(profile.typeScale)
    .map((scale) => scale.title?.sizePt)
    .filter((candidate): candidate is number => candidate !== undefined && candidate < size)
  return smaller.length === 0 ? size : Math.max(...smaller)
}

/** One card on a standard page: its panel shape plus the shapes whose centres it holds. */
interface CardShape {
  readonly panel: number
  readonly children: readonly number[]
}

/**
 * @param records - the slide's top-level shapes.
 * @param titleIndex - the title shape, never a panel and never a child.
 * @param canvas - slide size.
 * @returns the card panels in reading order with the shapes they contain; empty when
 *   the page is not a card page.
 */
function cardShapes(records: readonly ShapeRecord[], titleIndex: number, canvas: { cx: number; cy: number }): CardShape[] {
  const panels = records
    .map((record, index) => ({ record, index }))
    .filter(({ record, index }) => {
      if (index === titleIndex || record.runs.length > 0 || record.geometry === null) return false
      if (record.name.startsWith('chrome-') || record.name.startsWith('dsh-')) return false
      if (isFullCanvas(record.geometry, canvas)) return false
      return record.geometry.w * record.geometry.h >= CARD_MIN_AREA_IN2 * EMU_PER_INCH * EMU_PER_INCH
    })
    .sort((left, right) => (left.record.geometry?.y ?? 0) - (right.record.geometry?.y ?? 0) || (left.record.geometry?.x ?? 0) - (right.record.geometry?.x ?? 0))
  const panelIndices = new Set(panels.map((panel) => panel.index))
  const cards: CardShape[] = []
  for (const panel of panels) {
    const box = panel.record.geometry
    if (box === null) continue
    const children: number[] = []
    for (const [index, record] of records.entries()) {
      if (index === panel.index || index === titleIndex || panelIndices.has(index) || record.geometry === null) continue
      if (isFullCanvas(record.geometry, canvas)) continue
      const centreX = record.geometry.x + record.geometry.w / 2
      const centreY = record.geometry.y + record.geometry.h / 2
      if (centreX < box.x || centreX > box.x + box.w || centreY < box.y || centreY > box.y + box.h) continue
      children.push(index)
    }
    cards.push({ panel: panel.index, children })
  }
  return cards
}

/**
 * Lay a content page's cards out as equal columns, as the reference content page does:
 * one row of `columns` cards with the profile's gap, a 20 pt accent card title and the
 * role's body style. Preset layouts mix a tall panel with stacked ones, which reads much
 * lighter than the reference and was the S27 page 4/6/11 gap.
 *
 * @param records - the slide's shapes.
 * @param replacements - current shape rewrites, updated in place.
 * @param profile - validated profile.
 * @param role - the content role's geometry.
 * @param titleIndex - the title shape, never moved.
 * @param canvas - slide size.
 * @returns how many cards were laid out.
 */
function layoutCards(
  records: readonly ShapeRecord[],
  replacements: Map<number, string>,
  profile: DesignProfile,
  role: DesignRoleGeometry,
  titleIndex: number,
  canvas: { cx: number; cy: number },
): number {
  const cards = cardShapes(records, titleIndex, canvas)
  if (cards.length < 2) return 0
  const gap = (role.cardGapIn ?? 0.43) * EMU_PER_INCH
  const columns = Math.min(cards.length, role.columnsMax ?? role.columns ?? cards.length)
  if (columns < 2 || gap <= 0) return 0
  const rows = Math.ceil(cards.length / columns)
  const boxes = cards.flatMap((card) => {
    const geometry = records[card.panel]?.geometry
    return geometry === null || geometry === undefined ? [] : [geometry]
  })
  if (boxes.length !== cards.length) return 0
  const left = Math.min(...boxes.map((box) => box.x))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const top = Math.min(...boxes.map((box) => box.y))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  const columnWidth = (right - left - (columns - 1) * gap) / columns
  const rowHeight = (bottom - top - (rows - 1) * gap) / rows
  if (columnWidth < EMU_PER_INCH || rowHeight < EMU_PER_INCH) return 0
  const padding = CARD_PADDING_IN * EMU_PER_INCH
  const titleOffset = CARD_TITLE_OFFSET_IN * EMU_PER_INCH
  const bodyOffset = CARD_BODY_OFFSET_IN * EMU_PER_INCH
  const iconOffset = CARD_ICON_OFFSET_IN * EMU_PER_INCH
  const bodyExpect = profile.typeScale.content?.body
  for (const [position, card] of cards.entries()) {
    const column = position % columns
    const row = Math.floor(position / columns)
    const x = left + column * (columnWidth + gap)
    const y = top + row * (rowHeight + gap)
    const panel = records[card.panel]
    if (panel === undefined) continue
    replacements.set(card.panel, placeShape(replacements.get(card.panel) ?? panel.xml, x, y, columnWidth, rowHeight))
    const textChildren = card.children.filter((index) => (records[index]?.runs.length ?? 0) > 0)
    const largest = (index: number): number => Math.max(0, ...(records[index]?.runs ?? []).map((run) => run.sizePt ?? 0))
    let cardTitle: number | null = null
    for (const index of textChildren) {
      if (cardTitle === null || largest(index) > largest(cardTitle)) cardTitle = index
    }
    for (const index of card.children) {
      const record = records[index]
      if (record === undefined || record.geometry === null) continue
      const base = replacements.get(index) ?? record.xml
      if (!textChildren.includes(index)) {
        replacements.set(index, placeShape(base, x + padding, y + iconOffset, record.geometry.w, record.geometry.h))
        continue
      }
      if (index === cardTitle) {
        const shape = placeShape(base, x + padding, y + titleOffset, columnWidth - 2 * padding, 0.6 * EMU_PER_INCH)
        replacements.set(index, styleRunsWhere(shape, () => true, { sizePt: CARD_TITLE_SIZE_PT, color: profile.palette.accent }).xml)
        continue
      }
      const bodyHeight = Math.max(0.5 * EMU_PER_INCH, rowHeight - bodyOffset - 0.3 * EMU_PER_INCH)
      let shape = placeShape(base, x + padding, y + bodyOffset, columnWidth - 2 * padding, bodyHeight)
      if (bodyExpect !== undefined) {
        shape = styleRunsWhere(shape, () => true, { sizePt: bodyExpect.sizePt, color: profile.palette.body }).xml
      }
      replacements.set(index, shape)
    }
  }
  return cards.length
}

/**
 * Apply the profile's standard-page language to the merged package.
 *
 * @param pkg - the merged package.
 * @param options - profile, page roles and footer text.
 * @returns what each rule rewrote.
 * @throws DshPptFailure `ContractViolation` when a slide has no shape tree.
 */
export function applyDesignProfile(pkg: OpcPackage, options: DesignPassOptions): DesignPassReport {
  const canvas = slideSize(pkg)
  const slides = listSlides(pkg)
  const report = { titles: 0, bodies: 0, accents: 0, gaps: 0, cards: 0, markers: 0, footers: 0 }
  const sectionOrdinal = new Map<number, string>()
  let sections = 0
  for (const page of options.pages) {
    if (page.role !== 'section') continue
    sections += 1
    sectionOrdinal.set(page.index, String(sections).padStart(2, '0'))
  }
  for (const [offset, slidePart] of slides.entries()) {
    const page = options.pages[offset]
    if (page === undefined || !page.standard) continue
    let xml = pkg.text(slidePart)
    const records = shapeRecords(xml)
    const title = chooseTitleShape(records)
    const titleExpect = options.profile.typeScale[page.role]?.title
    const bodyExpect = options.profile.typeScale[page.role]?.body
    const geometry = options.profile.roles[page.role]
    const edits: Edit[] = []
    const otherRuns = records.flatMap((record, index) =>
      record.runs
        .map((run, runIndex) => ({ record, index, run, runIndex }))
        .filter((entry) => !(title !== null && entry.index === title.index && entry.runIndex === title.runIndex)),
    )
    const darkOthers = otherRuns.filter((entry) => simpleLuminance(entry.run.color) <= 0.75)
    const dominantSize = mode(darkOthers.map((entry) => entry.run.sizePt))
    const accent = mode(darkOthers.filter((entry) => !isGrey(entry.run.color)).map((entry) => entry.run.color))
    const replacements = new Map<number, string>()
    for (const [index, record] of records.entries()) {
      if (record.name.startsWith('chrome-') || record.name.startsWith('dsh-background')) continue
      let shape = record.xml
      let changed = false
      if (title !== null && index === title.index && titleExpect !== undefined) {
        // Only the representative title-size runs take the title style: a cover's
        // subtitle or meta line can share the shape and must stay body-sized.
        const contentTitle = page.role === 'content'
        const sizePt = contentTitle ? (steppedTitleSizePt(options.profile, 'content') ?? titleExpect.sizePt) : titleExpect.sizePt
        const styled = styleRunsWhere(shape, (facts) => facts.sizePt !== undefined && Math.abs(facts.sizePt - title.run.sizePt) < 0.01, {
          sizePt,
          color: titleExpect.color,
          bold: titleExpect.bold === true,
        })
        shape = styled.xml
        report.titles += 1
        changed = true
        if (geometry !== undefined && page.role !== 'toc') {
          // The profile's toc title geometry comes from the reference's number column
          // (`01.`), not from a page heading, so moving the page title there would drop it
          // under the card row. Every other role's titlePos is a real heading anchor.
          const nudge = contentTitle ? CONTENT_TITLE_NUDGE_IN : 0
          const x = Math.round((geometry.titlePos.x + nudge) * EMU_PER_INCH)
          const y = Math.round((geometry.titlePos.y + nudge) * EMU_PER_INCH)
          shape = shape.replace(/<a:off x="-?\d+" y="-?\d+"\/>/, `<a:off x="${String(x)}" y="${String(y)}"/>`)
        }
      }
      if (bodyExpect !== undefined && dominantSize !== undefined) {
        const styled = styleRunsWhere(shape, (facts) => facts.sizePt !== undefined && Math.abs(facts.sizePt - dominantSize) < 0.01, {
          sizePt: bodyExpect.sizePt,
          color: bodyExpect.color,
        })
        shape = styled.xml
        if (styled.count > 0) {
          changed = true
          report.bodies += styled.count
        }
      }
      if (accent !== undefined && accent !== options.profile.palette.accent) {
        const recoloured = styleRunsWhere(shape, (facts) => facts.color === accent, { color: options.profile.palette.accent })
        shape = recoloured.xml
        if (recoloured.count > 0) {
          changed = true
          report.accents += recoloured.count
        }
      }
      if (changed) replacements.set(index, shape)
    }

    const cards = page.role === 'content' && geometry !== undefined
      ? layoutCards(records, replacements, options.profile, geometry, title?.index ?? -1, canvas)
      : 0
    report.cards += cards
    const gap = geometry?.cardGapIn
    if (cards === 0 && gap !== undefined && (page.role === 'content' || page.role === 'toc')) {
      const shift = cardGapShifts(records, title?.index ?? -1, gap, canvas)
      if (shift !== null) {
        for (const entry of shift.shifts) {
          const record = records[entry.index]
          const base = replacements.get(entry.index) ?? record?.xml
          if (record === undefined || record.geometry === null || base === undefined) continue
          replacements.set(entry.index, base.replace(/<a:off x="-?\d+" y="-?\d+"\/>/, `<a:off x="${String(Math.round(record.geometry.x + entry.delta))}" y="${String(record.geometry.y)}"/>`))
        }
        report.gaps += shift.columns - 1
      }
    }
    for (const [index, replacement] of replacements) {
      const record = records[index]
      if (record !== undefined) edits.push({ start: record.start, end: record.end, replacement })
    }

    xml = applyEdits(xml, edits)

    const watermarkExpect = options.profile.roles.section?.watermarkSizePt ?? 85
    if (page.role === 'section' && options.profile.chrome.sectionMarker) {
      const markers = shapeRecords(xml).filter((record) => record.runs.some((run) => run.sizePt >= watermarkExpect - 1 && simpleLuminance(run.color) > 0.85))
      if (markers.length > 0) {
        const markerEdits = markers.map((record) => ({
          start: record.start,
          end: record.end,
          replacement: styleRunsWhere(record.xml, (facts) => facts.sizePt !== undefined && facts.sizePt >= watermarkExpect - 1, { sizePt: watermarkExpect, color: options.profile.palette.watermark }).xml,
        }))
        xml = applyEdits(xml, markerEdits)
        report.markers += 1
      }
    }
    const pageRuns = shapeRecords(xml).flatMap((record) => record.runs)
    const hasWatermark = pageRuns.some((run) => run.sizePt >= watermarkExpect - 1 && simpleLuminance(run.color) > 0.85)
    const additions: string[] = []
    if (page.role === 'section' && options.profile.chrome.sectionMarker && !hasWatermark) {
      const label = page.section !== undefined && isNumberLike(page.section) ? page.section.trim().replace(/[.．、]/g, '') : (sectionOrdinal.get(page.index) ?? String(page.index).padStart(2, '0'))
      additions.push(
        textShape(nextShapeId(xml) + additions.length, 'dsh-profile-marker', label, { x: 8.96, y: 2.9, w: 1.77, h: 1.57 }, { sizePt: watermarkExpect, color: options.profile.palette.watermark }),
      )
      report.markers += 1
    }
    if ((page.role === 'cover' || page.role === 'ending') && options.profile.chrome.metaFooter && options.metaFooter !== undefined && options.metaFooter.trim() !== '') {
      const hasFooter = pageRuns.some((run) => run.sizePt <= 18 && run.y > canvas.cy * 0.8)
      if (!hasFooter) {
        additions.push(
          textShape(nextShapeId(xml) + additions.length, 'dsh-profile-footer', options.metaFooter, { x: 0.69, y: 6.9, w: 5, h: 0.3 }, { sizePt: 16, color: options.profile.palette.body }),
        )
        report.footers += 1
      }
    }
    if (additions.length > 0) xml = appendShapes(xml, additions.join(''))
    pkg.setPart(slidePart, xml)
  }
  return report
}

/**
 * @param records - the slide's shapes.
 * @param titleIndex - the title shape, excluded from clustering.
 * @param gapIn - the profile's card gap.
 * @param canvas - slide size.
 * @returns the per-shape horizontal shifts that re-space the card columns, or null
 *   when the slide has fewer than two columns or the shift would leave the canvas.
 */
function cardGapShifts(
  records: readonly ShapeRecord[],
  titleIndex: number,
  gapIn: number,
  canvas: { cx: number; cy: number },
): { shifts: { index: number; delta: number }[]; columns: number } | null {
  const textShapes = records
    .map((record, index) => ({ record, index }))
    .filter((entry) => entry.index !== titleIndex && entry.record.runs.some((run) => simpleLuminance(run.color) <= 0.75) && !entry.record.name.startsWith('chrome-') && !entry.record.name.startsWith('dsh-'))
  const columns: { nodes: typeof textShapes; left: number; right: number }[] = []
  for (const entry of [...textShapes].sort((left, right) => (left.record.geometry?.x ?? 0) - (right.record.geometry?.x ?? 0))) {
    const geometry = entry.record.geometry
    if (geometry === null) continue
    const last = columns[columns.length - 1]
    if (last !== undefined && geometry.x - last.left <= EMU_PER_INCH) {
      last.nodes.push(entry)
      last.right = Math.max(last.right, geometry.x + geometry.w)
    } else {
      columns.push({ nodes: [entry], left: geometry.x, right: geometry.x + geometry.w })
    }
  }
  if (columns.length < 2) return null
  const gapEmu = gapIn * EMU_PER_INCH
  const canvasLimit = canvas.cx - 0.1 * EMU_PER_INCH
  const deltas: number[] = []
  for (let index = 1; index < columns.length; index += 1) {
    const previous = columns[index - 1]
    const current = columns[index]
    if (previous === undefined || current === undefined) continue
    const delta = previous.right + gapEmu - current.left
    deltas.push(Math.abs(delta) < 0.005 * EMU_PER_INCH ? 0 : delta)
  }
  if (deltas.every((delta) => delta === 0)) return null
  const lastColumn = columns[columns.length - 1]
  if (lastColumn === undefined || lastColumn.right + deltas.reduce((sum, value) => sum + value, 0) > canvasLimit) return null
  const shifts: { index: number; delta: number }[] = []
  let cumulative = 0
  for (let index = 1; index < columns.length; index += 1) {
    cumulative += deltas[index - 1] ?? 0
    const column = columns[index]
    if (column === undefined) continue
    for (const entry of column.nodes) {
      const geometry = entry.record.geometry
      if (geometry === null || isFullCanvas(geometry, canvas)) continue
      const centre = geometry.x + geometry.w / 2
      if (centre < column.left - EMU_PER_INCH || centre > column.right + EMU_PER_INCH) continue
      shifts.push({ index: entry.index, delta: cumulative })
    }
  }
  return shifts.length === 0 ? null : { shifts, columns: columns.length }
}
