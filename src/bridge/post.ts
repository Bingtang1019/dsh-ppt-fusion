import { DshPptFailure } from '../engine/errors.ts'
import { PostConfigSchema, type EntranceEffect, type PostConfig, type TransitionEffect } from '../schema/post.ts'
import { listSlides, type OpcPackage } from './opc.ts'
import type { FileSystemPort } from '../engine/venv.ts'

/**
 * Transition XML, ported from pptwise's byte-verified writer (its
 * `pptx-animations.ts`, MIT): `p14:dur` carries the duration and the effect is a
 * child element. PowerPoint's own default is 400 ms, which is what both engines
 * use.
 *
 * @param effect - transition effect; `none` is handled by the caller as a strip.
 * @param durationMs - duration in milliseconds.
 * @returns the `p:transition` fragment.
 */
export function transitionXml(effect: Exclude<TransitionEffect, 'none'>, durationMs = 400): string {
  const element = effect === 'fade' ? '<p:fade/>' : effect === 'push' ? '<p:push dir="r"/>' : '<p:wipe dir="r"/>'
  return `<p:transition p14:dur="${String(durationMs)}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${element}</p:transition>`
}

/** animEffect filter and preset ids per entrance effect, from pptwise's mapping. */
const ENTRANCE_PRESET: Record<EntranceEffect, { filter: string; presetID: number; presetSubtype: number }> = {
  fade: { filter: 'fade', presetID: 10, presetSubtype: 0 },
  wipe: { filter: 'wipe(down)', presetID: 12, presetSubtype: 4 },
  fly: { filter: 'slide(fromLeft)', presetID: 42, presetSubtype: 8 },
}

/** Removes any transition block, so re-applying is idempotent. */
const TRANSITION_RE = /<p:transition[\s\S]*?<\/p:transition>/
/** Removes any timing block, so re-applying is idempotent. */
const TIMING_RE = /<p:timing>[\s\S]*?<\/p:timing>/

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
  const withTargets = entries.filter((entry) => entry.spids.length > 0)
  if (withTargets.length === 0) return ''
  let id = 3 // 1 = tmRoot, 2 = mainSeq, 3 = the shared click wrapper
  const nextId = (): number => {
    id += 1
    return id
  }
  const blocks = withTargets
    .map((entry, offset) => entranceParXml(entry, offset * staggerMs, entry.durationMs ?? defaultDurationMs, nextId))
    .join('')
  const build = withTargets
    .flatMap((entry) => entry.spids)
    .map((spid) => `<p:bldP spid="${String(spid)}" grpId="0"/>`)
    .join('')
  return (
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">` +
    `<p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">` +
    `<p:childTnLst><p:par><p:cTn id="3" fill="hold">` +
    `<p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>` +
    `<p:childTnLst>${blocks}</p:childTnLst>` +
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
  readonly animatedSpids: readonly number[]
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
    let xml = stripMotion(dedupeShapeIds(pkg.text(slidePart)))
    const entry = byIndex.get(index)
    if (entry === undefined) {
      pkg.setPart(slidePart, xml)
      continue
    }
    if (entry.transition !== undefined && entry.transition !== 'none') {
      xml = xml.replace('</p:sld>', `${transitionXml(entry.transition, entry.durationMs ?? 400)}</p:sld>`)
    }
    let animatedSpids: number[] = []
    if (entry.entrance !== undefined) {
      const targets = resolveTargets(xml, entry.entrance.target)
      if (targets.length === 0) {
        unmatched.push(index)
      } else {
        const timing = entranceTimingXml(
          [{ effect: entry.entrance.effect, spids: targets, ...(entry.entrance.durationMs === undefined ? {} : { durationMs: entry.entrance.durationMs }) }],
          config.staggerMs ?? 200,
        )
        xml = xml.replace('</p:sld>', `${timing}</p:sld>`)
        animatedSpids = targets
      }
    }
    pkg.setPart(slidePart, xml)
    reports.push({
      index,
      slidePart,
      transition: entry.transition ?? null,
      animatedSpids,
    })
  }

  for (const entry of config.slides) {
    if (entry.index > slides.length) {
      throw new DshPptFailure('ContractViolation', `post/animations.json names slide ${String(entry.index)} but the deck has ${String(slides.length)}`, {
        detail: { index: entry.index, slides: slides.length },
      })
    }
  }

  return { slides: reports, unmatched }
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
