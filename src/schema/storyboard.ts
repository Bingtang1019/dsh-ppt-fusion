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

/** Roles a page may declare; the chrome role vocabulary plus the v0.3 `toc` page. */
export const STORYBOARD_ROLES = [...CHROME_ROLES, 'toc'] as const

/** One storyboard role: a chrome role, or `toc` for a table-of-contents page. */
export type StoryboardRole = (typeof STORYBOARD_ROLES)[number]

/** Routes a page may declare; must agree with `deck.fusion.json`. */
export const STORYBOARD_ROUTES = ['pptwise', 'ppt-master'] as const

/**
 * Map an IR slide onto the storyboard role vocabulary.
 *
 * Delegates to the chrome role mapping so the storyboard's role requirement and
 * the chrome skip rule share one definition.
 *
 * @param slide - IR slide fields, when the slide exists.
 * @returns the role the storyboard must declare for that page.
 */
export function storyboardRoleFor(slide: { readonly type?: string; readonly kind?: string } | undefined): ChromeRole {
  return chromeRoleFor(slide?.type, slide?.kind)
}

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
  readonly role: StoryboardRole
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

/**
 * First-version per-role content ceilings (plan §4.3), applied to every page whose
 * budget omits the field. Q4 re-measures them against the eval scenarios and
 * records the calibrated numbers in an ADR.
 */
export const DEFAULT_BUDGETS: Record<StoryboardRole, Required<StoryboardBudget>> = {
  cover: { maxWords: 24, maxItems: 2, maxCharts: 0, maxTables: 0, maxImages: 1 },
  toc: { maxWords: 40, maxItems: 8, maxCharts: 0, maxTables: 0, maxImages: 1 },
  section: { maxWords: 24, maxItems: 2, maxCharts: 0, maxTables: 0, maxImages: 1 },
  content: { maxWords: 90, maxItems: 6, maxCharts: 1, maxTables: 1, maxImages: 2 },
  data: { maxWords: 40, maxItems: 4, maxCharts: 1, maxTables: 1, maxImages: 1 },
  quote: { maxWords: 40, maxItems: 2, maxCharts: 0, maxTables: 0, maxImages: 1 },
  ending: { maxWords: 24, maxItems: 2, maxCharts: 0, maxTables: 0, maxImages: 1 },
}

/**
 * @param page - one storyboard page.
 * @returns the page's ceilings: the role defaults, overridden field by field by the page's own budget.
 */
export function effectiveBudget(page: StoryboardPage): Required<StoryboardBudget> {
  return { ...DEFAULT_BUDGETS[page.role], ...page.budget }
}

/**
 * Which theme-menu slots may host each role (plan §4.2).
 *
 * A slot is a path into the theme's `menu` (`cover`, `chapter`, `content.<kind>`,
 * `ending`); a role matches a slot when the slot equals the entry or extends it
 * with `.`, so `content` accepts every `content.<kind>`.
 */
export const ROLE_LAYOUT_MENU: Record<StoryboardRole, readonly string[]> = {
  cover: ['cover'],
  toc: ['content'],
  section: ['chapter'],
  content: ['content'],
  data: ['content.data', 'content.fact', 'content.evidence'],
  quote: ['content.statement'],
  ending: ['ending'],
}

/**
 * Read a theme document's `menu` into face → menu paths.
 *
 * The menu is upstream-owned and stays untyped here; unrecognised shapes are
 * ignored rather than trusted, so a menu this package cannot read behaves like an
 * absent one (the layout check then reports the face as unregistered).
 *
 * @param menu - the theme document's `menu` value, whatever it holds.
 * @returns every face the menu advertises, with the slots that advertise it.
 */
export function layoutMenuPaths(menu: unknown): Map<string, string[]> {
  const paths = new Map<string, string[]>()
  const faceOf = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object') {
      const face = (value as { face?: unknown }).face
      return typeof face === 'string' ? face : undefined
    }
    return undefined
  }
  const add = (value: unknown, path: string): void => {
    const face = faceOf(value)
    if (face === undefined || face === '') return
    paths.set(face, [...(paths.get(face) ?? []), path])
  }
  if (menu === null || typeof menu !== 'object') return paths
  const roots = menu as Record<string, unknown>
  for (const root of ['cover', 'chapter', 'ending']) add(roots[root], root)
  const content = roots.content
  if (content !== null && typeof content === 'object') {
    for (const [kind, value] of Object.entries(content as Record<string, unknown>)) add(value, `content.${kind}`)
    // Some documents flatten the content menu to a single face.
    add(content, 'content')
  }
  return paths
}

/**
 * Split a storyboard layout id into its theme pin and its face.
 *
 * The canonical id is `<themeId>:<face>` (for example `brief:gauge-stats`); a bare
 * face is accepted and pinned implicitly to the deck's bound theme.
 *
 * @param layout - the storyboard page's layout id.
 * @returns the explicit theme when the id carries one, and the face.
 */
export function parseLayoutId(layout: string): { theme?: string; face: string } {
  const separator = layout.indexOf(':')
  if (separator <= 0) return { face: layout }
  return { theme: layout.slice(0, separator), face: layout.slice(separator + 1) }
}

/**
 * @param role - storyboard role.
 * @param themeId - the bound theme's id.
 * @param menu - the bound theme's `menu`.
 * @returns the first menu face that can host the role, as `<themeId>:<face>`, or null when the menu has none.
 */
export function defaultLayoutFor(role: StoryboardRole, themeId: string, menu: unknown): string | null {
  const allowed = ROLE_LAYOUT_MENU[role]
  for (const [face, paths] of layoutMenuPaths(menu)) {
    if (paths.some((path) => allowed.some((entry) => path === entry || path.startsWith(`${entry}.`)))) {
      return `${themeId}:${face}`
    }
  }
  return null
}

/**
 * Check every storyboard layout against the bound theme's menu.
 *
 * A storyboard does not survive a theme rebind: pptwise refuses cross-menu
 * rebinding (ADR-052), so the layout's theme pin must be the bound theme and its
 * face must sit in a menu slot the page's role may use.
 *
 * @param storyboard - parsed storyboard.
 * @param theme - bound theme id and menu, or null when no readable theme exists
 *   (the theme gate already reports that).
 * @returns one message per violation; empty means every layout is legal.
 */
export function checkStoryboardLayouts(storyboard: Storyboard, theme: { readonly id: string; readonly menu?: unknown } | null): string[] {
  if (theme === null) return []
  const paths = layoutMenuPaths(theme.menu)
  const problems: string[] = []
  for (const page of storyboard.pages) {
    const { theme: pinned, face } = parseLayoutId(page.layout)
    if (pinned !== undefined && pinned !== theme.id) {
      problems.push(
        `storyboard page ${String(page.index)} pins layout theme "${pinned}" but the deck binds "${theme.id}"; re-plan the storyboard when the theme changes (ADR-052)`,
      )
      continue
    }
    const facePaths = paths.get(face)
    if (facePaths === undefined) {
      problems.push(
        `storyboard page ${String(page.index)}: layout "${page.layout}" is not in the "${theme.id}" menu; set a face from \`pptwise layouts\` for that theme`,
      )
      continue
    }
    const allowed = ROLE_LAYOUT_MENU[page.role]
    if (!facePaths.some((path) => allowed.some((entry) => path === entry || path.startsWith(`${entry}.`)))) {
      problems.push(
        `storyboard page ${String(page.index)}: role "${page.role}" cannot use layout "${page.layout}" (the "${theme.id}" menu files it under ${facePaths.join(', ')})`,
      )
    }
  }
  return problems
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
 * Roles come from the IR slide types (with the content `kind` deciding data and
 * quote pages) and routes from the manifest. When the bound theme's menu is known,
 * each page also gets the first menu face its role may use, so a fresh workspace
 * already validates; otherwise the layout stays `unconfirmed` and `validate` fails
 * until the model or author fills it from `pptwise layouts`.
 *
 * @param deck - validated manifest.
 * @param ir - the IR the manifest points at.
 * @param theme - bound theme id and menu when the theme file is readable.
 * @returns a schema-valid skeleton.
 */
export function storyboardSkeleton(deck: FusionDeck, ir: IrView, theme?: { readonly id: string; readonly menu?: unknown }): Storyboard {
  return {
    version: 1,
    pages: deck.pages.map((page) => {
      const slide = ir.slides[page.index - 1]
      const role = storyboardRoleFor(slide === undefined ? undefined : { type: slide.type, kind: typeof slide.kind === 'string' ? slide.kind : undefined })
      const layout = theme === undefined ? null : defaultLayoutFor(role, theme.id, theme.menu)
      return {
        index: page.index,
        role,
        layout: layout ?? 'unconfirmed',
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
    const irRole = storyboardRoleFor(slide === undefined ? undefined : { type: slide.type, kind: typeof slide.kind === 'string' ? slide.kind : undefined })
    // A toc page is a content page in the IR: pptwise has no toc slide type, so the
    // storyboard may promote a content page to `toc` for the v0.3 role templates.
    const roleAgrees = irRole === page.role || (page.role === 'toc' && irRole === 'content')
    if (slide?.type !== undefined && slide.type !== '' && !roleAgrees) {
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
