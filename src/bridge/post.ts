import { posix } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import {
  PostConfigSchema,
  type EmphasisEffect,
  type EntranceEffect,
  type PathEffect,
  type PostConfig,
  type TransitionEffect,
} from '../schema/post.ts'
import { listSlides, type OpcPackage } from './opc.ts'
import { mp3DurationMs } from './audio.ts'
import type { FileSystemPort } from '../engine/venv.ts'

/**
 * Recorded narration adds a lead-in and a tail to the measured audio before the
 * slide advances: the exporter's `narration_lead_in + duration + narration_padding`
 * with its 0.4 s start floor and 0.5 s padding (ADR-060). Post recomputes the
 * advance from the embedded bytes with the same policy, so the delivered deck
 * carries no host `ffprobe` number.
 */
export const NARRATION_LEAD_IN_MS = 400
export const NARRATION_PADDING_MS = 500

/**
 * Transition XML, ported from pptwise's byte-verified writer (its
 * `pptx-animations.ts`, MIT): `p14:dur` carries the duration and the effect is a
 * child element. PowerPoint's own default is 400 ms, which is what both engines
 * use.
 *
 * @param effect - transition effect; `none` is handled by the caller as a strip.
 * @param durationMs - duration in milliseconds.
 * @param autoAdvanceMs - timed advance in milliseconds; omitted for a click-only transition.
 * @returns the `p:transition` fragment.
 */
export function transitionXml(effect: Exclude<TransitionEffect, 'none'>, durationMs = 400, autoAdvanceMs?: number): string {
  const element = effect === 'fade' ? '<p:fade/>' : effect === 'push' ? '<p:push dir="r"/>' : '<p:wipe dir="r"/>'
  const advance = autoAdvanceMs === undefined ? '' : ` advClick="0" advTm="${String(autoAdvanceMs)}"`
  return `<p:transition p14:dur="${String(durationMs)}"${advance} xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${element}</p:transition>`
}

/**
 * Emphasis presets, ported from ppt-master's MIT preset catalog (`row_xml` for
 * `emphasis_spin` and `emphasis_grow_shrink`). The outer `p:cTn` carries the preset id;
 * the behaviour inside is per shape.
 */
const EMPHASIS_PRESET: Record<EmphasisEffect, { presetID: number; behavior: (spid: number, durationMs: number, nextId: () => number) => string }> = {
  spin: {
    presetID: 8,
    behavior: (spid, durationMs, nextId) =>
      `<p:animRot by="21600000"><p:cBhvr><p:cTn id="${String(nextId())}" dur="${String(durationMs)}" fill="hold"/>` +
      `<p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>`,
  },
  'grow-shrink': {
    presetID: 6,
    behavior: (spid, durationMs, nextId) =>
      `<p:animScale><p:cBhvr><p:cTn id="${String(nextId())}" dur="${String(durationMs)}" fill="hold"/>` +
      `<p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl></p:cBhvr><p:by x="150000" y="150000"/></p:animScale>`,
  },
}

/** Motion paths, ported from the same catalog (`path_right`, `path_down`). */
const PATH_PRESET: Record<PathEffect, { presetID: number; path: string }> = {
  right: { presetID: 63, path: 'M 0 0 L 0.25 0 E' },
  down: { presetID: 42, path: 'M 0 0 L 0 0.25 E' },
}

/** animEffect filter and preset ids per entrance effect, from pptwise's mapping. */
const ENTRANCE_PRESET: Record<EntranceEffect, { filter: string; presetID: number; presetSubtype: number }> = {
  fade: { filter: 'fade', presetID: 10, presetSubtype: 0 },
  wipe: { filter: 'wipe(down)', presetID: 12, presetSubtype: 4 },
  fly: { filter: 'slide(fromLeft)', presetID: 42, presetSubtype: 8 },
}

/** Removes any transition block, so re-applying is idempotent. */
const TRANSITION_RE = /<p:transition[\s\S]*?<\/p:transition>|<p:transition[^>]*\/>/
/** Removes any timing block, so re-applying is idempotent. */
const TIMING_RE = /<p:timing>[\s\S]*?<\/p:timing>/

/** Matches one transition element in either the paired or the self-closing form. */
const TRANSITION_ELEMENT_RE = /<p:transition[\s\S]*?<\/p:transition>|<p:transition[^>]*\/>/

/**
 * @param xml - one slide's XML.
 * @returns the slide's transition element, or null when it carries none.
 */
export function transitionElementOf(xml: string): string | null {
  return TRANSITION_ELEMENT_RE.exec(xml)?.[0] ?? null
}

/** @returns the narration audio a slide references and its decoded duration. */
function narrationOf(pkg: OpcPackage, slidePart: string, xml: string): { mediaPart: string | null; durationMs: number | null } {
  const relationshipId = /<a:audioFile[^>]*\br:(?:link|embed)="([^"]+)"/.exec(xml)?.[1]
  const related = relationshipId === undefined ? undefined : pkg.relationshipsOf(slidePart).find((relationship) => relationship.id === relationshipId)
  const mediaPart = related === undefined ? null : posix.normalize(posix.join(posix.dirname(slidePart), related.target))
  const durationMs = mediaPart !== null && pkg.has(mediaPart) ? mp3DurationMs(pkg.part(mediaPart)) : null
  return { mediaPart, durationMs }
}

/**
 * Recompute one slide's auto-advance from the narration audio embedded in the package.
 *
 * The measured media is resolved through the slide's own relationships, so nothing
 * outside the package is consulted and the same bytes always give the same number.
 *
 * @param pkg - the package being edited.
 * @param slidePart - slide part name.
 * @param xml - the slide's current XML.
 * @returns the advance in milliseconds, or null when the slide has no readable narration.
 */
export function narratedAdvanceMs(pkg: OpcPackage, slidePart: string, xml: string): number | null {
  const { durationMs } = narrationOf(pkg, slidePart, xml)
  return durationMs === null ? null : NARRATION_LEAD_IN_MS + durationMs + NARRATION_PADDING_MS
}

/** One slide's recorded-narration facts, for gates that inspect a finished package. */
export interface NarrationTiming {
  readonly slidePart: string
  /** The media part the slide's `a:audioFile` resolves to, or null when there is none. */
  readonly mediaPart: string | null
  /** Decoded audio duration in milliseconds, or null when no frame parses. */
  readonly durationMs: number | null
  /** The advance post applies (lead-in + duration + padding), or null without readable audio. */
  readonly advanceMs: number | null
  /** The advance the package's transition carries, or null when it carries none. */
  readonly advTmMs: number | null
}

/**
 * @param pkg - a finished (or in-progress) package.
 * @returns the recorded narration of every slide, in slide order.
 */
export function narrationTimings(pkg: OpcPackage): NarrationTiming[] {
  return listSlides(pkg).map((slidePart) => {
    const xml = pkg.text(slidePart)
    const { mediaPart, durationMs } = narrationOf(pkg, slidePart, xml)
    return {
      slidePart,
      mediaPart,
      durationMs,
      advanceMs: durationMs === null ? null : NARRATION_LEAD_IN_MS + durationMs + NARRATION_PADDING_MS,
      advTmMs: autoAdvanceOf(transitionElementOf(xml)),
    }
  })
}

/** @returns whether the package declares that slide timings drive the show. */
export function showTimingsEnabled(pkg: OpcPackage): boolean {
  return pkg.has('ppt/presProps.xml') && /<p:showPr\b[^>]*useTimings="1"/.test(pkg.text('ppt/presProps.xml'))
}

/** @returns `transition` with its advance attributes replaced by the given timed advance. */
function withAutoAdvance(transition: string | null, autoAdvanceMs: number): string {
  const advance = ` advClick="0" advTm="${String(autoAdvanceMs)}"`
  if (transition === null) return `<p:transition${advance}/>`
  const cleared = transition.replace(/\s+adv(?:Click|Tm)="[^"]*"/g, '')
  return cleared.replace(/^<p:transition/, `<p:transition${advance}`)
}

/** @returns the advance the transition element carries, when it carries one. */
function autoAdvanceOf(transition: string | null): number | null {
  const match = /advTm="(\d+)"/.exec(transition ?? '')
  return match === null ? null : Number(match[1])
}

/**
 * @param transition - the slide's original transition element.
 * @param autoAdvanceMs - the recomputed advance, or null when the audio was unreadable.
 * @returns the transition to keep: retimed, the untouched original when it already
 *   advanced on a timer, or null when the slide needs no transition at all.
 */
function timedTransition(transition: string | null, autoAdvanceMs: number | null): string | null {
  if (autoAdvanceMs !== null) return withAutoAdvance(transition, autoAdvanceMs)
  return autoAdvanceOf(transition) === null ? null : transition
}

/**
 * Make the package's slide timings effective.
 *
 * The engine's recorded-narration route writes `p:showPr useTimings="1"` in
 * `presProps.xml`, and the merge rebuilds that part from the base deck. Without the
 * flag PowerPoint ignores every `advTm`, so a merged narrated deck must restore it.
 * Idempotent, and a no-op for a deck whose slides never advance on a timer.
 *
 * @param pkg - package to update, mutated in place.
 * @returns true when the show-timings flag had to be written.
 */
export function ensureShowTimings(pkg: OpcPackage): boolean {
  const timed = pkg.names().some((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name) && pkg.text(name).includes('advTm="'))
  if (!timed) return false
  const name = 'ppt/presProps.xml'
  if (!pkg.has(name)) return false
  const xml = pkg.text(name)
  if (/<p:showPr\b[^>]*useTimings="1"/.test(xml)) return false
  if (/<p:showPr\b/.test(xml)) {
    pkg.setPart(name, xml.replace(/<p:showPr\b/, '<p:showPr useTimings="1"'))
    return true
  }
  const open = /<p:presentationPr\b[^>]*?(\/?)>/.exec(xml)
  if (open === null) return false
  const tag = open[0]
  const inserted = open[1] === '/' ? `${tag.replace(/\/>$/, '>')}<p:showPr useTimings="1"/></p:presentationPr>` : `${tag}<p:showPr useTimings="1"/>`
  pkg.setPart(name, xml.replace(tag, inserted))
  return true
}

/**
 * Renumber duplicate `<p:cNvPr id="…">` values in one slide part.
 *
 * Injected `p:spTgt spid` references only mean something when shape ids are
 * unique inside the slide, and reviewers of the upstream implementation found
 * real decks where they are not. The first occurrence of an id keeps it; later
 * duplicates move above the slide's highest id.
 *
 * @param xml - slide part XML.
 * @returns XML with unique shape ids.
 */
export function dedupeShapeIds(xml: string): string {
  let maxId = 0
  for (const match of xml.matchAll(/<p:cNvPr id="(\d+)"/g)) {
    const id = Number(match[1])
    if (id > maxId) maxId = id
  }
  if (maxId === 0) return xml
  const seen = new Set<number>()
  let nextFree = maxId
  return xml.replace(/(<p:cNvPr id=")(\d+)(")/g, (full, prefix: string, idText: string, suffix: string) => {
    const id = Number(idText)
    if (!seen.has(id)) {
      seen.add(id)
      return full
    }
    nextFree += 1
    return `${prefix}${String(nextFree)}${suffix}`
  })
}

/**
 * Collect the shape ids a selector names.
 *
 * @param xml - slide part XML.
 * @param selector - a name substring or explicit ids.
 * @returns shape ids in document order.
 */
export function resolveTargets(xml: string, selector: { match: string } | { spids: readonly number[] }): number[] {
  if ('spids' in selector) return [...selector.spids]
  const found: number[] = []
  for (const match of xml.matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)) {
    if ((match[2] ?? '').includes(selector.match)) found.push(Number(match[1]))
  }
  return found
}

/** `<p:set>` + `<p:animEffect>` pair for one target, ported from pptwise. */
function setAnimEffectPairXml(spid: number, filter: string, durationMs: number, nextId: () => number): string {
  const setId = nextId()
  const effectId = nextId()
  return (
    `<p:set><p:cBhvr><p:cTn id="${String(setId)}" dur="1" fill="hold">` +
    `<p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>` +
    `<p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl>` +
    `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>` +
    `<p:to><p:strVal val="visible"/></p:to></p:set>` +
    `<p:animEffect transition="in" filter="${filter}"><p:cBhvr>` +
    `<p:cTn id="${String(effectId)}" dur="${String(durationMs)}"/><p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl>` +
    `</p:cBhvr></p:animEffect>`
  )
}

/** One entrance block: `<p:par>` wrapping the effect leaves, ported from pptwise. */
function entranceParXml(entry: { effect: EntranceEffect; spids: readonly number[] }, delayMs: number, durationMs: number, nextId: () => number): string {
  const preset = ENTRANCE_PRESET[entry.effect]
  const leaves = entry.spids
    .map((spid, offset) =>
      `<p:par><p:cTn id="${String(nextId())}" presetID="${String(preset.presetID)}" presetClass="entr" presetSubtype="${String(preset.presetSubtype)}" fill="hold" nodeType="${offset === 0 ? 'afterEffect' : 'withEffect'}">` +
      `<p:stCondLst><p:cond delay="${String(delayMs)}"/></p:stCondLst><p:childTnLst>` +
      setAnimEffectPairXml(spid, preset.filter, durationMs, nextId) +
      `</p:childTnLst></p:cTn></p:par>`,
    )
    .join('')
  return `<p:par><p:cTn id="${String(nextId())}" fill="hold"><p:stCondLst><p:cond delay="${String(delayMs)}"/></p:stCondLst><p:childTnLst>${leaves}</p:childTnLst></p:cTn></p:par>`
}

/** One block the motion timeline can carry: an entrance, an emphasis or a path. */
export interface MotionBlock {
  readonly kind: 'entrance' | 'emphasis' | 'path'
  readonly effect: string
  readonly spids: readonly number[]
  readonly durationMs: number
  readonly delayMs: number
}

/**
 * One effect `<p:par>` per targeted shape, wrapped the way PowerPoint itself wraps an
 * emphasis or a path: a hold group, then the preset `p:cTn` with its `p:iterate` and the
 * behaviour. The extra wrapper is what makes PowerPoint register the behaviour at all.
 */
function effectParXml(input: {
  presetID: number
  presetClass: 'emph' | 'path'
  extraAttributes: string
  spids: readonly number[]
  delayMs: number
  nextId: () => number
  behavior: (spid: number, nextId: () => number) => string
}): string {
  return input.spids
    .map(
      (spid) =>
        `<p:par><p:cTn id="${String(input.nextId())}" fill="hold"><p:stCondLst><p:cond delay="${String(input.delayMs)}"/></p:stCondLst><p:childTnLst>` +
        `<p:par><p:cTn id="${String(input.nextId())}" presetID="${String(input.presetID)}" presetClass="${input.presetClass}" presetSubtype="0"${input.extraAttributes} fill="hold" nodeType="clickEffect">` +
        `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:iterate type="lt"><p:tmPct val="0"/></p:iterate>` +
        `<p:childTnLst>${input.behavior(spid, input.nextId)}</p:childTnLst></p:cTn></p:par>` +
        `</p:childTnLst></p:cTn></p:par>`,
    )
    .join('')
}

/** One effect wrapped the PowerPoint way, carrying a spin or grow/shrink behaviour. */
function emphasisParXml(effect: EmphasisEffect, spids: readonly number[], delayMs: number, durationMs: number, nextId: () => number): string {
  const preset = EMPHASIS_PRESET[effect]
  return effectParXml({
    presetID: preset.presetID,
    presetClass: 'emph',
    extraAttributes: '',
    spids,
    delayMs,
    nextId,
    behavior: (spid, id) => preset.behavior(spid, durationMs, id),
  })
}

/** One effect wrapped the PowerPoint way, carrying an `p:animMotion` path. */
function pathParXml(effect: PathEffect, spids: readonly number[], delayMs: number, durationMs: number, nextId: () => number): string {
  const preset = PATH_PRESET[effect]
  return effectParXml({
    presetID: preset.presetID,
    presetClass: 'path',
    extraAttributes: ' accel="50000" decel="50000"',
    spids,
    delayMs,
    nextId,
    behavior: (spid, id) =>
      `<p:animMotion origin="layout" path="${preset.path}" pathEditMode="relative" ptsTypes=""><p:cBhvr>` +
      `<p:cTn id="${String(id())}" dur="${String(durationMs)}" fill="hold"/>` +
      `<p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl>` +
      `<p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst>` +
      `</p:cBhvr></p:animMotion>`,
  })
}

/**
 * Build the `<p:timing>` block for one slide.
 *
 * The nesting is `tmRoot → mainSeq → click par → one par per entrance block`,
 * exactly what pptwise's writer produces and what its tests verify against a
 * sample deck; a fourth `p:par` layer is known to make PowerPoint drop the
 * animation, so the shape is deliberately kept.
 *
 * @param entries - entrance blocks in play order.
 * @param staggerMs - delay between blocks.
 * @param defaultDurationMs - effect duration when an entry does not set one.
 * @returns the `p:timing` fragment.
 */
export function entranceTimingXml(
  entries: readonly { effect: EntranceEffect; spids: readonly number[]; durationMs?: number }[],
  staggerMs = 200,
  defaultDurationMs = 400,
): string {
  return motionTimingXml(
    entries.map((entry, offset) => ({
      kind: 'entrance' as const,
      effect: entry.effect,
      spids: entry.spids,
      durationMs: entry.durationMs ?? defaultDurationMs,
      delayMs: offset * staggerMs,
    })),
  )
}

/**
 * Build one `<p:timing>` tree for every block of a slide, in the order given.
 *
 * The nesting is `tmRoot -> mainSeq -> click par -> one par per block`, exactly what
 * pptwise's writer produces and what its tests verify against a sample deck; a fourth
 * `p:par` layer is known to make PowerPoint drop the animation, so the shape is
 * deliberately kept. Entrances, emphases and paths are separate blocks at the same
 * level, each starting after the deck's stagger.
 *
 * @param blocks - the slide's motion blocks, already resolved to shape ids.
 * @returns the `p:timing` fragment, or an empty string when nothing is targeted.
 */
export function motionTimingXml(blocks: readonly MotionBlock[]): string {
  const withTargets = blocks.filter((block) => block.spids.length > 0)
  if (withTargets.length === 0) return ''
  let id = 3 // 1 = tmRoot, 2 = mainSeq, 3 = the shared click wrapper
  const nextId = (): number => {
    id += 1
    return id
  }
  const body = withTargets
    .map((block) =>
      block.kind === 'entrance'
        ? entranceParXml({ effect: block.effect as EntranceEffect, spids: block.spids }, block.delayMs, block.durationMs, nextId)
        : block.kind === 'emphasis'
          ? emphasisParXml(block.effect as EmphasisEffect, block.spids, block.delayMs, block.durationMs, nextId)
          : pathParXml(block.effect as PathEffect, block.spids, block.delayMs, block.durationMs, nextId),
    )
    .join('')
  const build = [...new Set(withTargets.flatMap((block) => block.spids))]
    .map((spid) => `<p:bldP spid="${String(spid)}" grpId="0"/>`)
    .join('')
  return (
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">` +
    `<p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">` +
    `<p:childTnLst><p:par><p:cTn id="3" fill="hold">` +
    `<p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>` +
    `<p:childTnLst>${body}</p:childTnLst>` +
    `</p:cTn></p:par></p:childTnLst></p:cTn>` +
    `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
    `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>` +
    `</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>` +
    `<p:bldLst>${build}</p:bldLst></p:timing>`
  )
}

/**
 * Strip the motion blocks a previous pass (or an engine) wrote.
 *
 * @param xml - slide part XML.
 * @returns XML without `p:transition` or `p:timing`.
 */
export function stripMotion(xml: string): string {
  return xml.replace(TRANSITION_RE, '').replace(TIMING_RE, '')
}

/** What one applied slide produced, for the report. */
export interface PostSlideReport {
  readonly index: number
  readonly slidePart: string
  readonly transition: TransitionEffect | null
  /** Timed advance in milliseconds this slide received, from its recorded narration. */
  readonly autoAdvanceMs: number | null
  /** Every shape the timeline targets, whatever the block kind. */
  readonly animatedSpids: readonly number[]
  readonly emphasis: EmphasisEffect | null
  readonly path: PathEffect | null
}

/** Result of a post pass. */
export interface PostReport {
  readonly slides: readonly PostSlideReport[]
  /** Slides whose entrance selector matched nothing, which is a configuration error. */
  readonly unmatched: readonly number[]
}

/**
 * Apply the deck's motion configuration to a merged package.
 *
 * Every slide's existing motion is removed first, so this is the single place a
 * deck's transitions and entrances come from: the engines render content, the post
 * layer owns the timeline. Idempotent by construction — re-running over the same
 * package produces the same XML.
 *
 * @param pkg - merged package, mutated in place.
 * @param config - parsed `post/animations.json`.
 * @returns what was applied, and any selector that matched nothing.
 * @throws DshPptFailure `ContractViolation` when the config names a missing slide.
 */
export function applyPost(pkg: OpcPackage, config: PostConfig): PostReport {
  const slides = listSlides(pkg)
  const reports: PostSlideReport[] = []
  const unmatched: number[] = []
  const byIndex = new Map<number, (typeof config.slides)[number]>()
  for (const entry of config.slides) {
    if (byIndex.has(entry.index)) {
      throw new DshPptFailure('ContractViolation', `post/animations.json lists slide ${String(entry.index)} twice`, { detail: { index: entry.index } })
    }
    byIndex.set(entry.index, entry)
  }

  for (const [offset, slidePart] of slides.entries()) {
    const index = offset + 1
    const original = dedupeShapeIds(pkg.text(slidePart))
    const originalTransition = transitionElementOf(original)
    let xml = stripMotion(original)
    const entry = byIndex.get(index)
    const autoAdvanceMs = narratedAdvanceMs(pkg, slidePart, original)
    const recordedAdvance = autoAdvanceOf(originalTransition)
    if (entry === undefined) {
      const kept = timedTransition(originalTransition, autoAdvanceMs)
      if (kept !== null) xml = xml.replace('</p:sld>', `${kept}</p:sld>`)
      pkg.setPart(slidePart, xml)
      continue
    }
    if (entry.transition !== undefined && entry.transition !== 'none') {
      xml = xml.replace('</p:sld>', `${transitionXml(entry.transition, entry.durationMs ?? 400, autoAdvanceMs ?? recordedAdvance ?? undefined)}</p:sld>`)
    } else {
      const kept = timedTransition(originalTransition, autoAdvanceMs)
      if (kept !== null) xml = xml.replace('</p:sld>', `${kept}</p:sld>`)
    }
    const blocks: MotionBlock[] = []
    const animatedSpids: number[] = []
    const stagger = config.staggerMs ?? 200
    const resolve = (selector: Parameters<typeof resolveTargets>[1]): number[] => {
      const found = resolveTargets(xml, selector)
      if (found.length === 0) unmatched.push(index)
      else animatedSpids.push(...found)
      return found
    }
    if (entry.entrance !== undefined) {
      const targets = resolve(entry.entrance.target)
      if (targets.length > 0) {
        blocks.push({ kind: 'entrance', effect: entry.entrance.effect, spids: targets, durationMs: entry.entrance.durationMs ?? 400, delayMs: blocks.length * stagger })
      }
    }
    if (entry.emphasis !== undefined) {
      const targets = resolve(entry.emphasis.target)
      if (targets.length > 0) {
        blocks.push({ kind: 'emphasis', effect: entry.emphasis.effect, spids: targets, durationMs: entry.emphasis.durationMs ?? 2000, delayMs: (entry.emphasis.delayMs ?? 0) + blocks.length * stagger })
      }
    }
    if (entry.path !== undefined) {
      const targets = resolve(entry.path.target)
      if (targets.length > 0) {
        blocks.push({ kind: 'path', effect: entry.path.effect, spids: targets, durationMs: entry.path.durationMs ?? 2000, delayMs: (entry.path.delayMs ?? 0) + blocks.length * stagger })
      }
    }
    const timing = motionTimingXml(blocks)
    if (timing !== '') xml = xml.replace('</p:sld>', `${timing}</p:sld>`)
    pkg.setPart(slidePart, xml)
    reports.push({
      index,
      slidePart,
      transition: entry.transition ?? null,
      autoAdvanceMs: autoAdvanceMs ?? recordedAdvance,
      animatedSpids: [...new Set(animatedSpids)],
      emphasis: entry.emphasis?.effect ?? null,
      path: entry.path?.effect ?? null,
    })
  }

  for (const entry of config.slides) {
    if (entry.index > slides.length) {
      throw new DshPptFailure('ContractViolation', `post/animations.json names slide ${String(entry.index)} but the deck has ${String(slides.length)}`, {
        detail: { index: entry.index, slides: slides.length },
      })
    }
  }

  return { slides: reports, unmatched: [...new Set(unmatched)] }
}

/**
 * Read and validate a deck's post configuration.
 *
 * @param fs - filesystem port.
 * @param path - absolute path of `post/animations.json`.
 * @returns the parsed configuration.
 * @throws DshPptFailure `OutputMissing` when the file is absent, `ContractViolation`
 *   when it does not match the schema.
 */
export function readPostConfig(fs: FileSystemPort, path: string): PostConfig {
  const text = fs.readText(path)
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `post configuration is absent: ${path}`, { detail: { path } })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = PostConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    throw new DshPptFailure('ContractViolation', `${path} is invalid: ${issues.join('; ')}`, { detail: { issues } })
  }
  return result.data
}
