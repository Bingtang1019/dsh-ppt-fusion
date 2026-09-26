// Worktree diff: what changed between two versions of a deck (ADR-086, plan Part C).
//
// Three answers, because a deck changes in three different ways and only one of them
// is a file difference:
//
// - **semantic** (T1): the two packages are canonicalised, each slide is attributed
//   the parts it owns through the relationship graph, and the pages are compared
//   part by part. Two exports of the same deck are equal even though their
//   timestamps and embedded workbooks differ, which is what makes the result worth
//   reading (ADR-014/ADR-017).
// - **audit**: the recorded findings of both versions, as added and removed sets.
//   A page that loses a `render-overflow` finding and gains a `contrast` one is a
//   change a reviewer needs to see even when the page diff is small.
// - **render**: the page images both versions produced, compared per page as the
//   share of pixels that differ. This is the only mode that can see a layout that
//   changed without any XML changing (a font substitution, an engine shift).
//
// Nothing here decides whether a change is good; it reports what moved so the user
// can approve or discard the draft (D3: approval is a user action).
import { join } from 'node:path'
import { canonicalize, type CanonicalPart } from './canonical.ts'
import { parseRels, resolveTarget } from './opc.ts'
import { basename } from 'node:path'
import type { FusionFinding } from '../audit.ts'

/** How one page differs between the two versions. */
export interface PageChange {
  readonly index: number
  readonly status: 'same' | 'added' | 'removed' | 'modified'
  /** Shape-element counts on each side (`p:sp`, `p:pic`, `p:graphicFrame`, `p:grpSp`). */
  readonly shapes: { readonly left: number; readonly right: number }
  readonly changedParts: readonly string[]
  readonly notes: readonly string[]
}

/** The canonical comparison of two packages, page by page. */
export interface SemanticDiff {
  readonly equal: boolean
  readonly left: { readonly pages: number; readonly parts: number }
  readonly right: { readonly pages: number; readonly parts: number }
  readonly pages: readonly PageChange[]
  /** Parts outside every slide (theme, master, layouts, docProps) that changed. */
  readonly globalParts: readonly string[]
  readonly summary: string
}

/** Findings added and removed between two recorded audits. */
export interface AuditDelta {
  readonly added: readonly FusionFinding[]
  readonly removed: readonly FusionFinding[]
  readonly unchanged: number
  readonly summary: string
}

/** One page's rasterised difference. */
export interface RenderPageDelta {
  readonly index: number
  /** Share of sampled pixels that differ by more than the threshold. */
  readonly rate: number
}

/** The page-image comparison of two versions. */
export interface RenderDiff {
  readonly pages: readonly RenderPageDelta[]
  readonly meanRate: number
  readonly compared: number
  readonly onlyLeft: readonly number[]
  readonly onlyRight: readonly number[]
  readonly summary: string
}

/** Pixel difference (0–255) below which two samples count as the same. */
export const RENDER_DIFF_THRESHOLD = 8

/** Width the comparison downscales to, so anti-aliasing noise cannot dominate. */
export const RENDER_DIFF_WIDTH = 640

/** Shape elements counted per page. */
const SHAPE_ELEMENTS = ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp'] as const

/**
 * @param part - one canonical part.
 * @returns a comparable string; nested packages recurse over their sorted parts.
 */
function fingerprint(part: CanonicalPart): string {
  if (typeof part === 'string') return `xml:${part}`
  if ('sha256' in part) return `bin:${part.sha256}`
  const nested = part.nested
  return `pkg:${[...nested.parts.keys()]
    .sort()
    .map((name) => `${name}=${fingerprint(nested.parts.get(name) ?? '')}`)
    .join('|')}`
}

/** @param part - one canonical part. @returns its XML text, or null for binary/nested parts. */
function xmlOf(part: CanonicalPart | undefined): string | null {
  return typeof part === 'string' ? part : null
}

/**
 * @param parts - a canonical package.
 * @returns slide part names in presentation order, falling back to the numeric suffix.
 */
function slideOrder(parts: ReadonlyMap<string, CanonicalPart>): string[] {
  const presentation = xmlOf(parts.get('ppt/presentation.xml'))
  const rels = xmlOf(parts.get('ppt/_rels/presentation.xml.rels'))
  if (presentation !== null && rels !== null) {
    const targets = new Map(parseRels(rels).map((relationship) => [relationship.id, relationship.target]))
    const ordered: string[] = []
    for (const match of presentation.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
      const target = targets.get(match[1] ?? '')
      if (target === undefined) continue
      const resolved = resolveTarget('ppt/presentation.xml', target)
      if (parts.has(resolved)) ordered.push(resolved)
    }
    if (ordered.length > 0) return ordered
  }
  return [...parts.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(/(\d+)/.exec(left)?.[1] ?? 0) - Number(/(\d+)/.exec(right)?.[1] ?? 0))
}

/**
 * @param parts - a canonical package.
 * @param slide - one slide part name.
 * @returns the slide's own parts plus everything reachable through its relationships
 *   (notes, charts, images, diagrams), which is what "this page changed" means.
 */
function partsOfSlide(parts: ReadonlyMap<string, CanonicalPart>, slide: string): Set<string> {
  const owned = new Set<string>([slide])
  const queue = [slide]
  while (queue.length > 0) {
    const part = queue.shift() ?? ''
    const relsName = part.includes('/') ? `${part.slice(0, part.lastIndexOf('/'))}/_rels/${basename(part)}.rels` : `_rels/${part}.rels`
    const xml = xmlOf(parts.get(relsName))
    if (xml === null) continue
    owned.add(relsName)
    for (const relationship of parseRels(xml)) {
      if (relationship.targetMode === 'External') continue
      const target = resolveTarget(part, relationship.target)
      if (!parts.has(target) || owned.has(target)) continue
      owned.add(target)
      queue.push(target)
    }
  }
  return owned
}

/** @param xml - slide XML. @returns how many shape elements of each kind it holds. */
function shapeCounts(xml: string): { total: number; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {}
  let total = 0
  for (const element of SHAPE_ELEMENTS) {
    const count = [...xml.matchAll(new RegExp(`<${element}[ >]`, 'g'))].length
    kinds[element] = count
    total += count
  }
  return { total, kinds }
}

/** @param xml - chart XML. @returns its plotted values in document order. */
function chartValues(xml: string): string[] {
  return [...xml.matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((match) => match[1] ?? '')
}

/**
 * Compare two packages page by page.
 *
 * @param left - the older package bytes.
 * @param right - the newer package bytes.
 * @returns the page-level changes, the parts that changed outside every slide, and a one-line summary.
 * @throws DshPptFailure when either buffer is not a readable package.
 */
export async function diffSemantic(left: Buffer, right: Buffer): Promise<SemanticDiff> {
  const leftPackage = await canonicalize(left)
  const rightPackage = await canonicalize(right)
  const leftSlides = slideOrder(leftPackage.parts)
  const rightSlides = slideOrder(rightPackage.parts)
  const byIndex = new Map<string, number>()
  leftSlides.forEach((slide, offset) => byIndex.set(slide, offset))
  rightSlides.forEach((slide, offset) => byIndex.set(`right:${slide}`, offset))
  const owned = new Map<number, { left?: Set<string>; right?: Set<string> }>()
  for (const [offset, slide] of leftSlides.entries()) {
    const entry = owned.get(offset) ?? {}
    entry.left = partsOfSlide(leftPackage.parts, slide)
    owned.set(offset, entry)
  }
  for (const [offset, slide] of rightSlides.entries()) {
    const entry = owned.get(offset) ?? {}
    entry.right = partsOfSlide(rightPackage.parts, slide)
    owned.set(offset, entry)
  }

  const pageCount = Math.max(leftSlides.length, rightSlides.length)
  const pages: PageChange[] = []
  const claimedLeft = new Set<string>()
  const claimedRight = new Set<string>()
  for (const slices of owned.values()) {
    for (const name of slices.left ?? []) claimedLeft.add(name)
    for (const name of slices.right ?? []) claimedRight.add(name)
  }

  for (let index = 0; index < pageCount; index += 1) {
    const leftSlide = leftSlides[index]
    const rightSlide = rightSlides[index]
    const leftParts = owned.get(index)?.left
    const rightParts = owned.get(index)?.right
    const leftXml = leftSlide === undefined ? null : xmlOf(leftPackage.parts.get(leftSlide))
    const rightXml = rightSlide === undefined ? null : xmlOf(rightPackage.parts.get(rightSlide))
    const shapes = {
      left: leftXml === null ? 0 : shapeCounts(leftXml).total,
      right: rightXml === null ? 0 : shapeCounts(rightXml).total,
    }
    if (leftSlide === undefined || rightSlide === undefined) {
      pages.push({
        index: index + 1,
        status: leftSlide === undefined ? 'added' : 'removed',
        shapes,
        changedParts: [],
        notes: [leftSlide === undefined ? 'page exists only in the newer version' : 'page exists only in the older version'],
      })
      continue
    }
    const names = [...new Set([...(leftParts ?? []), ...(rightParts ?? [])])].sort()
    const changedParts: string[] = []
    const notes: string[] = []
    for (const name of names) {
      const leftPart = leftPackage.parts.get(name)
      const rightPart = rightPackage.parts.get(name)
      if (leftPart === undefined) {
        changedParts.push(name)
        notes.push(`${name} added`)
        continue
      }
      if (rightPart === undefined) {
        changedParts.push(name)
        notes.push(`${name} removed`)
        continue
      }
      if (fingerprint(leftPart) === fingerprint(rightPart)) continue
      changedParts.push(name)
      if (/^ppt\/charts\//.test(name)) {
        const before = chartValues(xmlOf(leftPart) ?? '')
        const after = chartValues(xmlOf(rightPart) ?? '')
        notes.push(before.join('|') === after.join('|') ? `${name} changed (formatting)` : `${name} changed (data)`)
      }
    }
    if (leftXml !== null && rightXml !== null) {
      const before = shapeCounts(leftXml)
      const after = shapeCounts(rightXml)
      for (const element of SHAPE_ELEMENTS) {
        const delta = (after.kinds[element] ?? 0) - (before.kinds[element] ?? 0)
        if (delta !== 0) notes.push(`${element} ${delta > 0 ? '+' : ''}${String(delta)}`)
      }
    }
    pages.push({
      index: index + 1,
      status: changedParts.length === 0 ? 'same' : 'modified',
      shapes,
      changedParts,
      notes,
    })
  }

  const globalParts = [...new Set([...leftPackage.parts.keys(), ...rightPackage.parts.keys()])]
    .filter((name) => !claimedLeft.has(name) && !claimedRight.has(name) && !/^ppt\/slides\/slide\d+\.xml$/.test(name))
    .filter((name) => {
      const leftPart = leftPackage.parts.get(name)
      const rightPart = rightPackage.parts.get(name)
      if (leftPart === undefined || rightPart === undefined) return true
      return fingerprint(leftPart) !== fingerprint(rightPart)
    })
    .sort()

  const modified = pages.filter((page) => page.status === 'modified').length
  const added = pages.filter((page) => page.status === 'added').length
  const removed = pages.filter((page) => page.status === 'removed').length
  const equal = added === 0 && removed === 0 && modified === 0 && globalParts.length === 0
  const summary = equal
    ? `semantically identical (${String(pageCount)} page(s), ${String(leftPackage.parts.size)} part(s))`
    : `${String(pageCount)} page(s): ${String(added)} added, ${String(removed)} removed, ${String(modified)} modified${globalParts.length === 0 ? '' : `, ${String(globalParts.length)} shared part(s) changed`}`
  return {
    equal,
    left: { pages: leftSlides.length, parts: leftPackage.parts.size },
    right: { pages: rightSlides.length, parts: rightPackage.parts.size },
    pages,
    globalParts,
    summary,
  }
}

/** @param finding - one audit finding. @returns its identity for set comparison. */
function findingKey(finding: FusionFinding): string {
  return `${finding.rule}|${finding.page === undefined ? '-' : String(finding.page)}|${finding.message}`
}

/**
 * @param left - findings recorded for the older version.
 * @param right - findings recorded for the newer version.
 * @returns the added and removed findings, and a one-line summary.
 */
export function diffAudit(left: readonly FusionFinding[], right: readonly FusionFinding[]): AuditDelta {
  const leftKeys = new Map(left.map((finding) => [findingKey(finding), finding]))
  const rightKeys = new Map(right.map((finding) => [findingKey(finding), finding]))
  const added = [...rightKeys.entries()].filter(([key]) => !leftKeys.has(key)).map(([, finding]) => finding)
  const removed = [...leftKeys.entries()].filter(([key]) => !rightKeys.has(key)).map(([, finding]) => finding)
  const unchanged = [...rightKeys.keys()].filter((key) => leftKeys.has(key)).length
  const errors = (findings: readonly FusionFinding[]): number => findings.filter((finding) => finding.level === 'error').length
  const summary =
    added.length === 0 && removed.length === 0
      ? `audit unchanged (${String(unchanged)} finding(s))`
      : `audit: ${String(added.length)} added (${String(errors(added))} error(s)), ${String(removed.length)} removed (${String(errors(removed))} error(s)), ${String(unchanged)} unchanged`
  return { added, removed, unchanged, summary }
}

/**
 * Compare the page images two versions produced.
 *
 * @param left - directory of `page-NNNN.png` files, or null when that side has none.
 * @param right - the other directory.
 * @param options.fs - filesystem port; defaults to the node filesystem.
 * @param options.threshold - per-channel difference below which a sample counts as equal.
 * @returns per-page difference rates plus the pages only one side produced.
 */
export async function diffRender(
  left: string | null,
  right: string | null,
  options: { fs?: { listDir(path: string): string[]; readBytes(path: string): Buffer | null }; threshold?: number } = {},
): Promise<RenderDiff> {
  const { nodeFileSystem } = await import('../engine/venv.ts')
  const fs = options.fs ?? nodeFileSystem
  const threshold = options.threshold ?? RENDER_DIFF_THRESHOLD
  const pagesOf = (dir: string | null): Map<number, string> => {
    const found = new Map<number, string>()
    if (dir === null) return found
    for (const name of fs.listDir(dir)) {
      const match = /^page-(\d+)\.png$/.exec(name)
      if (match === null) continue
      found.set(Number(match[1]), join(dir, name))
    }
    return found
  }
  const leftPages = pagesOf(left)
  const rightPages = pagesOf(right)
  const shared = [...leftPages.keys()].filter((index) => rightPages.has(index)).sort((a, b) => a - b)
  const onlyLeft = [...leftPages.keys()].filter((index) => !rightPages.has(index)).sort((a, b) => a - b)
  const onlyRight = [...rightPages.keys()].filter((index) => !leftPages.has(index)).sort((a, b) => a - b)
  const { default: sharp } = await import('sharp')
  const raster = async (path: string): Promise<{ data: Buffer; width: number; height: number }> => {
    const bytes = fs.readBytes(path)
    if (bytes === null) throw new Error(`page image is not readable: ${path}`)
    const { data, info } = await sharp(bytes)
      .resize({ width: RENDER_DIFF_WIDTH, withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  }
  const pages: RenderPageDelta[] = []
  for (const index of shared) {
    const leftRaster = await raster(leftPages.get(index) ?? '')
    const rightRaster = await raster(rightPages.get(index) ?? '')
    const samples = Math.min(leftRaster.data.length, rightRaster.data.length)
    let different = 0
    for (let offset = 0; offset < samples; offset += 1) {
      if (Math.abs((leftRaster.data[offset] ?? 0) - (rightRaster.data[offset] ?? 0)) > threshold) different += 1
    }
    pages.push({ index, rate: samples === 0 ? 0 : different / samples })
  }
  const meanRate = pages.length === 0 ? 0 : pages.reduce((total, page) => total + page.rate, 0) / pages.length
  const summary =
    pages.length === 0
      ? `render: no pages to compare${onlyLeft.length + onlyRight.length === 0 ? '' : ` (${String(onlyLeft.length)} only older, ${String(onlyRight.length)} only newer)`}`
      : `render: ${String(pages.length)} page(s) compared, mean difference ${(meanRate * 100).toFixed(2)} %, worst page ${String(pages.reduce((worst, page) => (page.rate > worst.rate ? page : worst), pages[0] ?? { index: 0, rate: 0 }).index)} at ${((pages.reduce((worst, page) => Math.max(worst, page.rate), 0)) * 100).toFixed(2)} %${onlyLeft.length + onlyRight.length === 0 ? '' : `, ${String(onlyLeft.length)} only older, ${String(onlyRight.length)} only newer`}`
  return { pages, meanRate, compared: pages.length, onlyLeft, onlyRight, summary }
}