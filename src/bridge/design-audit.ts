import { deltaE76 } from './pixels.ts'
import { listSlides, type OpcPackage } from './opc.ts'
import { slideSize } from './chrome.ts'
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
