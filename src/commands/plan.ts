import { basename, join } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { parseFusionDeck, defaultChrome, type FusionDeck } from '../schema/fusion.ts'
import { FUSION_MANIFEST, readManifest } from '../deck.ts'
import { toJsonDocument } from '../bridge/theme.ts'
import type { CommandDependencies } from './context.ts'

/** File name of the draft `plan` writes. */
export const PLAN_DRAFT = 'deck.fusion.draft.json'

/** What `plan` produced. */
export interface PlanResult {
  readonly draftPath: string
  /** Field paths the model still has to decide before copying the draft into place. */
  readonly needsConfirmation: readonly string[]
  readonly pageCount: number
}

/**
 * Turn source markdown into a page skeleton.
 *
 * A `## heading` becomes one content page; without headings the deck gets the
 * cover/points/ending shape. Every route and kind in the result is a suggestion,
 * which is why the draft lists them as needing confirmation.
 *
 * @param markdown - source document, already converted by `source`.
 * @returns page titles and the reason each page exists.
 */
export function outlineFromMarkdown(markdown: string): { heading: string; kind: string }[] {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]?.trim() ?? '').filter((heading) => heading !== '')
  if (headings.length === 0) return [{ heading: 'Points', kind: 'points' }]
  return headings.map((heading) => ({
    heading,
    kind: /(数量|数据|图表|data|chart|指标|number)/i.test(heading) ? 'data' : 'points',
  }))
}

/**
 * Build a manifest draft for a deck workspace.
 *
 * The draft wraps a schema-valid manifest plus the list of fields a model still
 * has to confirm (plan §3.3: `plan` suggests, the model decides). Copying the
 * draft into `deck.fusion.json` unchanged is therefore always legal, and the list
 * is the author's to-do.
 *
 * @param options.dir - deck workspace.
 * @param options.deps - command dependencies.
 * @param options.sources - workspace-relative markdown files to outline from.
 * @returns the draft path and the fields needing confirmation.
 */
export function planDeck(options: { dir: string; deps: CommandDependencies; sources?: readonly string[] }): PlanResult {
  const { dir, deps } = options
  const manifestPath = join(dir, FUSION_MANIFEST)
  const existing = deps.fs.readText(manifestPath)
  const needsConfirmation: string[] = []
  let deck: FusionDeck

  if (existing !== null) {
    deck = readManifest(dir, deps.fs).deck
    needsConfirmation.push('pages[].route (re-check every page against the routing table)')
  } else {
    const name = basename(dir)
    const outline = options.sources
      ?.map((source) => deps.fs.readText(join(dir, source)))
      .filter((text): text is string => text !== null)
      .flatMap((text) => outlineFromMarkdown(text)) ?? []
    const pages = outline.length > 0 ? outline : [{ heading: 'Points', kind: 'points' }]
    const slideCount = pages.length + 2
    deck = parseFusionDeck({
      version: 1,
      name,
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: Array.from({ length: slideCount }, (_, offset) => ({ index: offset + 1, route: 'pptwise' })),
      // Drafts carry the default chrome contract, so a deck never starts from
      // whatever chrome a layout happens to draw.
      chrome: defaultChrome(),
    })
    needsConfirmation.push('theme.preset (chosen from `dsh-ppt theme try` candidates)')
    needsConfirmation.push('name')
    needsConfirmation.push('pages[].route (deep pages must also declare deep.kind and deep.format)')
  }

  const draftPath = join(dir, PLAN_DRAFT)
  deps.fs.writeText(draftPath, toJsonDocument({ needsConfirmation, manifest: deck }))
  return { draftPath, needsConfirmation, pageCount: deck.pages.length }
}

/**
 * Copy a confirmed draft into place.
 *
 * @param options.dir - deck workspace.
 * @param options.deps - command dependencies.
 * @returns the manifest path written.
 * @throws DshPptFailure `OutputMissing` when there is no draft to confirm.
 */
export function confirmPlan(options: { dir: string; deps: CommandDependencies }): string {
  const draftPath = join(options.dir, PLAN_DRAFT)
  const text = options.deps.fs.readText(draftPath)
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `no draft to confirm at ${draftPath}; run \`dsh-ppt plan\` first`, {
      detail: { draftPath },
    })
  }
  const draft = JSON.parse(text) as { manifest?: unknown }
  const deck = parseFusionDeck(draft.manifest)
  const manifestPath = join(options.dir, FUSION_MANIFEST)
  options.deps.fs.writeText(manifestPath, toJsonDocument(deck))
  return manifestPath
}
