import { deltaE76 } from './pixels.ts'
import { listSlides, resolveTarget, type OpcPackage } from './opc.ts'
import { slideSize } from './chrome.ts'
import { contrastRatio } from './profile-theme.ts'
import type { FusionFinding } from '../audit.ts'
import type { DesignProfile, DesignRole } from '../schema/design-profile.ts'

/**
 * Profile-compliance audit for a published package (V7.2 B4, ADR-062).
 *
 * The rules re-run the measurement procedure of `python-assets/scripts/design-profile.py`
 * on the OOXML package and compare the result with the stored profile inside fixed
 * tolerances, so "the profile describes the reference deck" is a checkable property
 * (S26). Representative values, not every run, are compared: the extractor stores
 * per-role modes and the deck's non-dominant runs are legitimately not part of that
 * summary. The rules are:
 *
 * - `design-role-title-font`: representative title size/colour and dominant body
 *   size/colour per role (±1 pt, ΔE ≤ 3).
 * - `design-accent-body-color`: dominant non-grey body colour per role (ΔE ≤ 3).
 * - `design-role-geometry`: title anchor (±0.05 in), column count and card gap.
 * - `design-section-marker`: every section page carries the watermark numeral.
 * - `design-chrome-match`: page-number and meta-footer booleans re-measured.
 *
 * Background rules (mode, overlay, contrast, PNG fallback) live in the same module
 * and are applied by {@link auditDesignBackgrounds}.
 */

/** Point tolerance for a measured title/body size. */
export const DESIGN_SIZE_TOLERANCE_PT = 1

/** CIE76 colour tolerance for a measured run colour. */
export const DESIGN_DELTA_E_LIMIT = 3

/** Inch tolerance for a measured title anchor or card gap. */
export const DESIGN_POSITION_TOLERANCE_IN = 0.05

/** EMU per inch, the unit both the extractor and this audit use. */
export const EMU_PER_INCH = 914400

/** One styled text run with its shape geometry, as the extractor sees it. */
interface SlideRun {
  readonly text: string
  readonly sizePt: number
  readonly bold: boolean
  readonly color: string
  /** Explicit Latin (preferred) or East-Asian typeface; a run without one is not styled. */
  readonly font: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** One slide's styled runs in document order. */
interface SlideFacts {
  readonly index: number
  readonly runs: readonly SlideRun[]
}

/** The measured per-role summary the rules compare against the profile. */
interface RoleMeasurement {
  readonly role: DesignRole
  readonly slides: number[]
  title?: { readonly run: SlideRun; readonly slide: number }
  readonly bodies: { readonly run: SlideRun; readonly slide: number }[]
  bodyMode?: { readonly sizePt: number; readonly color: string }
  accent?: string
  columns?: { readonly mode: number; readonly max: number }
  gapIn?: number
  watermark?: { readonly sizePt: number; readonly slide: number }
}

/** Options for {@link auditDesignPackage}. */
export interface DesignAuditOptions {
  readonly profile: DesignProfile
  /** 1-based role overrides; without them the extractor's role hints are re-run. */
  readonly roles?: ReadonlyMap<number, DesignRole>
  /** Skip the section-marker and chrome rules (package-only audits). */
  readonly chrome?: boolean
}

/**
 * @param hex - `#RRGGBB`.
 * @returns the extractor's simple weighted luminance (0–1).
 */
function simpleLuminance(hex: string): number {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

/** @param hex - `#RRGGBB`. @returns true when the channels differ by at most 0x08. */
function isGrey(hex: string): boolean {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
  return Math.max(...channels) - Math.min(...channels) <= 8
}

/** @param text - one run's text. @returns true for a numeral run such as `02` or `12、`. */
function isNumberLike(text: string): boolean {
  const stripped = text.trim().replace(/[.．、\s]+$/g, '').replace(/^[.．、\s]+/g, '')
  return /^\d{1,4}$/.test(stripped)
}

/** @param values - typed values. @returns the most common value, ties broken by first appearance. */
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>()
  const order: T[] = []
  let best: T | undefined
  let bestCount = 0
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (!order.includes(value)) order.push(value)
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * @param xml - one slide part.
 * @returns the shape XML of top-level `p:sp` shapes. Shapes inside `p:grpSp` are
 *   dropped, matching python-pptx's `slide.shapes` iteration.
 */
function topLevelShapes(xml: string): string[] {
  const withoutGroups = xml.replace(/<p:grpSp\b[^>]*>[\s\S]*?<\/p:grpSp>/g, '')
  return [...withoutGroups.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((match) => match[0])
}

/** @returns the shape's `a:off`/`a:ext`, or null when either is absent. */
function shapeGeometry(shape: string): { x: number; y: number; w: number; h: number } | null {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape)
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)
  if (off === null || ext === null) return null
  return { x: Number(off[1]), y: Number(off[2]), w: Number(ext[1]), h: Number(ext[2]) }
}

/**
 * @param shape - one `p:sp` block.
 * @returns every run that names an explicit size, colour and text, as python-pptx sees them.
 */
function shapeRuns(shape: string): SlideRun[] {
  const geometry = shapeGeometry(shape)
  if (geometry === null) return []
  const runs: SlideRun[] = []
  for (const match of shape.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
    const inner = match[1] ?? ''
    const open = /<a:rPr\b([^>]*)>/.exec(inner)
    const sizeText = open === null ? null : /\bsz="(\d+)"/.exec(open[1] ?? '')
    const color = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(inner)
    const latin = /<a:latin typeface="([^"]*)"/.exec(inner)
    const font = latin?.[1] ?? /<a:ea typeface="([^"]*)"/.exec(inner)?.[1] ?? ''
    const text = [...inner.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((entry) => entry[1] ?? '').join('')
    if (sizeText === null || color === null || font === '' || text.trim() === '') continue
    runs.push({
      text,
      sizePt: Number(sizeText[1]) / 100,
      bold: /\bb="1"/.test(open?.[1] ?? ''),
      color: `#${(color[1] ?? '').toUpperCase()}`,
      font,
      ...geometry,
    })
  }
  return runs
}

/** @param pkg - the package. @returns each slide's styled runs, in deck order. */
function readSlides(pkg: OpcPackage): SlideFacts[] {
  return listSlides(pkg).map((part, offset) => ({
    index: offset + 1,
    runs: topLevelShapes(pkg.text(part)).flatMap((shape) => shapeRuns(shape)),
  }))
}

/**
 * @param slides - styled runs per slide.
 * @param overrides - explicit 1-based roles.
 * @returns one role per slide, using the extractor's hints where not overridden.
 */
function roleOf(slides: readonly SlideFacts[], overrides: ReadonlyMap<number, DesignRole> | undefined): DesignRole[] {
  return slides.map((slide, offset) => {
    const explicit = overrides?.get(offset + 1)
    if (explicit !== undefined) return explicit
    if (offset === 0) return 'cover'
    if (offset === slides.length - 1) return 'ending'
    const watermark = slide.runs.some((run) => run.sizePt >= 60 && simpleLuminance(run.color) > 0.85)
    if (watermark) return 'section'
    const digits = slide.runs.filter((run) => run.sizePt >= 32 && isNumberLike(run.text))
    if (offset === 1 && digits.length >= 2) return 'toc'
    return 'content'
  })
}

/** @param runs - styled runs. @returns the slide's title run: largest dark, tie by smallest y. */
function chooseTitle(runs: readonly SlideRun[]): { run: SlideRun; rest: SlideRun[] } | null {
  const dark = runs.filter((run) => simpleLuminance(run.color) <= 0.75)
  let title: SlideRun | undefined
  let titleIndex = -1
  for (const [index, run] of dark.entries()) {
    if (title === undefined || run.sizePt > title.sizePt || (run.sizePt === title.sizePt && run.y < title.y)) {
      title = run
      titleIndex = index
    }
  }
  if (title === undefined) return null
  return { run: title, rest: dark.filter((_, index) => index !== titleIndex) }
}

/** @param groups - runs clustered by x. @returns the smallest positive gap between neighbours, in inches. */
function smallestPositiveGap(groups: readonly (readonly SlideRun[])[]): number | undefined {
  const gaps: number[] = []
  for (const [index, left] of groups.entries()) {
    const right = groups[index + 1]
    if (right === undefined) continue
    const rightEdge = Math.max(...left.map((run) => run.x + run.w))
    const leftEdge = Math.min(...right.map((run) => run.x))
    gaps.push((leftEdge - rightEdge) / EMU_PER_INCH)
  }
  const positive = gaps.filter((gap) => gap > 0.05)
  return positive.length === 0 ? undefined : Math.min(...positive)
}

/**
 * @param slides - styled runs per slide.
 * @param roles - role per slide.
 * @returns the per-role measurement the rules compare with the profile.
 */
function measureRoles(slides: readonly SlideFacts[], roles: readonly DesignRole[]): RoleMeasurement[] {
  const measurements = new Map<DesignRole, RoleMeasurement>()
  const titles = new Map<DesignRole, { run: SlideRun; slide: number }[]>()
  for (const [offset, slide] of slides.entries()) {
    const role = roles[offset]
    if (role === undefined) continue
    const measurement = measurements.get(role) ?? { role, slides: [], bodies: [] }
    measurement.slides.push(slide.index)
    const chosen = chooseTitle(slide.runs)
    if (chosen !== null) {
      const list = titles.get(role) ?? []
      list.push({ run: chosen.run, slide: slide.index })
      titles.set(role, list)
      for (const run of chosen.rest) measurement.bodies.push({ run, slide: slide.index })
    }
    for (const run of slide.runs) {
      if (run.sizePt >= 60 && simpleLuminance(run.color) > 0.85 && (measurement.watermark === undefined || run.sizePt > measurement.watermark.sizePt)) {
        measurement.watermark = { sizePt: run.sizePt, slide: slide.index }
      }
    }
    measurements.set(role, measurement)
  }
  for (const [role, candidates] of titles.entries()) {
    const measurement = measurements.get(role)
    if (measurement === undefined) continue
    let title = candidates[0]
    for (const candidate of candidates) {
      if (title === undefined || candidate.run.sizePt > title.run.sizePt || (candidate.run.sizePt === title.run.sizePt && candidate.run.y < title.run.y)) title = candidate
    }
    if (title !== undefined) measurement.title = title
  }
  for (const measurement of measurements.values()) {
    const body = mode(measurement.bodies.map((entry) => `${String(entry.run.sizePt)}\u0000${entry.run.color}\u0000${entry.run.font}`))
    if (body !== undefined) {
      const [size, color] = body.split('\u0000')
      measurement.bodyMode = { sizePt: Number(size), color: color ?? '' }
    }
    const nonGrey = measurement.bodies.filter((entry) => !isGrey(entry.run.color)).map((entry) => entry.run.color)
    const accent = mode(nonGrey)
    if (accent !== undefined) measurement.accent = accent
  }
  for (const measurement of measurements.values()) {
    if (measurement.role !== 'toc' && measurement.role !== 'content') continue
    const counts: number[] = []
    const gaps: number[] = []
    for (const slide of slides) {
      if (roles[slide.index - 1] !== measurement.role) continue
      const clusters: SlideRun[][] = []
      for (const entry of measurement.bodies.filter((candidate) => candidate.slide === slide.index).sort((left, right) => left.run.x - right.run.x)) {
        const last = clusters[clusters.length - 1]
        const previous = last?.[last.length - 1]
        if (last !== undefined && previous !== undefined && entry.run.x - previous.x <= EMU_PER_INCH) last.push(entry.run)
        else clusters.push([entry.run])
      }
      counts.push(Math.max(1, clusters.length))
      const gap = smallestPositiveGap(clusters)
      if (gap !== undefined) gaps.push(gap)
    }
    const columnMode = mode(counts)
    if (columnMode !== undefined) measurement.columns = { mode: columnMode, max: Math.max(...counts) }
    if (gaps.length > 0) measurement.gapIn = Math.min(...gaps)
  }
  return [...measurements.values()]
}

/** @param role - role name prefixed to the message. @param page - 1-based slide, when known. @param rule - stable rule id. @param message - what violated the profile. @returns the finding. */
function designFinding(role: DesignRole, page: number | undefined, rule: string, message: string): FusionFinding {
  return { level: 'error', source: 'design', ...(page === undefined ? {} : { page }), rule, message: `${role} ${message}` }
}

/**
 * Re-measure the package's typography, geometry and chrome and compare with the profile.
 *
 * @param pkg - the published package.
 * @param options - profile, optional role overrides and whether chrome rules apply.
 * @returns one error finding per violated rule; an empty list means the package follows
 *   the profile inside the tolerances.
 */
export function auditDesignPackage(pkg: OpcPackage, options: DesignAuditOptions): FusionFinding[] {
  const findings: FusionFinding[] = []
  const slides = readSlides(pkg)
  const roles = roleOf(slides, options.roles)
  const measurements = measureRoles(slides, roles)
  const size = slideSize(pkg)

  for (const measurement of measurements) {
    const { role } = measurement
    const expected = options.profile.typeScale[role]
    if (expected === undefined) {
      findings.push({ level: 'warning', source: 'design', rule: 'design-role-unprofiled', message: `the deck has a "${role}" page but the profile has no type row for it` })
    }
    if (expected?.title !== undefined && measurement.title !== undefined) {
      const { run, slide } = measurement.title
      if (Math.abs(run.sizePt - expected.title.sizePt) > DESIGN_SIZE_TOLERANCE_PT) {
        findings.push(designFinding(role, slide, 'design-role-title-font', `title is ${String(run.sizePt)} pt but the profile says ${String(expected.title.sizePt)} ±${String(DESIGN_SIZE_TOLERANCE_PT)} pt`))
      }
      const delta = deltaE76(run.color, expected.title.color)
      if (delta > DESIGN_DELTA_E_LIMIT) {
        findings.push(designFinding(role, slide, 'design-role-title-font', `title colour ${run.color} differs from ${expected.title.color} by ΔE ${delta.toFixed(1)}`))
      }
    }
    if (expected?.body !== undefined && measurement.bodyMode !== undefined) {
      const body = measurement.bodyMode
      const slide = measurement.bodies.find((entry) => entry.run.sizePt === body.sizePt && entry.run.color === body.color)?.slide
      if (Math.abs(body.sizePt - expected.body.sizePt) > DESIGN_SIZE_TOLERANCE_PT) {
        findings.push(designFinding(role, slide, 'design-role-title-font', `body is ${String(body.sizePt)} pt but the profile says ${String(expected.body.sizePt)} ±${String(DESIGN_SIZE_TOLERANCE_PT)} pt`))
      }
      const delta = deltaE76(body.color, expected.body.color)
      if (delta > DESIGN_DELTA_E_LIMIT) {
        findings.push(designFinding(role, slide, 'design-role-title-font', `body colour ${body.color} differs from ${expected.body.color} by ΔE ${delta.toFixed(1)}`))
      }
    }
    if (measurement.accent !== undefined) {
      const delta = deltaE76(measurement.accent, options.profile.palette.accent)
      if (delta > DESIGN_DELTA_E_LIMIT) {
        findings.push(designFinding(role, measurement.slides[0], 'design-accent-body-color', `accent run colour ${measurement.accent} differs from ${options.profile.palette.accent} by ΔE ${delta.toFixed(1)}`))
      }
    }
    const geometry = options.profile.roles[role]
    if (geometry !== undefined && measurement.title !== undefined) {
      const { run, slide } = measurement.title
      const dx = Math.abs(run.x / EMU_PER_INCH - geometry.titlePos.x)
      const dy = Math.abs(run.y / EMU_PER_INCH - geometry.titlePos.y)
      if (Math.max(dx, dy) > DESIGN_POSITION_TOLERANCE_IN) {
        findings.push(
          designFinding(
            role,
            slide,
            'design-role-geometry',
            `title anchor (${(run.x / EMU_PER_INCH).toFixed(2)}, ${(run.y / EMU_PER_INCH).toFixed(2)}) in differs from (${geometry.titlePos.x}, ${geometry.titlePos.y}) by more than ${String(DESIGN_POSITION_TOLERANCE_IN)} in`,
          ),
        )
      }
      if (measurement.columns !== undefined && (role === 'toc' || role === 'content')) {
        if (measurement.columns.mode !== geometry.columns) {
          findings.push(designFinding(role, measurement.slides[0], 'design-role-geometry', `content clusters into ${String(measurement.columns.mode)} column(s) but the profile says ${String(geometry.columns)}`))
        }
        const max = geometry.columnsMax ?? geometry.columns
        if (measurement.columns.max > max) {
          findings.push(designFinding(role, measurement.slides[0], 'design-role-geometry', `content clusters into up to ${String(measurement.columns.max)} column(s) but the profile says at most ${String(max)}`))
        }
      }
      if (geometry.cardGapIn !== undefined && measurement.gapIn !== undefined && Math.abs(measurement.gapIn - geometry.cardGapIn) > DESIGN_POSITION_TOLERANCE_IN) {
        findings.push(designFinding(role, measurement.slides[0], 'design-role-geometry', `card gap is ${measurement.gapIn.toFixed(2)} in but the profile says ${String(geometry.cardGapIn)} ±${String(DESIGN_POSITION_TOLERANCE_IN)} in`))
      }
    }
  }

  if (options.chrome !== false) {
    const section = measurements.find((measurement) => measurement.role === 'section')
    const expectedWatermark = options.profile.roles.section?.watermarkSizePt
    if (options.profile.chrome.sectionMarker && expectedWatermark !== undefined && section !== undefined) {
      if (section.watermark === undefined) {
        findings.push(designFinding('section', section.slides[0], 'design-section-marker', 'has no watermark numeral but the profile marks sections'))
      } else if (Math.abs(section.watermark.sizePt - expectedWatermark) > DESIGN_SIZE_TOLERANCE_PT) {
        findings.push(designFinding('section', section.watermark.slide, 'design-section-marker', `watermark numeral is ${String(section.watermark.sizePt)} pt but the profile says ${String(expectedWatermark)} ±${String(DESIGN_SIZE_TOLERANCE_PT)} pt`))
      }
    }
    const measuredPageNumber = slides.some((slide) => slide.runs.some((run) => isNumberLike(run.text) && run.sizePt <= 18 && run.y > size.cy * 0.85))
    if (measuredPageNumber !== options.profile.chrome.pageNumber) {
      findings.push({ level: 'error', source: 'design', rule: 'design-chrome-match', message: `page numbers are ${measuredPageNumber ? 'present' : 'absent'} but the profile says ${options.profile.chrome.pageNumber ? 'present' : 'absent'}` })
    }
    const measuredMetaFooter = slides.some((slide, offset) => (roles[offset] === 'cover' || roles[offset] === 'ending') && slide.runs.some((run) => run.sizePt <= 18 && run.y > size.cy * 0.8))
    if (measuredMetaFooter !== options.profile.chrome.metaFooter) {
      findings.push({ level: 'error', source: 'design', rule: 'design-chrome-match', message: `cover/ending meta footer is ${measuredMetaFooter ? 'present' : 'absent'} but the profile says ${options.profile.chrome.metaFooter ? 'present' : 'absent'}` })
    }
    if (options.profile.chrome.sectionMarker !== (section?.watermark !== undefined)) {
      findings.push({ level: 'error', source: 'design', rule: 'design-chrome-match', message: `section markers are ${section?.watermark !== undefined ? 'present' : 'absent'} but the profile says ${options.profile.chrome.sectionMarker ? 'present' : 'absent'}` })
    }
  }

  return findings
}

/** One rasterised picture sample; production uses sharp, tests inject a fixture. */
export interface PixelRaster {
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly data: Buffer
}

/** Options for {@link auditDesignBackgrounds}. */
export interface DesignBackgroundOptions {
  readonly profile: DesignProfile
  /** 1-based role overrides; without them the extractor's role hints are re-run. */
  readonly roles?: ReadonlyMap<number, DesignRole>
  /** Media ids (file stem) the office discovery record authorises, for `office` mode. */
  readonly officeIds?: ReadonlySet<string>
  /** Media ids the user manifests authorise, for `user` mode. */
  readonly userIds?: ReadonlySet<string>
  /** Rasteriser seam; defaults to sharp. */
  readonly rasterise?: (bytes: Buffer) => Promise<PixelRaster>
}

/** The background picture of one slide, resolved through its relationships. */
interface BackgroundPicture {
  readonly svgPart: string | null
  readonly rasterPart: string | null
  /** Part sampled for contrast: the raster sibling, else the SVG. */
  readonly samplePart: string
}

/** One opaque shape that can occlude the picture under a text box. */
interface OpaqueShape {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly colour: string
}

/** The background facts of one slide. */
interface SlideBackground {
  readonly index: number
  readonly part: string
  readonly role: DesignRole
  readonly xml: string
  readonly picture: BackgroundPicture | null
  readonly overlay: { readonly colour: string; readonly alpha: number } | null
  readonly boxes: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly runs: readonly SlideRun[] }[]
  readonly opaque: readonly OpaqueShape[]
}

/** Raster media extensions a PNG fallback may use. */
const RASTER_MEDIA = /\.(?:png|jpe?g|gif|bmp)$/i

/** Contrast floor for body-scale text over a background (plan B4 `background-mode`). */
export const BACKGROUND_TEXT_CONTRAST_FLOOR = 4.5

/**
 * Share of the pixels under a body text box that must clear the contrast floor.
 * A single mean colour is not how photography reads: the reference deck's worst
 * body box measured 3.49:1 by mean over a light photo with one blue band, while
 * 84 % of its pixels clear 4.5:1. Coverage keeps that page passing and still fails
 * a text box that mostly sits on a dark photo.
 */
export const BACKGROUND_TEXT_COVERAGE_FLOOR = 0.7

/** @param channel - 0-255. @returns the linear-light value. */
function linearise(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** @returns the WCAG relative luminance of an RGB triplet. */
function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * linearise(red) + 0.7152 * linearise(green) + 0.0722 * linearise(blue)
}

/** @param left - one relative luminance. @param right - the other. @returns their WCAG contrast ratio. */
function ratioFromLuminance(left: number, right: number): number {
  const [lighter, darker] = left >= right ? [left, right] : [right, left]
  return (lighter + 0.05) / (darker + 0.05)
}

/** @param hex - `#RRGGBB`. @returns the WCAG relative luminance. */
function hexLuminance(hex: string): number {
  const value = hex.replace(/^#/, '')
  return relativeLuminance(
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  )
}

/**
 * @param raster - rasterised picture.
 * @param box - the text box in EMU.
 * @param canvas - slide size in EMU.
 * @param textColour - the run colour.
 * @param overlay - the overlay fill applied above the picture, when present.
 * @returns the share of the box's picture pixels that clear the contrast floor after
 *   the overlay blend.
 */
function regionCoverage(raster: PixelRaster, box: { x: number; y: number; w: number; h: number }, canvas: { cx: number; cy: number }, textColour: string, overlay: { colour: string; alpha: number } | null): number {
  const x0 = Math.max(0, Math.floor((box.x / canvas.cx) * raster.width))
  const y0 = Math.max(0, Math.floor((box.y / canvas.cy) * raster.height))
  const x1 = Math.min(raster.width, Math.ceil(((box.x + box.w) / canvas.cx) * raster.width))
  const y1 = Math.min(raster.height, Math.ceil(((box.y + box.h) / canvas.cy) * raster.height))
  const text = hexLuminance(textColour)
  const over = overlay === null ? null : overlay.colour.replace(/^#/, '')
  const overRed = over === null ? 0 : Number.parseInt(over.slice(0, 2), 16)
  const overGreen = over === null ? 0 : Number.parseInt(over.slice(2, 4), 16)
  const overBlue = over === null ? 0 : Number.parseInt(over.slice(4, 6), 16)
  const alpha = overlay?.alpha ?? 0
  let passing = 0
  let total = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * raster.width + x) * raster.channels
      const red = raster.data[offset] ?? 0
      const green = raster.data[offset + 1] ?? 0
      const blue = raster.data[offset + 2] ?? 0
      const blended =
        over === null
          ? relativeLuminance(red, green, blue)
          : relativeLuminance(red + (overRed - red) * alpha, green + (overGreen - green) * alpha, blue + (overBlue - blue) * alpha)
      if (ratioFromLuminance(blended, text) >= BACKGROUND_TEXT_CONTRAST_FLOOR) passing += 1
      total += 1
    }
  }
  return total === 0 ? 0 : passing / total
}

/** @param bytes - picture bytes. @returns the default sharp rasteriser. */
async function rasteriseWithSharp(bytes: Buffer): Promise<PixelRaster> {
  const { default: sharp } = await import('sharp')
  const { data, info } = await sharp(bytes).resize({ width: 480, height: 270, fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, channels: info.channels, data }
}

/** @param hex - `#RRGGBB` with or without the hash. @returns the uppercase `#RRGGBB`. */
function normalized(hex: string): string {
  return `#${hex.replace(/^#/, '').toUpperCase()}`
}

/** @param slidePart - part the relationship belongs to. @param relationships - that part's relationships. @param id - relationship id. @returns the resolved part, or null. */
function partOf(slidePart: string, relationships: ReturnType<OpcPackage['relationshipsOf']>, id: string | undefined): string | null {
  if (id === undefined) return null
  const rel = relationships.find((entry) => entry.id === id)
  return rel === undefined ? null : resolveTarget(slidePart, rel.target)
}

/** @param shape - one shape block. @param canvas - slide size in EMU. @returns true when the shape covers at least 90% of the canvas. */
function fullCanvas(shape: string, canvas: { cx: number; cy: number }): boolean {
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)
  return ext !== null && Number(ext[1]) >= canvas.cx * 0.9 && Number(ext[2]) >= canvas.cy * 0.9
}

/** @param pkg - the package. @param slidePart - the slide. @param xml - its XML. @param canvas - slide size in EMU. @returns the full-canvas picture facts, or null. */
function readPicture(pkg: OpcPackage, slidePart: string, xml: string, canvas: { cx: number; cy: number }): BackgroundPicture | null {
  const relationships = pkg.relationshipsOf(slidePart)
  for (const match of xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
    const shape = match[0]
    if (!fullCanvas(shape, canvas)) continue
    const svgRel = /<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/.exec(shape)?.[1]
    const mainRel = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(shape)?.[1]
    const svgPart = partOf(slidePart, relationships, svgRel)
    const mainPart = partOf(slidePart, relationships, mainRel)
    const rasterPart = mainPart !== null && RASTER_MEDIA.test(mainPart) ? mainPart : null
    const samplePart = rasterPart ?? svgPart ?? mainPart
    if (samplePart === null) continue
    return { svgPart: svgPart !== null && /\.svg$/i.test(svgPart) ? svgPart : null, rasterPart, samplePart }
  }
  return null
}

/** @param shape - one shape block. @returns its `p:spPr` XML, or an empty string. */
function shapeProperties(shape: string): string {
  return /<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>|<p:spPr\b[^>]*\/>/.exec(shape)?.[0] ?? ''
}

/** @param xml - one slide part. @param canvas - slide size in EMU. @returns the full-canvas overlay fill, when present. */
function readOverlay(xml: string, canvas: { cx: number; cy: number }): { colour: string; alpha: number } | null {
  for (const shape of topLevelShapes(xml)) {
    if (!fullCanvas(shape, canvas)) continue
    const fill = /<a:solidFill>\s*<a:srgbClr val="#?([0-9A-Fa-f]{6})"\s*>\s*<a:alpha val="(\d+)"\s*\/>\s*<\/a:srgbClr>\s*<\/a:solidFill>/.exec(shapeProperties(shape))
    if (fill === null) continue
    return { colour: normalized(fill[1] ?? ''), alpha: Number(fill[2]) / 100000 }
  }
  return null
}

/** @param xml - one slide part. @returns the opaque shape-properties fills that can sit above the picture. */
function readOpaqueShapes(xml: string): OpaqueShape[] {
  const shapes: OpaqueShape[] = []
  for (const shape of topLevelShapes(xml)) {
    const geometry = shapeGeometry(shape)
    if (geometry === null) continue
    const fill = /<a:solidFill>\s*<a:srgbClr val="#?([0-9A-Fa-f]{6})"\s*\/>\s*<\/a:solidFill>/.exec(shapeProperties(shape))
    if (fill === null) continue
    shapes.push({ ...geometry, colour: normalized(fill[1] ?? '') })
  }
  return shapes
}

/** @param xml - one slide part. @returns text boxes with their styled runs. */
function readTextBoxes(xml: string): SlideBackground['boxes'] {
  const boxes: { x: number; y: number; w: number; h: number; runs: SlideRun[] }[] = []
  for (const shape of topLevelShapes(xml)) {
    const geometry = shapeGeometry(shape)
    if (geometry === null) continue
    const runs = shapeRuns(shape)
    if (runs.length === 0) continue
    boxes.push({ ...geometry, runs })
  }
  return boxes
}

/** @param pkg - the package. @param slidePart - the slide. @param index - 1-based position. @param role - its role. @param canvas - slide size in EMU. @returns the slide's background facts. */
function readBackground(pkg: OpcPackage, slidePart: string, index: number, role: DesignRole, canvas: { cx: number; cy: number }): SlideBackground {
  const xml = pkg.text(slidePart)
  return {
    index,
    part: slidePart,
    role,
    xml,
    picture: readPicture(pkg, slidePart, xml, canvas),
    overlay: readOverlay(xml, canvas),
    boxes: readTextBoxes(xml),
    opaque: readOpaqueShapes(xml),
  }
}

/** @param slide - one slide's background facts. @param box - one text box. @returns the last opaque shape covering at least 90% of the box, or null. */
function coveringFill(slide: SlideBackground, box: { x: number; y: number; w: number; h: number }): string | null {
  let found: string | null = null
  for (const shape of slide.opaque) {
    const width = Math.max(0, Math.min(box.x + box.w, shape.x + shape.w) - Math.max(box.x, shape.x))
    const height = Math.max(0, Math.min(box.y + box.h, shape.y + shape.h) - Math.max(box.y, shape.y))
    if (width * height >= box.w * box.h * 0.9) found = shape.colour
  }
  return found
}

/** @param xml - one slide part. @returns the `p:bg` solid fill colour, when present. */
function flatFill(xml: string): string | null {
  const match = /<p:bg>[\s\S]*?<a:srgbClr val="#?([0-9A-Fa-f]{6})"/.exec(xml)
  return match === null ? null : normalized(match[1] ?? '')
}

/**
 * Check the package's background mode, overlay/contrast and SVG fallback against the
 * profile (V7.2 B4, rule `design-background-mode`).
 *
 * The deck-level mode mirrors the extractor: any full-canvas picture makes the deck a
 * picture deck, and an `asvg:svgBlip` makes it an SVG deck. Picture pages are then
 * checked for the plan's real requirement — body-scale text (up to the role's body
 * size + 2 pt) keeps ≥ 4.5:1 over at least 70 % of the pixels under its box, where
 * the pixels are the picture blended with the overlay shape when one is present and
 * the topmost opaque shape covering the text wins instead. An overlay shape is not
 * required when coverage already proves the contrast, which keeps a hand-authored
 * reference deck with a baked-in wash compliant.
 *
 * @param pkg - the published package.
 * @param options - profile, roles, provenance id sets and the rasteriser seam.
 * @returns one error finding per mode mismatch, missing PNG fallback or contrast violation.
 */
export async function auditDesignBackgrounds(pkg: OpcPackage, options: DesignBackgroundOptions): Promise<FusionFinding[]> {
  const findings: FusionFinding[] = []
  const canvas = slideSize(pkg)
  const slides = readSlides(pkg)
  const roles = roleOf(slides, options.roles)
  const facts = listSlides(pkg).map((part, offset) => readBackground(pkg, part, offset + 1, roles[offset] ?? 'content', canvas))
  const pictures = facts.filter((fact) => fact.picture !== null)
  const svgCount = pictures.filter((fact) => fact.picture?.svgPart !== null).length
  const rasterCount = pictures.length - svgCount
  const measured = svgCount > 0 && rasterCount > 0 ? 'mixed' : svgCount > 0 ? 'svg' : rasterCount > 0 ? 'photo' : 'flat'
  const expected = options.profile.background.mode
  const pictureExpected = expected === 'svg' || expected === 'photo' || expected === 'office' || expected === 'user'
  const modeMatches = expected === 'flat' ? measured === 'flat' : expected === 'svg' ? measured === 'svg' : pictureExpected ? measured === 'photo' : false
  if (measured === 'mixed') {
    findings.push({ level: 'error', source: 'design', rule: 'design-background-mode', message: 'full-bleed backgrounds mix SVG and raster pictures; a deck must use one picture mode' })
  } else if (!modeMatches) {
    findings.push({
      level: 'error',
      source: 'design',
      rule: 'design-background-mode',
      message: `background images are ${measured} but the profile says ${expected}; the flat colour stays until the mode's asset is attached`,
    })
  }

  for (const fact of facts) {
    const picture = fact.picture
    if (picture === null) continue
    if (expected === 'office' || expected === 'user') {
      const ids = expected === 'office' ? options.officeIds : options.userIds
      if (ids === undefined) {
        findings.push({ level: 'error', source: 'design', page: fact.index, rule: 'design-background-mode', message: `${expected} background cannot be verified without the library record` })
      } else {
        const stem = (picture.samplePart.split('/').pop() ?? '').replace(/\.[^.]+$/, '')
        if (!ids.has(stem)) {
          findings.push({ level: 'error', source: 'design', page: fact.index, rule: 'design-background-mode', message: `${expected} background ${picture.samplePart} is not an id of the ${expected} library` })
        }
      }
    }
    if (picture.svgPart !== null && picture.rasterPart === null) {
      findings.push({ level: 'error', source: 'design', page: fact.index, rule: 'design-background-mode', message: `SVG background ${picture.svgPart} has no raster fallback; run the compat pass so Office 2013 can render it` })
    }
    const bodySize = options.profile.typeScale[fact.role]?.body?.sizePt ?? 20
    const candidates = fact.boxes.flatMap((box) => box.runs.filter((run) => run.sizePt <= bodySize + 2).map((run) => ({ run, box })))
    if (candidates.length === 0) continue
    let raster: PixelRaster | null = null
    if (pkg.has(picture.samplePart) && !/\.svg$/i.test(picture.samplePart)) raster = await (options.rasterise ?? rasteriseWithSharp)(pkg.part(picture.samplePart))
    let worst: { coverage: number; run: SlideRun } | null = null
    for (const candidate of candidates) {
      const occluded = coveringFill(fact, candidate.box)
      const coverage =
        occluded !== null
          ? contrastRatio(candidate.run.color, occluded) >= BACKGROUND_TEXT_CONTRAST_FLOOR
            ? 1
            : 0
          : raster !== null
            ? regionCoverage(raster, candidate.box, canvas, candidate.run.color, fact.overlay)
            : contrastRatio(candidate.run.color, flatFill(fact.xml) ?? options.profile.palette.bg) >= BACKGROUND_TEXT_CONTRAST_FLOOR
              ? 1
              : 0
      if (worst === null || coverage < worst.coverage) worst = { coverage, run: candidate.run }
    }
    if (worst !== null && worst.coverage < BACKGROUND_TEXT_COVERAGE_FLOOR) {
      // A plugin-owned picture carries an overlay this audit can hold to the floor. A
      // hand-authored deck without one cannot be repaired by the audit, so the same
      // measurement is a warning that names the missing overlay (ADR-062).
      const overlayNote = fact.overlay === null ? ' and the page has no overlay shape to raise it' : ''
      findings.push({
        level: fact.overlay === null ? 'warning' : 'error',
        source: 'design',
        page: fact.index,
        rule: 'design-background-mode',
        message: `body text ${worst.run.color} keeps ${String(BACKGROUND_TEXT_CONTRAST_FLOOR)}:1 on only ${(worst.coverage * 100).toFixed(0)}% of its background (floor ${(BACKGROUND_TEXT_COVERAGE_FLOOR * 100).toFixed(0)}%)${overlayNote}`,
      })
    }
  }
  return findings
}
