import { z } from 'zod'
import { DshPptFailure } from '../engine/errors.ts'
import { CHROME_ROLES, chromeRoleFor, describeIssues, isPageNumberSkipped, type ChromeRole, type FusionDeck } from './fusion.ts'
import type { IrView } from '../deck.ts'

/**
 * `deck.storyboard.json`: the per-page plan V6 WP2 makes mandatory (plan §4.1).
 *
 * The storyboard is the deck's contract with its author: every page names its
 * role, the layout it uses, the route that renders it, its chrome participation,
 * a content budget and the source it came from. `plan` writes a skeleton; the
 * model fills the fields; `validate` proves coverage and agreement with the
 * manifest before anything renders.
 */

/** File name of the storyboard. */
export const STORYBOARD_FILE = 'deck.storyboard.json'

/** Roles a page may declare; the chrome contract's vocabulary, reused. */
export const STORYBOARD_ROLES = CHROME_ROLES

/** Routes a page may declare; must agree with `deck.fusion.json`. */
export const STORYBOARD_ROUTES = ['pptwise', 'ppt-master'] as const

/** Per-page content budget; every field is a ceiling, not a target. */
export interface StoryboardBudget {
  readonly maxWords?: number
  readonly maxItems?: number
  readonly maxCharts?: number
  readonly maxTables?: number
  readonly maxImages?: number
}

/** One planned page. */
export interface StoryboardPage {
  readonly index: number
  readonly role: ChromeRole
  readonly layout: string
  readonly route: (typeof STORYBOARD_ROUTES)[number]
  /** Whether the page takes the deck's page number, when the manifest declares chrome. */
  readonly chrome?: { readonly pageNumber: 'show' | 'skip' }
  readonly budget?: StoryboardBudget
  /** Workspace-relative source this page was authored from. */
  readonly source?: string
}

/** The validated storyboard document. */
export interface Storyboard {
  readonly version: 1
  readonly pages: readonly StoryboardPage[]
}

const BudgetSchema = z.strictObject({
  maxWords: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  maxCharts: z.number().int().nonnegative().optional(),
  maxTables: z.number().int().nonnegative().optional(),
  maxImages: z.number().int().nonnegative().optional(),
})

const StoryboardPageSchema = z.strictObject({
  index: z.number().int().positive(),
  role: z.enum(STORYBOARD_ROLES),
  layout: z.string().min(1),
  route: z.enum(STORYBOARD_ROUTES),
  chrome: z.strictObject({ pageNumber: z.enum(['show', 'skip']) }).optional(),
  budget: BudgetSchema.optional(),
  source: z.string().min(1).optional(),
})

/** Zod schema for `deck.storyboard.json`; unknown keys are rejected. */
export const StoryboardSchema = z.strictObject({
  version: z.literal(1),
  pages: z.array(StoryboardPageSchema).min(1),
})

/**
 * Parse a storyboard document.
 *
 * @param raw - parsed JSON of the storyboard.
 * @returns the validated storyboard.
 * @throws DshPptFailure `ContractViolation` listing every field that is wrong.
 */
export function parseStoryboard(raw: unknown): Storyboard {
  const result = StoryboardSchema.safeParse(raw)
  if (!result.success) {
    const messages = describeIssues(result.error.issues)
    throw new DshPptFailure('ContractViolation', `${STORYBOARD_FILE} is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data as Storyboard
}

/**
 * The storyboard skeleton `plan` writes.
 *
 * Roles come from the IR slide types, routes from the manifest, and the layout is
 * the placeholder `unconfirmed` — a model or an author replaces it with an id from
 * the bound theme's menu before the planning gate passes.
 *
 * @param deck - validated manifest.
 * @param ir - the IR the manifest points at.
 * @returns a schema-valid skeleton.
 */
export function storyboardSkeleton(deck: FusionDeck, ir: IrView): Storyboard {
  return {
    version: 1,
    pages: deck.pages.map((page) => {
      const slide = ir.slides[page.index - 1]
      const role = chromeRoleFor(slide?.type)
      return {
        index: page.index,
        role,
        layout: 'unconfirmed',
        route: page.route,
        // The skeleton mirrors the manifest's page-number rule; `validate` proves
        // the two agree once the manifest declares chrome.
        chrome: { pageNumber: role === 'cover' || role === 'ending' ? 'skip' : 'show' },
      }
    }),
  }
}

/**
 * @param storyboard - parsed storyboard.
 * @param pageCount - number of pages the IR has.
 * @returns one message per coverage violation; empty means the storyboard covers the deck.
 */
export function checkStoryboardCoverage(storyboard: Storyboard, pageCount: number): string[] {
  const problems: string[] = []
  const indices = storyboard.pages.map((page) => page.index)
  const seen = new Set<number>()
  for (const index of indices) {
    if (seen.has(index)) problems.push(`storyboard lists page ${String(index)} more than once`)
    seen.add(index)
  }
  const missing = Array.from({ length: pageCount }, (_, offset) => offset + 1).filter((index) => !seen.has(index))
  if (missing.length > 0) problems.push(`storyboard is missing page ${missing.join(', ')} (the IR has ${String(pageCount)} pages)`)
  const extra = indices.filter((index) => index > pageCount)
  if (extra.length > 0) problems.push(`storyboard lists page ${extra.join(', ')} but the IR has only ${String(pageCount)} pages`)
  return problems
}

/**
 * Compare a storyboard against the manifest it plans for.
 *
 * @param storyboard - parsed storyboard.
 * @param deck - validated manifest.
 * @param ir - the IR the manifest points at.
 * @returns one message per disagreement; empty means the two documents agree.
 */
export function checkStoryboardAgainstManifest(storyboard: Storyboard, deck: FusionDeck, ir: IrView): string[] {
  const problems: string[] = []
  const byIndex = new Map(deck.pages.map((page) => [page.index, page]))
  for (const page of storyboard.pages) {
    const manifestPage = byIndex.get(page.index)
    if (manifestPage === undefined) {
      problems.push(`storyboard page ${String(page.index)} has no manifest entry`)
      continue
    }
    if (manifestPage.route !== page.route) {
      problems.push(`storyboard page ${String(page.index)} routes ${page.route} but the manifest routes ${manifestPage.route}`)
    }
    const slide = ir.slides[page.index - 1]
    const irRole = chromeRoleFor(slide?.type)
    if (slide?.type !== undefined && slide.type !== '' && irRole !== page.role) {
      problems.push(`storyboard page ${String(page.index)} says role ${page.role} but the IR slide type ${slide.type} maps to ${irRole}`)
    }
    if (deck.chrome !== undefined && page.chrome !== undefined) {
      const skipped = isPageNumberSkipped(deck.chrome, irRole)
      const expected = skipped ? 'skip' : 'show'
      if (page.chrome.pageNumber !== expected) {
        problems.push(`storyboard page ${String(page.index)} says pageNumber ${page.chrome.pageNumber} but the manifest's chrome contract implies ${expected}`)
      }
    }
  }
  return problems
}
