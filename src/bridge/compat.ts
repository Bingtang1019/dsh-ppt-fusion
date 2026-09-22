import { createHash } from 'node:crypto'
import { DshPptFailure } from '../engine/errors.ts'
import { levelAllows, loadCompatRegistry, type CompatLevel, type CompatRegistry } from '../compat/registry.ts'
import { CONTENT_TYPE, REL, freePartName, listSlides, relativeTarget, resolveTarget, type OpcPackage } from './opc.ts'

/**
 * The cross-version compatibility pass (plan §3.14, contracts §8): `scan` finds every
 * registered version-sensitive marker, `transform` applies only the downgrades the
 * registry names, `stamp` completes the fallbacks it can build (the SVG→PNG sibling,
 * B7), and `lint` re-checks the structural rules a marker census cannot see.
 *
 * The pass never invents policy: a marker the registry does not list, or a downgrade
 * this build does not implement, is reported and (for a blocking case) fails the
 * render rather than being silently edited or dropped.
 */

/** Severity of one lint finding. */
export type CompatSeverity = 'error' | 'warning'

/** One lint problem, with the part it was found in. */
export interface CompatFinding {
  readonly rule: string
  readonly level: CompatSeverity
  readonly part: string
  readonly message: string
}

/** Whether a found marker meets the fallback rule the registry states for it. */
export type CompatFallbackState = 'not-required' | 'complete' | 'missing'

/** One marker found by the scan. */
export interface CompatOccurrence {
  readonly feature: string
  readonly part: string
  /** 1-based slide position, or null when the part is not a slide. */
  readonly slide: number | null
  readonly fallback: CompatFallbackState
  readonly detail: string
  /** Locator values the transform and stamp steps need; stable for one pass. */
  readonly ref?: Readonly<Record<string, string>>
}

/** One change the pass applied. */
export interface CompatChange {
  readonly kind: 'downgrade' | 'stamp'
  readonly feature: string
  readonly part: string
  readonly slide: number | null
  readonly detail: string
}

/** The pass' evidence, serialised to `out/compat-report.json`. */
export interface CompatReport {
  readonly schema: 'dsh-ppt-fusion.compat-report.v1'
  readonly level: CompatLevel
  readonly registryVersion: number
  readonly scannedAt: string
  readonly occurrences: readonly CompatOccurrence[]
  readonly applied: readonly CompatChange[]
  readonly findings: readonly CompatFinding[]
  readonly counts: {
    readonly occurrences: number
    readonly downgrades: number
    readonly stamps: number
    readonly errors: number
    readonly warnings: number
  }
}

/** What `compat lint` and the transform steps read from a package. */
export interface CompatInspection {
  readonly level: CompatLevel
  readonly registryVersion: number
  readonly occurrences: readonly CompatOccurrence[]
  readonly findings: readonly CompatFinding[]
}

/** SVG → PNG rasteriser used by the `stamp` step; production passes `sharp`. */
export type SvgRasteriser = (svg: Buffer, context: { readonly part: string }) => Promise<Buffer>

/** A `<mc:AlternateContent>` block, with the ranges the transforms need. */
export interface AlternateContentBlock {
  readonly start: number
  readonly end: number
  readonly requires: readonly string[]
  readonly choices: readonly { readonly start: number; readonly end: number; readonly requires: string | null }[]
  readonly fallback: string | null
}

/** One element range found by `elementRanges`. */
export interface ElementRange {
  readonly start: number
  readonly end: number
  readonly openTag: string
  readonly inner: string
  readonly innerStart: number
}

const MC_TAG_RE = /<(\/?)mc:(AlternateContent|Choice|Fallback)\b([^>]*?)(\/?)>/g

/**
 * Find every `<mc:AlternateContent>` block in one part.
 *
 * The scan is a tag-depth walk rather than a regex over the whole body, because the
 * lint has to see choice ranges and the fallback body (plan §3.14 step 4).
 *
 * @param xml - one XML part.
 * @returns the blocks in document order; unclosed blocks are dropped, which the
 *   structural lint reports separately.
 */
export function findAlternateContents(xml: string): AlternateContentBlock[] {
  interface Frame {
    start: number
    requires: string[]
    choices: { start: number; end: number; requires: string | null }[]
    fallbackStart: number | null
    fallbackEnd: number | null
    fallbackOpen: boolean
  }
  const blocks: AlternateContentBlock[] = []
  const stack: Frame[] = []
  for (const match of xml.matchAll(MC_TAG_RE)) {
    const closing = match[1] === '/'
    const tag = match[2] ?? ''
    const attrs = match[3] ?? ''
    const selfClosing = match[4] === '/'
    const index = match.index ?? 0
    const top = (): Frame | undefined => stack[stack.length - 1]
    if (selfClosing) {
      // A self-closing Choice/Fallback is legal XML and must still be counted: the
      // structural lint reports the empty fallback rather than the block going unseen.
      const frame = top()
      if (frame === undefined) continue
      if (tag === 'Choice') {
        const requires = /Requires="([^"]*)"/.exec(attrs)?.[1] ?? null
        if (requires !== null) frame.requires.push(requires)
        frame.choices.push({ start: index, end: index + match[0].length, requires })
      }
      if (tag === 'Fallback') {
        frame.fallbackStart = index + match[0].length
        frame.fallbackEnd = index + match[0].length
      }
      continue
    }
    if (!closing) {
      if (tag === 'AlternateContent') {
        stack.push({ start: index, requires: [], choices: [], fallbackStart: null, fallbackEnd: null, fallbackOpen: false })
        continue
      }
      const frame = top()
      if (frame === undefined) continue
      if (tag === 'Choice') {
        const requires = /Requires="([^"]*)"/.exec(attrs)?.[1] ?? null
        if (requires !== null) frame.requires.push(requires)
        frame.choices.push({ start: index, end: xml.length, requires })
      }
      if (tag === 'Fallback') {
        frame.fallbackStart = index + match[0].length
        frame.fallbackOpen = true
      }
      continue
    }
    const frame = top()
    if (frame === undefined) continue
    if (tag === 'Choice') {
      const choice = frame.choices[frame.choices.length - 1]
      if (choice !== undefined && choice.end === xml.length) frame.choices[frame.choices.length - 1] = { ...choice, end: index }
      continue
    }
    if (tag === 'Fallback') {
      frame.fallbackEnd = index
      frame.fallbackOpen = false
      continue
    }
    stack.pop()
    const fallback = frame.fallbackStart === null || frame.fallbackEnd === null ? null : xml.slice(frame.fallbackStart, frame.fallbackEnd)
    blocks.push({ start: frame.start, end: index + match[0].length, requires: [...frame.requires], choices: [...frame.choices], fallback })
  }
  return blocks
}

/**
 * Find one element type by a depth walk, so the caller can replace a range without
 * re-parsing the part.
 *
 * @param xml - one XML part.
 * @param tag - qualified tag name, for example `a:blip`.
 * @returns the element ranges in document order; a self-closing element has an empty
 *   `inner` and `innerStart === end`.
 */
export function elementRanges(xml: string, tag: string): ElementRange[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, 'g')
  const ranges: ElementRange[] = []
  let openStart: number | null = null
  let openEnd = 0
  let depth = 0
  for (const match of xml.matchAll(pattern)) {
    const index = match.index ?? 0
    if (match[0].startsWith('</')) {
      if (openStart === null) continue
      depth -= 1
      if (depth === 0) {
        ranges.push({ start: openStart, end: index + match[0].length, openTag: xml.slice(openStart, openEnd), inner: xml.slice(openEnd, index), innerStart: openEnd })
        openStart = null
      }
      continue
    }
    if (match[1] === '/') {
      if (openStart === null) {
        ranges.push({ start: index, end: index + match[0].length, openTag: match[0], inner: '', innerStart: index + match[0].length })
      }
      continue
    }
    if (openStart === null) {
      openStart = index
      openEnd = index + match[0].length
      depth = 1
    } else {
      depth += 1
    }
  }
  return ranges
}

/** One part's XML, in a deterministic order. */
function* xmlParts(pkg: OpcPackage): Generator<{ name: string; xml: string }> {
  for (const name of [...pkg.names()].sort()) {
    if (/\.(xml|rels)$/i.test(name)) yield { name, xml: pkg.text(name) }
  }
}

/** @returns slide part → 1-based position, from `p:sldIdLst`. */
function slidePositions(pkg: OpcPackage): Map<string, number> {
  const positions = new Map<string, number>()
  if (!pkg.has('ppt/presentation.xml')) return positions
  listSlides(pkg).forEach((part, offset) => positions.set(part, offset + 1))
  return positions
}

/** @returns the 1-based slide position of a part, or null when it is not a slide. */
function slideOf(positions: ReadonlyMap<string, number>, part: string): number | null {
  return positions.get(part) ?? null
}

/** The handler for one registry feature: how to find it and what can be applied. */
interface FeatureHandler {
  readonly feature: string
  /** Severity for an unmet fallback when no transform can complete it. */
  readonly missingFallbackSeverity?: CompatSeverity
  scan(pkg: OpcPackage, positions: ReadonlyMap<string, number>): CompatOccurrence[]
  downgrade?(pkg: OpcPackage, occurrence: CompatOccurrence): EditDraft | null
  stamp?(pkg: OpcPackage, occurrence: CompatOccurrence, rasterise: SvgRasteriser): Promise<CompatChange | null>
}

/** A pending splice into one part; `start`/`end` index the part before any edit. */
interface EditDraft {
  readonly start: number
  readonly end: number
  readonly replacement: string
  readonly detail: string
}

/** An edit with the occurrence it came from, as the pass applies it. */
interface PlannedEdit extends EditDraft {
  readonly feature: string
  readonly part: string
  readonly slide: number | null
}

const CHART_2016 = ['treemapChart', 'sunburstChart', 'histogramChart', 'waterfallChart', 'funnelChart']
const CHART_2019 = ['mapChart']
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/
const RASTER_RE = /\.(png|jpe?g|gif|bmp|tiff?)$/i

/** The per-feature scanners. Every registry feature must appear here (test-enforced). */
const HANDLERS: readonly FeatureHandler[] = [
  {
    feature: 'p14:dur',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        for (const match of xml.matchAll(/\sp14:dur="([^"]*)"/g)) {
          found.push({ feature: 'p14:dur', part: name, slide: slideOf(positions, name), fallback: 'not-required', detail: `p14:dur="${match[1] ?? ''}"` })
        }
      }
      return found
    },
  },
  {
    feature: 'morph-transition',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        const blocks = findAlternateContents(xml)
        for (const match of xml.matchAll(/\sp159:morph="([^"]*)"/g)) {
          const index = match.index ?? 0
          const blockIndex = blocks.findIndex((candidate) => index >= candidate.start && index < candidate.end)
          const block = blockIndex < 0 ? undefined : blocks[blockIndex]
          found.push({
            feature: 'morph-transition',
            part: name,
            slide: slideOf(positions, name),
            fallback: block?.fallback != null ? 'complete' : 'missing',
            detail: `p159:morph="${match[1] ?? ''}"${block === undefined ? ' (no MCE wrapper)' : ''}`,
            ref: blockIndex < 0 ? { attribute: String(index) } : { block: String(blockIndex) },
          })
        }
      }
      return found
    },
    downgrade: (pkg, occurrence) => {
      const xml = pkg.text(occurrence.part)
      if (occurrence.ref?.block !== undefined) {
        const block = findAlternateContents(xml)[Number(occurrence.ref.block)]
        if (block !== undefined && block.fallback != null) {
          return { start: block.start, end: block.end, replacement: block.fallback, detail: 'MCE unwrapped to its fade fallback' }
        }
      }
      const attribute = /\sp159:morph="[^"]*"/.exec(xml)
      if (attribute === null) return null
      return { start: attribute.index, end: attribute.index + attribute[0].length, replacement: '', detail: 'p159:morph attribute removed' }
    },
  },
  {
    feature: 'advanced-transition-family',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        const blocks = findAlternateContents(xml)
        for (const range of elementRanges(xml, 'p:transition')) {
          const child = /<p14:([A-Za-z][\w-]*)\b[^>]*?\/?>/.exec(range.inner)
          if (child === null) continue
          const childStart = range.innerStart + (child.index ?? 0)
          const block = blocks.find((candidate) => childStart >= candidate.start && childStart < candidate.end)
          const inChoice = block !== undefined && block.choices.some((choice) => childStart >= choice.start && childStart < choice.end)
          found.push({
            feature: 'advanced-transition-family',
            part: name,
            slide: slideOf(positions, name),
            fallback: inChoice && block?.fallback != null ? 'complete' : 'missing',
            detail: `p14:${child[1] ?? 'unknown'}${inChoice ? ' inside an MCE choice' : ' without an MCE wrapper'}`,
            ref: {
              childStart: String(childStart),
              ...(inChoice && block !== undefined ? { block: String(blocks.indexOf(block)) } : {}),
            },
          })
        }
      }
      return found
    },
    downgrade: (pkg, occurrence) => {
      const xml = pkg.text(occurrence.part)
      if (occurrence.ref?.block !== undefined) {
        const block = findAlternateContents(xml)[Number(occurrence.ref.block)]
        if (block !== undefined && block.fallback != null) {
          return { start: block.start, end: block.end, replacement: block.fallback, detail: 'MCE unwrapped to its registered fade fallback' }
        }
      }
      const childStart = Number(occurrence.ref?.childStart ?? '-1')
      if (childStart < 0) return null
      const child = /<p14:([A-Za-z][\w-]*)\b[^>]*?\/?>/.exec(xml.slice(childStart))
      if (child === null) return null
      return { start: childStart, end: childStart + child[0].length, replacement: '<p:fade/>', detail: `p14:${child[1] ?? 'element'} replaced by p:fade` }
    },
  },
  {
    feature: 'animation-bounce-extension',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        const blocks = findAlternateContents(xml)
        for (const match of xml.matchAll(/\sp14:presetBounceEnd="([^"]*)"/g)) {
          const index = match.index ?? 0
          const block = blocks.find((candidate) => index >= candidate.start && index < candidate.end)
          found.push({
            feature: 'animation-bounce-extension',
            part: name,
            slide: slideOf(positions, name),
            fallback: block?.fallback != null ? 'complete' : 'missing',
            detail: `p14:presetBounceEnd="${match[1] ?? ''}"${block === undefined ? ' (no MCE wrapper)' : ''}`,
          })
        }
      }
      return found
    },
  },
  {
    feature: 'asvg:svgBlip',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        const ranges = elementRanges(xml, 'a:blip')
        ranges.forEach((range, index) => {
          const svg = /<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/.exec(range.inner)
          if (svg === null) return
          const svgRelId = svg[1] ?? ''
          const ownEmbed = /\br:embed="([^"]+)"/.exec(range.openTag)?.[1]
          const relationships = pkg.relationshipsOf(name)
          const svgPart = svgPartOf(name, relationships, svgRelId)
          const pngPart = ownEmbed === undefined ? null : svgPartOf(name, relationships, ownEmbed)
          const sibling = pngPart !== null && pkg.has(pngPart) && RASTER_RE.test(pngPart) ? pngPart : null
          found.push({
            feature: 'asvg:svgBlip',
            part: name,
            slide: slideOf(positions, name),
            fallback: sibling === null ? 'missing' : 'complete',
            detail: sibling === null ? `svg blip ${svgPart ?? svgRelId} has no raster sibling` : `svg blip ${svgPart ?? svgRelId} with raster sibling ${sibling}`,
            ref: { blip: String(index), svgRelId, ...(ownEmbed === undefined ? {} : { pngRelId: ownEmbed }) },
          })
        })
      }
      return found
    },
    stamp: stampSvgSibling,
  },
  {
    feature: 'formula-a14m',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        const blocks = findAlternateContents(xml)
        for (const match of xml.matchAll(/<a14:m\b/g)) {
          const index = match.index ?? 0
          const block = blocks.find((candidate) => index >= candidate.start && index < candidate.end)
          found.push({
            feature: 'formula-a14m',
            part: name,
            slide: slideOf(positions, name),
            fallback: block?.fallback != null ? 'complete' : 'missing',
            detail: block === undefined ? 'a14:m outside mc:AlternateContent' : 'a14:m formula choice',
          })
        }
      }
      return found
    },
  },
  {
    feature: 'chart-2016-tier',
    scan: (pkg, positions) => chartScan(pkg, positions, 'chart-2016-tier', CHART_2016),
  },
  {
    feature: 'chart-2019-tier',
    scan: (pkg, positions) => chartScan(pkg, positions, 'chart-2019-tier', CHART_2019),
  },
  {
    feature: 'audio-mp3',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        for (const match of xml.matchAll(/<p14:media\b[^>]*\br:(?:embed|link)="([^"]+)"/g)) {
          const relId = match[1] ?? ''
          const target = svgPartOf(name, pkg.relationshipsOf(name), relId)
          const extension = (target ?? relId).slice((target ?? relId).lastIndexOf('.') + 1).toLowerCase()
          const allowed = extension === 'mp3' || extension === 'm4a'
          found.push({
            feature: 'audio-mp3',
            part: name,
            slide: slideOf(positions, name),
            fallback: allowed ? 'not-required' : 'missing',
            detail: `media container ${target ?? relId} (${extension || 'unknown'})`,
          })
        }
      }
      return found
    },
    missingFallbackSeverity: 'error',
  },
  {
    feature: 'ea-font-slot',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        let missing = 0
        for (const range of elementRanges(xml, 'a:r')) {
          const text = /<a:t>([\s\S]*?)<\/a:t>/.exec(range.inner)?.[1] ?? ''
          if (!CJK_RE.test(text)) continue
          if (!/<a:ea\b/.test(range.inner)) missing += 1
        }
        if (missing > 0) {
          found.push({
            feature: 'ea-font-slot',
            part: name,
            slide: slideOf(positions, name),
            fallback: 'missing',
            detail: `${String(missing)} CJK run(s) without an a:ea slot`,
          })
        }
      }
      return found
    },
  },
  {
    feature: 'p14-creation-id',
    scan: (pkg, positions) => {
      const found: CompatOccurrence[] = []
      for (const { name, xml } of xmlParts(pkg)) {
        const ids = [...xml.matchAll(/\sp14:creationId="([^"]*)"/g)].map((match) => match[1] ?? '')
        if (ids.length === 0) continue
        const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
        found.push({
          feature: 'p14-creation-id',
          part: name,
          slide: slideOf(positions, name),
          fallback: duplicates.length === 0 ? 'not-required' : 'missing',
          detail: duplicates.length === 0 ? `${String(ids.length)} unique p14:creationId value(s)` : `duplicate p14:creationId ${duplicates.join(', ')}`,
        })
      }
      return found
    },
    missingFallbackSeverity: 'error',
  },
]

/** @returns the part a relationship id points at, or null when it is not a local part. */
function svgPartOf(part: string, relationships: readonly { id: string; target: string; targetMode?: 'External' }[], relId: string): string | null {
  const relationship = relationships.find((candidate) => candidate.id === relId)
  if (relationship === undefined || relationship.targetMode === 'External') return null
  return resolveTarget(part, relationship.target)
}

/** @returns one occurrence per over-level chart element found in a chart part. */
function chartScan(pkg: OpcPackage, positions: ReadonlyMap<string, number>, feature: string, elements: readonly string[]): CompatOccurrence[] {
  const found: CompatOccurrence[] = []
  const pattern = new RegExp(`<c:(${elements.join('|')})\\b`, 'g')
  for (const { name, xml } of xmlParts(pkg)) {
    if (!/^ppt\/charts\/[^/]+\.xml$/.test(name)) continue
    for (const match of xml.matchAll(pattern)) {
      found.push({ feature, part: name, slide: slideOf(positions, name), fallback: 'not-required', detail: `c:${match[1] ?? 'unknown'} chart` })
    }
  }
  return found
}

/** Prefixes whose presence the structural lint treats as version-sensitive. */
const VERSION_SENSITIVE_PREFIXES = ['p14', 'p15', 'p159', 'a14', 'a15', 'asvg', 'adec']

/** @returns the handler registered for a feature, or undefined when none is. */
function handlerFor(feature: string): FeatureHandler | undefined {
  return HANDLERS.find((candidate) => candidate.feature === feature)
}

/** @returns the handlers in registry order, skipping features with no scanner. */
function scanPackage(pkg: OpcPackage, registry: CompatRegistry): CompatOccurrence[] {
  const positions = slidePositions(pkg)
  const found: CompatOccurrence[] = []
  for (const feature of registry.features) {
    const handler = handlerFor(feature.feature)
    if (handler === undefined) continue
    found.push(...handler.scan(pkg, positions))
  }
  return found
}

/** Sort occurrences so two runs of the same input produce the same report. */
function sortOccurrences(occurrences: readonly CompatOccurrence[]): CompatOccurrence[] {
  return [...occurrences].sort((left, right) => {
    const key = (entry: CompatOccurrence): string => `${entry.part}\u0000${String(entry.slide ?? 0)}\u0000${entry.feature}\u0000${entry.detail}`
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0
  })
}

/** Sort findings so two runs of the same input produce the same report. */
function sortFindings(findings: readonly CompatFinding[]): CompatFinding[] {
  return [...findings].sort((left, right) => {
    const key = (entry: CompatFinding): string => `${entry.part}\u0000${entry.rule}\u0000${entry.message}`
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0
  })
}

/**
 * The structural rules the marker census cannot express (plan §3.14 step 4): MCE
 * choice/fallback pairing, namespace declarations, and reverse registry lookup.
 *
 * @param pkg - the package.
 * @param registry - loaded registry.
 * @returns one finding per problem.
 */
function lintPackage(pkg: OpcPackage, registry: CompatRegistry): CompatFinding[] {
  const findings: CompatFinding[] = []
  const registeredNamespaces = new Set(registry.features.map((feature) => feature.namespace))
  for (const feature of registry.features) {
    if (handlerFor(feature.feature) === undefined) {
      findings.push({ rule: 'feature-unscanned', level: 'error', part: '(registry)', message: `${feature.feature} is registered but no scanner exists for it` })
    }
  }
  if (!pkg.has('ppt/presentation.xml')) {
    findings.push({ rule: 'package-presentation-missing', level: 'error', part: 'ppt/presentation.xml', message: 'the package has no presentation part, so it is not a deck' })
  }
  for (const { name, xml } of xmlParts(pkg)) {
    const blocks = findAlternateContents(xml)
    const declaredBlocks = [...xml.matchAll(/<mc:AlternateContent\b/g)].length
    if (blocks.length !== declaredBlocks) {
      findings.push({ rule: 'mce-unclosed', level: 'error', part: name, message: `${String(declaredBlocks)} mc:AlternateContent element(s) but ${String(blocks.length)} closed block(s)` })
    }
    const declaredChoices = [...xml.matchAll(/<mc:Choice\b/g)].length
    const parsedChoices = blocks.reduce((total, block) => total + block.choices.length, 0)
    if (declaredChoices !== parsedChoices) {
      findings.push({ rule: 'mce-choice-orphan', level: 'error', part: name, message: `${String(declaredChoices)} mc:Choice element(s) but ${String(parsedChoices)} inside an mc:AlternateContent` })
    }
    for (const block of blocks) {
      if (block.choices.length === 0) {
        findings.push({ rule: 'mce-choice-missing', level: 'error', part: name, message: 'mc:AlternateContent has no mc:Choice' })
      }
      if (block.fallback === null) {
        findings.push({ rule: 'mce-fallback-missing', level: 'error', part: name, message: 'mc:AlternateContent has no mc:Fallback' })
      } else if (block.fallback.trim() === '') {
        findings.push({ rule: 'mce-fallback-empty', level: 'error', part: name, message: 'mc:Fallback is empty, so an old reader would show nothing' })
      }
      for (const choice of block.choices) {
        if (choice.requires === null) {
          findings.push({ rule: 'mce-requires-missing', level: 'error', part: name, message: 'mc:Choice has no Requires attribute' })
          continue
        }
        if (!xml.includes(`xmlns:${choice.requires}=`)) {
          findings.push({ rule: 'namespace-undeclared', level: 'error', part: name, message: `mc:Choice Requires="${choice.requires}" but the part never declares xmlns:${choice.requires}` })
        }
        if (!registeredNamespaces.has(choice.requires)) {
          findings.push({ rule: 'namespace-unregistered', level: 'error', part: name, message: `mc:Choice Requires="${choice.requires}" but no registry feature uses that namespace` })
        }
      }
    }
    for (const prefix of VERSION_SENSITIVE_PREFIXES) {
      if (!new RegExp(`[<\\s]${prefix}:[A-Za-z]`).test(xml)) continue
      if (!xml.includes(`xmlns:${prefix}=`)) {
        findings.push({ rule: 'namespace-undeclared', level: 'error', part: name, message: `${prefix}: is used without an xmlns:${prefix} declaration` })
      }
      if (!registeredNamespaces.has(prefix)) {
        findings.push({ rule: 'namespace-unregistered', level: 'error', part: name, message: `${prefix}: is a version-sensitive namespace with no registry feature; add an entry or remove the marker` })
      }
    }
  }
  return findings
}

/**
 * Decide what the level means for each occurrence: a blocked feature needs its
 * registered downgrade, an unmet fallback needs its stamp, and anything the registry
 * names but this build cannot build is reported as an error instead of guessed at.
 *
 * @param registry - loaded registry.
 * @param level - target level.
 * @param occurrences - scanned markers.
 * @returns one finding per marker that cannot be satisfied.
 */
function decisionFindings(registry: CompatRegistry, level: CompatLevel, occurrences: readonly CompatOccurrence[]): CompatFinding[] {
  const findings: CompatFinding[] = []
  for (const occurrence of occurrences) {
    const feature = registry.features.find((candidate) => candidate.feature === occurrence.feature)
    if (feature === undefined) continue
    const handler = handlerFor(feature.feature)
    const blocked = !levelAllows(registry, level, feature)
    const unmet = feature.mceFallbackRequired && occurrence.fallback === 'missing'
    if (blocked || unmet) {
      if (handler?.downgrade !== undefined || handler?.stamp !== undefined) continue
      const requirement = blocked
        ? `${feature.feature} needs Office ${String(feature.minOffice)}+${registry.levels[level].forbids.includes(feature.feature) ? `, which level ${level} forbids` : `, above level ${level}'s Office ${String(registry.levels[level].minOffice)}+`}`
        : `${feature.feature} requires a complete fallback and this part has none`
      const remedy = feature.downgradeTo === null ? 'the registry registers no downgrade' : `the registered downgrade to ${feature.downgradeTo} is not implemented for this marker`
      findings.push({ rule: 'compat-feature', level: 'error', part: occurrence.part, message: `${requirement}; ${remedy} (${occurrence.detail})` })
      continue
    }
    if (occurrence.fallback === 'missing') {
      const remedy = feature.downgradeTo === null ? 'the registry registers no downgrade' : `the registered downgrade to ${feature.downgradeTo} is not implemented for this marker`
      findings.push({ rule: 'compat-feature', level: handler?.missingFallbackSeverity ?? 'warning', part: occurrence.part, message: `${feature.feature}: ${occurrence.detail}; ${remedy}` })
    }
  }
  return findings
}

/** Options for `inspectCompat`. */
export interface CompatInspectOptions {
  readonly level: CompatLevel
  readonly registry?: CompatRegistry
}

/**
 * Scan and lint one package without changing it. `compat lint` uses this; the render
 * chain runs it again after its transforms so the report describes the shipped bytes.
 *
 * @param pkg - the package.
 * @param options - target level and optional pre-loaded registry.
 * @returns the level, registry version, occurrences and findings.
 */
export function inspectCompat(pkg: OpcPackage, options: CompatInspectOptions): CompatInspection {
  const registry = options.registry ?? loadCompatRegistry()
  const occurrences = sortOccurrences(scanPackage(pkg, registry))
  const findings = sortFindings([...lintPackage(pkg, registry), ...decisionFindings(registry, options.level, occurrences)])
  return { level: options.level, registryVersion: registry.version, occurrences, findings }
}

/** Options for `applyCompatPass`. */
export interface CompatPassOptions extends CompatInspectOptions {
  /** Rasteriser for the SVG sibling stamp; production uses `sharp` (B7). */
  readonly rasterise?: SvgRasteriser
  /** Clock seam so the report timestamp is testable. */
  readonly now?: () => Date
}

/** @returns the SVG rasteriser the stamp step uses by default. */
export async function rasteriseWithSharp(svg: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  return sharp(svg).png().toBuffer()
}

/** Apply the planned splices, outermost edits first, from the end of each part. */
function applyEdits(pkg: OpcPackage, drafts: readonly PlannedEdit[]): PlannedEdit[] {
  const byPart = new Map<string, PlannedEdit[]>()
  for (const draft of drafts) {
    const list = byPart.get(draft.part)
    if (list === undefined) byPart.set(draft.part, [draft])
    else list.push(draft)
  }
  const applied: PlannedEdit[] = []
  for (const [part, list] of [...byPart.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const kept = list.filter((draft) => !list.some((other) => other !== draft && other.start <= draft.start && other.end >= draft.end && (other.start !== draft.start || other.end !== draft.end)))
    let xml = pkg.text(part)
    for (const draft of [...kept].sort((left, right) => right.start - left.start)) {
      if (draft.start < 0 || draft.end > xml.length || draft.start > draft.end) continue
      xml = xml.slice(0, draft.start) + draft.replacement + xml.slice(draft.end)
      applied.push(draft)
    }
    pkg.setPart(part, xml)
  }
  return applied
}

/** @returns a relationship id that the part does not already use. */
function nextRelationshipId(relationships: readonly { id: string }[]): string {
  const ids = new Set(relationships.map((relationship) => relationship.id))
  let index = 1
  while (ids.has(`rId${String(index)}`)) index += 1
  return `rId${String(index)}`
}

/**
 * The B7 stamp: rasterise the SVG an `asvg:svgBlip` points at, add the PNG part and
 * relationship, and point the `a:blip` at the PNG so Office 2013+ has a fallback while
 * 2016+ still sees the SVG extension.
 *
 * @param pkg - the package to mutate.
 * @param occurrence - the scanned `asvg:svgBlip` occurrence.
 * @param rasterise - SVG → PNG implementation (sharp in production).
 * @returns the applied change, or null when the located blip is gone.
 * @throws DshPptFailure `ContractViolation` when the referenced SVG part is absent.
 */
async function stampSvgSibling(pkg: OpcPackage, occurrence: CompatOccurrence, rasterise: SvgRasteriser): Promise<CompatChange | null> {
  const part = occurrence.part
  const xml = pkg.text(part)
  const index = Number(occurrence.ref?.blip ?? '-1')
  const range = elementRanges(xml, 'a:blip')[index]
  if (range === undefined) return null
  const relationships = pkg.relationshipsOf(part)
  const svgRelId = occurrence.ref?.svgRelId ?? /<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/.exec(range.inner)?.[1] ?? ''
  const svgPart = svgPartOf(part, relationships, svgRelId)
  if (svgPart === null || !pkg.has(svgPart)) {
    throw new DshPptFailure('ContractViolation', `${part} references ${svgRelId}, whose SVG part is absent, so the PNG sibling cannot be stamped`, {
      detail: { part, svgRelId, svgPart },
    })
  }
  const png = await rasterise(pkg.part(svgPart), { part: svgPart })
  const desired = /\.svg$/i.test(svgPart) ? svgPart.replace(/\.svg$/i, '.png') : `${svgPart}.png`
  const pngPart = freePartName(pkg, new Set(), desired)
  pkg.setPart(pngPart, png)
  pkg.ensureContentType(pngPart, CONTENT_TYPE.png)
  const relationship = { id: nextRelationshipId(relationships), type: REL.image, target: relativeTarget(part, pngPart) }
  pkg.setRelationships(part, [...relationships, relationship])
  const patchedOpen = /\br:embed="/.test(range.openTag)
    ? range.openTag.replace(/\br:embed="[^"]*"/, `r:embed="${relationship.id}"`)
    : range.openTag.replace('<a:blip', `<a:blip r:embed="${relationship.id}"`)
  pkg.setPart(part, xml.slice(0, range.start) + patchedOpen + xml.slice(range.start + range.openTag.length))
  return {
    kind: 'stamp',
    feature: 'asvg:svgBlip',
    part,
    slide: occurrence.slide,
    detail: `rasterised ${svgPart} to ${pngPart} (${String(png.length)} bytes) as ${relationship.id}`,
  }
}

/**
 * Run the whole pass: scan, apply only the registry's downgrades, stamp the fallbacks
 * it can build, then scan and lint again so the report describes the result.
 *
 * @param pkg - the package to mutate.
 * @param options - level, optional registry, rasteriser seam and clock seam.
 * @returns the report, including the final occurrences and findings.
 */
export async function applyCompatPass(pkg: OpcPackage, options: CompatPassOptions): Promise<CompatReport> {
  const registry = options.registry ?? loadCompatRegistry()
  const rasterise = options.rasterise ?? rasteriseWithSharp
  const initial = sortOccurrences(scanPackage(pkg, registry))
  const drafts: PlannedEdit[] = []
  const stamps: CompatOccurrence[] = []
  for (const occurrence of initial) {
    const feature = registry.features.find((candidate) => candidate.feature === occurrence.feature)
    if (feature === undefined) continue
    const handler = handlerFor(feature.feature)
    if (handler === undefined) continue
    const blocked = !levelAllows(registry, options.level, feature)
    const unmet = feature.mceFallbackRequired && occurrence.fallback === 'missing'
    if (!blocked && !unmet) continue
    if (handler.downgrade !== undefined) {
      const draft = handler.downgrade(pkg, occurrence)
      if (draft !== null) drafts.push({ ...draft, feature: feature.feature, part: occurrence.part, slide: occurrence.slide })
      continue
    }
    if (handler.stamp !== undefined) stamps.push(occurrence)
  }
  const appliedEdits = applyEdits(pkg, drafts)
  const applied: CompatChange[] = appliedEdits.map((draft) => ({ kind: 'downgrade', feature: draft.feature, part: draft.part, slide: draft.slide, detail: draft.detail }))
  for (const occurrence of stamps) {
    const handler = handlerFor(occurrence.feature)
    if (handler?.stamp === undefined) continue
    const change = await handler.stamp(pkg, occurrence, rasterise)
    if (change !== null) applied.push(change)
  }
  const final = inspectCompat(pkg, { level: options.level, registry })
  const errors = final.findings.filter((finding) => finding.level === 'error').length
  const warnings = final.findings.length - errors
  return {
    schema: 'dsh-ppt-fusion.compat-report.v1',
    level: options.level,
    registryVersion: registry.version,
    scannedAt: (options.now?.() ?? new Date()).toISOString(),
    occurrences: final.occurrences,
    applied: [...applied].sort((left, right) => (left.part === right.part ? (left.feature < right.feature ? -1 : 1) : left.part < right.part ? -1 : 1)),
    findings: final.findings,
    counts: {
      occurrences: final.occurrences.length,
      downgrades: applied.filter((change) => change.kind === 'downgrade').length,
      stamps: applied.filter((change) => change.kind === 'stamp').length,
      errors,
      warnings,
    },
  }
}

/**
 * @param report - a pass report.
 * @returns the one-line summary plus one line per applied change and finding.
 */
export function formatCompatReport(report: CompatReport): string {
  const lines = [
    `compat ${report.level}: registry v${String(report.registryVersion)}, ${String(report.counts.occurrences)} occurrence(s), ${String(report.counts.downgrades)} downgrade(s), ${String(report.counts.stamps)} stamp(s), ${String(report.counts.errors)} error(s), ${String(report.counts.warnings)} warning(s)`,
  ]
  for (const change of report.applied) lines.push(`  ${change.kind} ${change.feature} ${change.part}: ${change.detail}`)
  for (const finding of report.findings) lines.push(`  ${finding.level} ${finding.rule} ${finding.part}: ${finding.message}`)
  return lines.join('\n')
}

/**
 * @param report - a pass report.
 * @returns the JSON document written to `out/compat-report.json`.
 */
export function serializeCompatReport(report: CompatReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * @param report - a pass report.
 * @returns the SHA-256 of the serialised report, the value `out/manifest.json` records.
 */
export function compatReportHash(report: CompatReport): string {
  return createHash('sha256').update(serializeCompatReport(report)).digest('hex')
}
