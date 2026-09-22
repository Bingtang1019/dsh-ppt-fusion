import { createHash } from 'node:crypto'
import { DshPptFailure } from '../engine/errors.ts'
import { REL, freePartName, partBase, partDir, relativeTarget, resolveTarget, serializeRels, type OpcPackage, type Relationship } from './opc.ts'

/** One page of the route table: which base slide takes which deep slide. */
export interface SlideRoute {
  /** 1-based position in the final deck. */
  readonly index: number
  /** 1-based slide number inside the deep deck that supplies this page. */
  readonly deepSlide: number
}

/** What the merge did, for the report and the audit. */
export interface MergeReport {
  /** Pages replaced, in deck order. */
  readonly replaced: readonly { index: number; basePart: string; deepPart: string }[]
  /** Imported parts: source name in the deep deck to name in the merged package. */
  readonly imported: Readonly<Record<string, string>>
  /** Parts whose bytes matched an existing base part and were reused. */
  readonly reused: Readonly<Record<string, string>>
  /** Layout remaps: deep slide to the base layout it was pointed at. */
  readonly layoutRemap: Readonly<Record<string, string>>
  /** True when the multi-master escape hatch imported a layout/master/theme closure. */
  readonly multiMaster: boolean
  /** Deep parts deliberately not imported. */
  readonly dropped: readonly string[]
  /** `p14:creationId` values renumbered to keep each slide duplicate-free. */
  readonly renumberedCreationIds: number
}

/** Options for `mergeDeep`. */
export interface MergeOptions {
  /**
   * Import the deep deck's layout, master and theme instead of remapping onto the
   * base layout. Off by default: P1 requires one master, and deep pages are
   * absolutely positioned so the base layout is enough (plan §3.5).
   */
  readonly allowMultiMaster?: boolean
}

const CLOSURE_SKIP = ['ppt/slideLayouts/', 'ppt/slideMasters/', 'ppt/theme/'] as const

/**
 * Merge deep pages into a base deck.
 *
 * The deck's slide order, its slide ids and its single master are preserved: deep
 * slides replace base slides in place, their non-layout closure (charts, embedded
 * workbooks, media, notes) is imported with collision-safe names, and their layout
 * relationship is repointed at the base layout the replaced slide used.
 *
 * @param options.base - the pptwise deck, as parsed.
 * @param options.deep - the deep deck, as parsed.
 * @param options.routes - which deep slide goes to which deck position.
 * @param options.merge - whether to take the multi-master escape hatch.
 * @returns the merged package and what the merge did.
 * @throws DshPptFailure `ContractViolation` when a route names a slide that does not exist.
 */
export async function mergeDeep(options: {
  base: OpcPackage
  deep: OpcPackage
  routes: readonly SlideRoute[]
  merge?: MergeOptions
}): Promise<{ merged: OpcPackage; report: MergeReport }> {
  const { base, deep, routes } = options
  const multiMaster = options.merge?.allowMultiMaster === true
  const merged = base.clone()
  const imported: Record<string, string> = {}
  const reused: Record<string, string> = {}
  const layoutRemap: Record<string, string> = {}
  const replaced: { index: number; basePart: string; deepPart: string }[] = []
  const dropped: string[] = []
  const taken = new Set<string>()

  if (routes.length === 0) {
    throw new DshPptFailure('ContractViolation', 'the route table is empty; nothing would be merged')
  }

  const baseSlides = orderedSlides(base, 'base')
  const deepSlides = orderedSlides(deep, 'deep')

  // Index the base package by content so identical media and chart payloads are
  // reused instead of duplicated under a new name.
  const baseByHash = new Map<string, string>()
  for (const name of base.names()) {
    baseByHash.set(`${partDir(name)}|${hash(base.part(name))}`, name)
  }

  const importClosure = (rootPart: string): Map<string, string> => {
    const mapping = new Map<string, string>()
    const visited = new Set<string>()
    // The root slide is replaced, never imported: both decks name slides
    // `slideN.xml`, so a name-based "already in base" test on the root would stop
    // the walk before it reached the page's charts and media. It still gets a
    // placeholder entry so a back-reference (a notes slide points at its slide)
    // does not walk the root again and import a second copy of it.
    const visit = (sourcePart: string, isRoot: boolean, referrer: string | null = null): void => {
      if (visited.has(sourcePart)) return
      visited.add(sourcePart)
      if (isRoot) {
        mapping.set(sourcePart, sourcePart)
      } else {
        // A notes master carries its own theme; dropping that theme would leave the
        // imported notes master with a dangling relationship (PowerPoint decks with
        // notes routinely ship a second theme for exactly this reason).
        const fromNotesMaster = referrer !== null && referrer.startsWith('ppt/notesMasters/')
        if (!multiMaster && !fromNotesMaster && CLOSURE_SKIP.some((prefix) => sourcePart.startsWith(prefix))) {
          dropped.push(sourcePart)
          return
        }
        const bytes = deep.part(sourcePart)
        // A shared name only means reuse when the bytes are identical. Two decks
        // routinely name unrelated parts alike (`slide1.xml`, `chart1.xml`), so a
        // name match with different content has to be renamed, never overwritten.
        const samePart = base.has(sourcePart) && base.part(sourcePart).equals(bytes)
        const reusable = samePart ? sourcePart : baseByHash.get(`${partDir(sourcePart)}|${hash(bytes)}`)
        if (reusable !== undefined) {
          mapping.set(sourcePart, reusable)
          reused[sourcePart] = reusable
        } else {
          const target = freePartName(merged, taken, sourcePart)
          taken.add(target)
          mapping.set(sourcePart, target)
          imported[sourcePart] = target
          merged.setPart(target, bytes)
        }
      }
      if (!deep.hasRelationships(sourcePart)) return
      for (const rel of deep.relationshipsOf(sourcePart)) {
        if (rel.targetMode === 'External') continue
        visit(resolveTarget(sourcePart, rel.target), false, sourcePart)
      }
    }
    visit(rootPart, true)
    return mapping
  }

  const rewriteRels = (sourcePart: string, targetPart: string, mapping: ReadonlyMap<string, string>): Relationship[] =>
    deep.relationshipsOf(sourcePart).map((rel) => {
      if (rel.targetMode === 'External') return rel
      const sourceTarget = resolveTarget(sourcePart, rel.target)
      const targetTarget = mapping.get(sourceTarget) ?? sourceTarget
      return { id: rel.id, type: rel.type, target: relativeTarget(targetPart, targetTarget) }
    })

  for (const route of routes) {
    const basePart = baseSlides[route.index - 1]
    const deepPart = deepSlides[route.deepSlide - 1]
    if (basePart === undefined) {
      throw new DshPptFailure('ContractViolation', `route index ${String(route.index)} has no slide in the base deck (it has ${String(baseSlides.length)})`, {
        detail: { route },
      })
    }
    if (deepPart === undefined) {
      throw new DshPptFailure('ContractViolation', `route deepSlide ${String(route.deepSlide)} has no slide in the deep deck (it has ${String(deepSlides.length)})`, {
        detail: { route },
      })
    }

    const mapping = importClosure(deepPart)
    // The replaced slide answers to the base part name from now on, so every
    // relationship that points back at the deep slide is rewritten onto it.
    mapping.set(deepPart, basePart)
    const baseLayout = base
      .relationshipsOf(basePart)
      .find((rel) => rel.type === REL.slideLayout)
    const deepLayout = deep.relationshipsOf(deepPart).find((rel) => rel.type === REL.slideLayout)
    if (deepLayout === undefined) {
      throw new DshPptFailure('ContractViolation', `${deepPart} has no slideLayout relationship`, { detail: { deepPart } })
    }

    const rewritten = rewriteRels(deepPart, basePart, mapping)
    const kept = rewritten.filter((rel) => rel.type !== REL.slideLayout)
    if (multiMaster) {
      // The escape hatch keeps the deep page on its own layout and master; the
      // closure walk already imported both.
      const ownLayout = rewritten.find((rel) => rel.type === REL.slideLayout)
      if (ownLayout !== undefined) {
        kept.push(ownLayout)
        layoutRemap[deepPart] = resolveTarget(basePart, ownLayout.target)
      }
    } else {
      if (baseLayout === undefined) {
        throw new DshPptFailure('ContractViolation', `${basePart} has no slideLayout relationship to remap onto`, { detail: { basePart } })
      }
      kept.push(baseLayout)
      layoutRemap[deepPart] = resolveTarget(basePart, baseLayout.target)
    }

    merged.setPart(basePart, deep.part(deepPart))
    merged.setRelationships(basePart, kept)

    // Imported parts bring their own relationships: the chart points at its
    // embedded workbook, a notes slide at its master, media at nothing. Rewrite
    // them onto the names this package uses, whatever the mode.
    for (const [sourcePart, mappedPart] of mapping) {
      // The replaced slide's relationships were authored above; only its dependencies
      // are rewritten here.
      if (sourcePart === deepPart) continue
      if (base.has(sourcePart) && sourcePart === mappedPart) continue
      if (!deep.hasRelationships(sourcePart)) continue
      merged.setRelationships(mappedPart, rewriteRels(sourcePart, mappedPart, mapping))
    }

    replaced.push({ index: route.index, basePart, deepPart })
  }

  const renumberedCreationIds = renumberDuplicateCreationIds(merged)

  if (multiMaster) {
    // In the escape hatch a layout/master/theme closure is imported on purpose,
    // so nothing about it counts as dropped.
    registerImportedMasters(merged, imported)
  }

  for (const [sourcePart, targetPart] of Object.entries(imported)) {
    // Prefer the source package's own declaration: narration brings media types
    // (`audio/mpeg`) this bridge has no reason to hardcode.
    merged.ensureContentType(targetPart, deep.contentTypeOf(sourcePart) ?? contentTypeFor(targetPart))
  }

  return {
    merged,
    report: { replaced, imported, reused, layoutRemap, multiMaster, dropped: [...new Set(dropped)], renumberedCreationIds },
  }
}

/**
 * Renumber duplicate `p14:creationId` values inside every slide of a merged package.
 *
 * Upstream `template_validation.py` rejects duplicates (plan §1.5), and a deep deck
 * that numbers its animation nodes from 1 will collide with a base deck that does the
 * same once its pages are replaced. The first occurrence keeps its id; later ones move
 * above the slide's highest id, in document order, so the renumbering is deterministic.
 *
 * @param pkg - the merged package, mutated in place.
 * @returns how many values were renumbered.
 */
export function renumberDuplicateCreationIds(pkg: OpcPackage): number {
  let renumbered = 0
  for (const name of pkg.names()) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue
    const xml = pkg.text(name)
    const ids = [...xml.matchAll(/\sp14:creationId="(\d+)"/g)].map((match) => Number(match[1] ?? '0'))
    if (ids.length === 0) continue
    const seen = new Set<number>()
    let next = Math.max(...ids)
    let changed = false
    const patched = xml.replace(/(\sp14:creationId=")(\d+)(")/g, (_match: string, prefix: string, digits: string, suffix: string) => {
      const id = Number(digits)
      if (!seen.has(id)) {
        seen.add(id)
        return `${prefix}${String(id)}${suffix}`
      }
      next += 1
      renumbered += 1
      changed = true
      return `${prefix}${String(next)}${suffix}`
    })
    if (changed) pkg.setPart(name, patched)
  }
  return renumbered
}

/** @returns the slide parts in presentation order, or the file order when the index is broken. */
function orderedSlides(pkg: OpcPackage, label: string): string[] {
  const ordered = listSlidesSafe(pkg)
  if (ordered.length === 0) {
    throw new DshPptFailure('ContractViolation', `the ${label} deck exposes no slides`)
  }
  return ordered
}

/** `listSlides` without the import cycle, kept local for clarity. */
function listSlidesSafe(pkg: OpcPackage): string[] {
  const presentation = pkg.text('ppt/presentation.xml')
  const rels = new Map(pkg.relationshipsOf('ppt/presentation.xml').map((rel) => [rel.id, resolveTarget('ppt/presentation.xml', rel.target)]))
  const ordered: string[] = []
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(match[1] ?? '')
    if (target !== undefined && pkg.has(target)) ordered.push(target)
  }
  return ordered
}

/** @returns the SHA-256 of a buffer, used for content-based part reuse. */
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @returns the content type a freshly imported part needs, or undefined when its extension is enough. */
function contentTypeFor(part: string): string | undefined {
  const base = partBase(part).toLowerCase()
  if (part.startsWith('ppt/charts/') && base.endsWith('.xml')) return 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
  if (part.startsWith('ppt/embeddings/') && base.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (part.startsWith('ppt/notesSlides/') && base.endsWith('.xml')) return 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'
  if (base.endsWith('.png')) return 'image/png'
  if (base.endsWith('.jpg') || base.endsWith('.jpeg')) return 'image/jpeg'
  if (base.endsWith('.gif')) return 'image/gif'
  if (base.endsWith('.svg')) return 'image/svg+xml'
  return undefined
}


/**
 * Register imported slide masters in `ppt/_rels/presentation.xml.rels` and
 * `p:sldMasterIdLst`.
 *
 * Only reached through `--allow-multi-master`; the default path never imports a
 * master, which is what keeps P1 true.
 *
 * @param merged - the package being built.
 * @param imported - source-to-target part names collected so far.
 */
export function registerImportedMasters(merged: OpcPackage, imported: Record<string, string>): void {
  const masters = Object.values(imported).filter((name) => name.startsWith('ppt/slideMasters/'))
  if (masters.length === 0) return

  const presentationPart = 'ppt/presentation.xml'
  const rels = [...merged.relationshipsOf(presentationPart)]
  const usedIds = new Set(rels.map((rel) => rel.id))
  let nextRelIndex = 1
  const nextRelId = (): string => {
    while (usedIds.has(`rId${String(nextRelIndex)}`)) nextRelIndex += 1
    const id = `rId${String(nextRelIndex)}`
    usedIds.add(id)
    return id
  }

  let presentation = merged.text(presentationPart)
  let nextMasterId = Math.max(2147483648, ...(presentation.match(/<p:sldMasterId\b[^>]*\bid="(\d+)"/g) ?? []).map((entry) => Number.parseInt(/\bid="(\d+)"/.exec(entry)?.[1] ?? '0', 10) + 1))

  for (const master of masters) {
    const relId = nextRelId()
    rels.push({ id: relId, type: REL.slideMaster, target: relativeTarget(presentationPart, master) })
    const row = `<p:sldMasterId id="${String(nextMasterId)}" r:id="${relId}"/>`
    nextMasterId += 1
    presentation = presentation.includes('<p:sldMasterIdLst>')
      ? presentation.replace('</p:sldMasterIdLst>', `${row}</p:sldMasterIdLst>`)
      : presentation.replace('<p:presentation ', `<p:presentation `).replace(/(<p:presentation\b[^>]*>)/, `$1<p:sldMasterIdLst>${row}</p:sldMasterIdLst>`)
  }
  merged.setPart(presentationPart, presentation)
  merged.setRelationships(presentationPart, rels)
}

/**
 * Serialize relationships for a part, exported for tests that compare documents
 * byte for byte.
 *
 * @param rels - relationships to serialize.
 * @returns the `.rels` document text.
 */
export function relsDocument(rels: readonly Relationship[]): string {
  return serializeRels(rels)
}
