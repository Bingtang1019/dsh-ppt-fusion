import { DshPptFailure } from '../engine/errors.ts'
import { CONTENT_TYPE, REL, freePartName, listSlides, relativeTarget, type OpcPackage, type Relationship } from './opc.ts'
import { slideSize } from './chrome.ts'
import { contrastRatio } from './profile-theme.ts'
import { mixHex, svgBackground, type SvgBackground } from './svg-background.ts'
import type { DesignBackgroundMode, DesignProfile, DesignRole } from '../schema/design-profile.ts'
import type { ChromeRole } from '../schema/fusion.ts'

/**
 * The post background layer (V7.2 B2.5).
 *
 * Every page gets its background from one owner after the merge and before the
 * compat pass: `flat` writes a solid `p:bg` fill, `svg` inserts a generated
 * full-canvas SVG picture with an overlay shape above it, and every other mode
 * falls back to `flat` while recording that its picture source is not attached
 * yet. The compat pass then stamps the SVG picture with its PNG sibling (B7), so
 * Office 2013 and 2016+ both render it.
 */

/** Minimum contrast a background colour must keep against the profile's text inks. */
export const BACKGROUND_CONTRAST_FLOOR = 4.5

/**
 * @param role - chrome vocabulary role of one IR slide.
 * @returns the design-profile role a generated background composes for; the
 *   content-only roles (`data`, `quote`) share the content composition.
 */
export function designRoleFor(role: ChromeRole): DesignRole {
  switch (role) {
    case 'cover':
      return 'cover'
    case 'section':
      return 'section'
    case 'ending':
      return 'ending'
    case 'content':
    case 'data':
    case 'quote':
      return 'content'
  }
}

/** One page the background layer paints, in deck order. */
export interface BackgroundPage {
  /** 1-based deck position. */
  readonly index: number
  readonly role: DesignRole
}

/** How one page's background was applied. */
export type BackgroundApplication = 'flat' | 'svg' | 'fallback-flat'

/** What one page's background applied. */
export interface BackgroundSlideReport {
  readonly index: number
  readonly role: DesignRole
  readonly application: BackgroundApplication
  /** Overlay opacity from the profile (0 when no overlay shape was inserted). */
  readonly overlayOpacity: number
  /** Worst contrast between the profile's text inks and the effective background. */
  readonly minContrast: number
  /** Package part of the generated SVG, when one was inserted. */
  readonly svgPart?: string
}

/** What the whole background pass applied. */
export interface BackgroundReport {
  readonly mode: DesignBackgroundMode
  readonly application: BackgroundApplication | 'svg'
  readonly slides: readonly BackgroundSlideReport[]
  /** Generated SVG parts, in first-use order. */
  readonly parts: readonly string[]
  readonly minContrast: number
  readonly notes: readonly string[]
}

/** Options for {@link applyProfileBackgrounds}. */
export interface BackgroundApplyOptions {
  readonly profile: DesignProfile
  readonly pages: readonly BackgroundPage[]
  /** Generator seam; defaults to {@link svgBackground}. */
  readonly generate?: (role: DesignRole, profile: DesignProfile) => SvgBackground
}

/**
 * @param profile - validated design profile.
 * @param colours - opaque background colours the page paints.
 * @param overlayOpacity - opacity of the profile-background overlay above them.
 * @returns the worst WCAG contrast between the profile's text inks and every
 *   overlay-blended background colour.
 */
export function backgroundContrast(profile: DesignProfile, colours: readonly string[], overlayOpacity: number): number {
  const inks = [profile.palette.title, profile.palette.body, profile.palette.muted]
  let worst = Number.POSITIVE_INFINITY
  for (const colour of colours) {
    const effective = mixHex(colour, profile.palette.bg, overlayOpacity)
    for (const ink of inks) worst = Math.min(worst, contrastRatio(ink, effective))
  }
  return worst
}

/**
 * @param profile - validated design profile.
 * @param colours - background colours about to be applied.
 * @param overlayOpacity - overlay opacity above them.
 * @param subject - what is being applied, for the message.
 * @throws DshPptFailure `ContractViolation` when a text ink falls below the floor.
 */
function assertBackgroundContrast(profile: DesignProfile, colours: readonly string[], overlayOpacity: number, subject: string): void {
  const worst = backgroundContrast(profile, colours, overlayOpacity)
  if (worst >= BACKGROUND_CONTRAST_FLOOR) return
  throw new DshPptFailure(
    'ContractViolation',
    `${subject} keeps only ${worst.toFixed(2)}:1 against the profile's text inks, below the ${String(BACKGROUND_CONTRAST_FLOOR)}:1 floor; weaken the accent tint or raise background.overlayOpacity`,
    { detail: { subject, contrast: worst, floor: BACKGROUND_CONTRAST_FLOOR, colours, overlayOpacity } },
  )
}

/** @param relationships - current relationships of one part. @returns a free `rIdN`. */
function nextRelationshipId(relationships: readonly Relationship[]): string {
  const ids = new Set(relationships.map((relationship) => relationship.id))
  let index = 1
  while (ids.has(`rId${String(index)}`)) index += 1
  return `rId${String(index)}`
}

/** @param xml - slide part. @returns the highest `p:cNvPr` id, or 0 when there is none. */
function highestShapeId(xml: string): number {
  let max = 0
  for (const match of xml.matchAll(/<p:cNvPr id="(\d+)"/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max
}

/**
 * @param xml - slide part.
 * @param size - canvas size in EMU.
 * @returns the offset just past a leading full-canvas opaque rectangle, or
 *   `null` when the shape tree does not open with one.
 *
 * pptwise paints every standard page as an opaque full-canvas rectangle ahead of
 * its content. A background inserted ahead of that rectangle is invisible in
 * PowerPoint and WPS, so the generated picture has to land above it.
 */
function leadingPageRectEnd(xml: string, size: { cx: number; cy: number }): number | null {
  const tree = /<p:spTree\b[^>]*>/.exec(xml)
  if (tree === null) return null
  const anchor = /<p:grpSpPr\b[^>]*>[\s\S]*?<\/p:grpSpPr>|<p:grpSpPr\b[^>]*\/>/.exec(xml)
  const from = anchor !== null ? anchor.index + anchor[0].length : tree.index + tree[0].length
  const first = /<p:(sp|pic|graphicFrame|cxnSp|grpSp)\b[^>]*>/.exec(xml.slice(from))
  if (first === null || first[1] !== 'sp') return null
  const open = from + first.index
  const close = xml.indexOf('</p:sp>', open)
  if (close === -1) return null
  const shape = xml.slice(open, close + '</p:sp>'.length)
  const offset = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/.exec(shape)
  if (offset === null || Number(offset[1]) !== 0 || Number(offset[2]) !== 0) return null
  const extent = /<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(shape)
  if (extent === null || Number(extent[1]) < size.cx * 0.98 || Number(extent[2]) < size.cy * 0.98) return null
  const opaqueFill = /<a:solidFill><a:srgbClr val="[0-9A-Fa-f]{6}"\s*\/><\/a:solidFill>/.exec(shape)
  if (opaqueFill === null) return null
  return close + '</p:sp>'.length
}

/**
 * @param xml - slide part.
 * @param shapes - shape XML to place before every authored shape.
 * @param size - canvas size in EMU.
 * @returns the slide with `shapes` inserted behind the authored content and, on
 *   a standard page, above the leading full-canvas rectangle the base render wrote.
 * @throws DshPptFailure `ContractViolation` when the slide has no shape tree.
 */
function insertBehindContent(xml: string, shapes: string, size: { cx: number; cy: number }): string {
  const tree = /<p:spTree\b[^>]*>/.exec(xml)
  if (tree === null) {
    throw new DshPptFailure('ContractViolation', 'a slide has no p:spTree, so a background cannot be inserted', { detail: {} })
  }
  const rectEnd = leadingPageRectEnd(xml, size)
  if (rectEnd !== null) return xml.slice(0, rectEnd) + shapes + xml.slice(rectEnd)
  const after = tree.index + tree[0].length
  const group = /<p:grpSpPr\b[^>]*>[\s\S]*?<\/p:grpSpPr>|<p:grpSpPr\b[^>]*\/>/.exec(xml)
  if (group !== null) return xml.slice(0, group.index + group[0].length) + shapes + xml.slice(group.index + group[0].length)
  const nonVisual = /<p:nvGrpSpPr\b[^>]*>[\s\S]*?<\/p:nvGrpSpPr>|<p:nvGrpSpPr\b[^>]*\/>/.exec(xml)
  if (nonVisual !== null) return xml.slice(0, nonVisual.index + nonVisual[0].length) + shapes + xml.slice(nonVisual.index + nonVisual[0].length)
  return xml.slice(0, after) + shapes + xml.slice(after)
}

/** @param colour - `#RRGGBB` or `RRGGBB`. @returns the bare hex value DrawingML expects. */
function srgbValue(colour: string): string {
  return colour.replace(/^#/, '')
}

/**
 * @param xml - slide part.
 * @param colour - validated uppercase `#RRGGBB`.
 * @returns the slide with a solid `p:bg` fill, replacing an existing `p:bg`.
 * @throws DshPptFailure `ContractViolation` when the slide has no `p:cSld`.
 */
function withSolidBackground(xml: string, colour: string): string {
  const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${srgbValue(colour)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
  const existing = /<p:bg>[\s\S]*?<\/p:bg>/.exec(xml)
  if (existing !== null) return xml.slice(0, existing.index) + background + xml.slice(existing.index + existing[0].length)
  const content = /<p:cSld\b[^>]*>/.exec(xml)
  if (content === null) {
    throw new DshPptFailure('ContractViolation', 'a slide has no p:cSld, so a background fill cannot be written', { detail: {} })
  }
  return `${xml.slice(0, content.index + content[0].length)}${background}${xml.slice(content.index + content[0].length)}`
}

/** @returns the full-canvas SVG picture XML with the B7 `asvg:svgBlip` extension. */
function pictureXml(id: number, relId: string, size: { cx: number; cy: number }): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="dsh-background"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${relId}"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(size.cx)}" cy="${String(size.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

/** @returns the full-canvas overlay XML; `alpha` is 0–1 and written in 1/1000 %. */
function overlayXml(id: number, colour: string, alpha: number, size: { cx: number; cy: number }): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="dsh-background-overlay"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${String(size.cx)}" cy="${String(size.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${srgbValue(colour)}"><a:alpha val="${String(Math.round(alpha * 100000))}"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
}

/** @returns an image relationship on `slidePart`, appended after the existing ones. */
function appendImageRelationship(pkg: OpcPackage, slidePart: string, part: string): string {
  const relationships = pkg.relationshipsOf(slidePart)
  const id = nextRelationshipId(relationships)
  pkg.setRelationships(slidePart, [...relationships, { id, type: REL.image, target: relativeTarget(slidePart, part) }])
  return id
}

/**
 * Apply the profile's background mode to every slide.
 *
 * `svg` generates one deterministic SVG per role, inserts it behind the authored
 * content with an overlay above it, and leaves the SVG part for the compat pass to
 * stamp with its PNG sibling. `flat` writes the profile background colour as the
 * slide background. `photo`, `office` and `user` need an explicit asset reference
 * that the profile does not carry yet, so they apply the flat colour and record a
 * note instead of pretending the picture exists.
 *
 * @param pkg - package to mutate after the merge and before chrome.
 * @param options - profile, page roles and generator seam.
 * @returns what each page applied, the generated parts and the worst contrast.
 * @throws DshPptFailure `ContractViolation` for a page/slide count mismatch or a
 *   background that drops a profile text ink below {@link BACKGROUND_CONTRAST_FLOOR}.
 */
export function applyProfileBackgrounds(pkg: OpcPackage, options: BackgroundApplyOptions): BackgroundReport {
  const slides = listSlides(pkg)
  if (slides.length !== options.pages.length) {
    throw new DshPptFailure('ContractViolation', `background pages cover ${String(options.pages.length)} slide(s) but the deck has ${String(slides.length)}`, {
      detail: { pages: options.pages.length, slides: slides.length },
    })
  }
  const size = slideSize(pkg)
  const { profile } = options
  const generate = options.generate ?? svgBackground
  const overlayOpacity = profile.background.overlayOpacity
  const mode = profile.background.mode
  const notes: string[] = []
  const application: BackgroundApplication = mode === 'svg' ? 'svg' : 'flat'
  if (mode === 'photo' || mode === 'office' || mode === 'user') {
    notes.push(`${mode} background needs an explicit asset reference, which the design profile does not carry yet; applied the profile background colour`)
  }
  const svgByRole = new Map<DesignRole, { part: string; colours: readonly string[] }>()
  const parts: string[] = []
  const reports: BackgroundSlideReport[] = []
  for (const [offset, slidePart] of slides.entries()) {
    const page = options.pages[offset]
    if (page === undefined) continue
    if (application === 'svg') {
      let entry = svgByRole.get(page.role)
      if (entry === undefined) {
        const generated = generate(page.role, profile)
        assertBackgroundContrast(profile, generated.colours, overlayOpacity, `${page.role} background`)
        const part = freePartName(pkg, new Set(parts), `ppt/media/dsh-bg-${page.role}.svg`)
        pkg.setPart(part, generated.svg)
        pkg.ensureContentType(part, CONTENT_TYPE.svg)
        entry = { part, colours: generated.colours }
        svgByRole.set(page.role, entry)
        parts.push(part)
      }
      const relId = appendImageRelationship(pkg, slidePart, entry.part)
      const xml = pkg.text(slidePart)
      const firstId = highestShapeId(xml) + 1
      const shapes = overlayOpacity > 0 ? pictureXml(firstId, relId, size) + overlayXml(firstId + 1, profile.palette.bg, overlayOpacity, size) : pictureXml(firstId, relId, size)
      pkg.setPart(slidePart, insertBehindContent(xml, shapes, size))
      reports.push({
        index: page.index,
        role: page.role,
        application: 'svg',
        overlayOpacity,
        minContrast: backgroundContrast(profile, entry.colours, overlayOpacity),
        svgPart: entry.part,
      })
      continue
    }
    assertBackgroundContrast(profile, [profile.palette.bg], overlayOpacity, `${mode} background`)
    pkg.setPart(slidePart, withSolidBackground(pkg.text(slidePart), profile.palette.bg))
    reports.push({
      index: page.index,
      role: page.role,
      application,
      overlayOpacity,
      minContrast: backgroundContrast(profile, [profile.palette.bg], overlayOpacity),
    })
  }
  const contrasts = reports.map((report) => report.minContrast)
  return { mode, application, slides: reports, parts, minContrast: contrasts.length === 0 ? 0 : Math.min(...contrasts), notes }
}
