import { z } from 'zod'
import { DeepPageSpecSchema } from './deep-page.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { COMPAT_LEVELS } from '../compat/registry.ts'

/**
 * `deck.fusion.json`: the authoritative manifest for a fusion deck.
 *
 * The shape follows plan §3.1. Every page of the referenced pptwise IR is listed
 * exactly once; a page is either rendered by pptwise or declared deep and handed
 * to the ppt-master engine with an explicit reason.
 */
export interface FusionDeck {
  readonly version: 1
  readonly name: string
  /** Workspace-relative path of the pptwise IR file. */
  readonly pptwiseIr: string
  readonly theme: { readonly preset: string } | { readonly file: string }
  readonly pages: readonly FusionPage[]
  /** Compatibility target; the render flag overrides it (plan 3.14). */
  readonly compat?: z.infer<typeof CompatLevelSchema>
  readonly post?: {
    readonly animations?: string | null
    readonly narration?: null | { readonly provider: string; readonly voice?: string }
  }
  /** Deck-level chrome contract; absent keeps the legacy per-layout chrome. */
  readonly chrome?: FusionChrome
  /** Workspace-relative design profile whose fonts `render` applies after the merge. */
  readonly designProfile?: string
}

/** Roles the chrome contract names; v0.2's storyboard reuses this vocabulary. */
export const CHROME_ROLES = ['cover', 'section', 'content', 'data', 'quote', 'ending'] as const
export type ChromeRole = (typeof CHROME_ROLES)[number]

/** The four chrome anchors v0.1.2 allows (plan §3.2). */
export const CHROME_POSITIONS = ['footer-left', 'footer-right', 'header-left', 'header-right'] as const
export type ChromePosition = (typeof CHROME_POSITIONS)[number]

/** Styling selector: `tokens` follows the deck's exported theme tokens. */
export type ChromeStyle = 'tokens'

/** Deck-level chrome contract; absent means the deck keeps its legacy layout chrome. */
export interface FusionChrome {
  readonly pageNumber?: {
    readonly show?: boolean
    readonly skipRoles?: readonly ChromeRole[]
    readonly position?: ChromePosition
    readonly style?: ChromeStyle
  }
  readonly footer?: { readonly text: string; readonly position?: ChromePosition; readonly style?: ChromeStyle }
  readonly logo?: { readonly file: string; readonly position?: ChromePosition; readonly widthEmu?: number }
  readonly section?: { readonly position?: ChromePosition; readonly style?: ChromeStyle }
}

/** One page entry. A deep page must say why it is deep. */
export type FusionPage =
  | { readonly index: number; readonly route: 'pptwise'; readonly section?: string }
  | {
      readonly index: number
      readonly route: 'ppt-master'
      readonly deep: z.infer<typeof DeepPageSpecSchema>
      readonly section?: string
    }

const ThemeBindingSchema = z.union([
  z.strictObject({ preset: z.string().min(1) }),
  z.strictObject({ file: z.string().min(1) }),
])

const PostSchema = z.strictObject({
  animations: z.union([z.string().min(1), z.null()]).optional(),
  narration: z
    .union([z.null(), z.strictObject({ provider: z.string().min(1), voice: z.string().min(1).optional() })])
    .optional(),
})

const CompatLevelSchema = z.enum(COMPAT_LEVELS)

const ChromePositionSchema = z.enum(CHROME_POSITIONS)
const ChromeRoleSchema = z.enum(CHROME_ROLES)

/** `chrome` in `deck.fusion.json`; strict like the rest of the manifest. */
const ChromeSchema = z.strictObject({
  pageNumber: z
    .strictObject({
      show: z.boolean().optional(),
      skipRoles: z.array(ChromeRoleSchema).optional(),
      position: ChromePositionSchema.optional(),
      style: z.literal('tokens').optional(),
    })
    .optional(),
  footer: z
    .strictObject({ text: z.string().min(1), position: ChromePositionSchema.optional(), style: z.literal('tokens').optional() })
    .optional(),
  logo: z
    .strictObject({
      file: z.string().min(1),
      position: ChromePositionSchema.optional(),
      widthEmu: z.number().int().positive().optional(),
    })
    .optional(),
  section: z.strictObject({ position: ChromePositionSchema.optional(), style: z.literal('tokens').optional() }).optional(),
})

const PageSchema = z.discriminatedUnion('route', [
  z.strictObject({ index: z.number().int().positive(), route: z.literal('pptwise'), section: z.string().min(1).optional() }),
  z.strictObject({
    index: z.number().int().positive(),
    route: z.literal('ppt-master'),
    deep: DeepPageSpecSchema,
    section: z.string().min(1).optional(),
  }),
])

/** Zod schema for the manifest; unknown keys are rejected so typos fail loudly. */
export const FusionDeckSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'name must be a slug'),
  pptwiseIr: z.string().min(1),
  theme: ThemeBindingSchema,
  pages: z.array(PageSchema).min(1),
  compat: CompatLevelSchema.optional(),
  post: PostSchema.optional(),
  chrome: ChromeSchema.optional(),
  /**
   * Workspace-relative design profile (V7.2 B2). When present, `render` applies the
   * profile's font families to the merged package because pptwise's safe-font
   * allowlist cannot render them from the theme alone (ADR-066).
   */
  designProfile: z.string().min(1).optional(),
})

/**
 * Describe every schema violation on one line, prefixed with its field path.
 *
 * A manifest is hand-edited by a model, so the message has to name the exact
 * field: `pages[2].deep.kind: Invalid option`.
 *
 * @param issues - zod issues from a failed parse.
 * @returns one message per issue.
 */
export function describeIssues(issues: readonly { code: string; path: readonly PropertyKey[]; message: string; keys?: readonly string[] }[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.map((segment) => String(segment)).join('.')
    if (issue.code === 'unrecognized_keys' && issue.keys !== undefined) {
      return `${path}: unknown field ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}`
    }
    return `${path}: ${issue.message}`
  })
}

/**
 * Parse a `deck.fusion.json` document.
 *
 * @param raw - parsed JSON of the manifest.
 * @returns the validated manifest.
 * @throws DshPptFailure `ContractViolation` listing every field that is wrong.
 */
export function parseFusionDeck(raw: unknown): FusionDeck {
  const result = FusionDeckSchema.safeParse(raw)
  if (!result.success) {
    const messages = describeIssues(result.error.issues)
    throw new DshPptFailure('ContractViolation', `deck.fusion.json is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data as FusionDeck
}

/**
 * Check the manifest's internal consistency that a schema cannot express.
 *
 * @param deck - validated manifest.
 * @param slideCount - number of slides in the referenced IR.
 * @returns one message per violation; empty means consistent.
 */
export function checkPageCoverage(deck: FusionDeck, slideCount: number): string[] {
  const problems: string[] = []
  const indices = deck.pages.map((page) => page.index)
  const seen = new Set<number>()
  for (const index of indices) {
    if (seen.has(index)) problems.push(`pages lists index ${String(index)} more than once`)
    seen.add(index)
  }
  const expected = Array.from({ length: slideCount }, (_, offset) => offset + 1)
  const missing = expected.filter((index) => !seen.has(index))
  const extra = indices.filter((index) => index > slideCount)
  if (missing.length > 0) problems.push(`pages is missing index ${missing.join(', ')} (the IR has ${String(slideCount)} slides)`)
  if (extra.length > 0) problems.push(`pages lists index ${extra.join(', ')} but the IR has only ${String(slideCount)} slides`)
  const sorted = [...indices].sort((a, b) => a - b)
  if (sorted.some((value, offset) => value !== offset + 1)) {
    problems.push(`pages indices must be contiguous from 1; received ${indices.join(', ')}`)
  }
  return problems
}

/**
 * The chrome block a new deck starts from.
 *
 * Covers and endings skip page numbers, which is the plan's default; `init` writes
 * it so a fresh deck never falls back to whatever chrome a layout happens to draw.
 *
 * @returns a chrome declaration that passes `FusionDeckSchema`.
 */
export function defaultChrome(): FusionChrome {
  return {
    pageNumber: { show: true, skipRoles: ['cover', 'ending'], position: 'footer-right', style: 'tokens' },
  }
}

/** Content kinds that make a content slide a data page rather than prose. */
const DATA_KINDS = new Set(['data', 'evidence', 'fact', 'stat', 'stats', 'chart', 'charts', 'table', 'kpi', 'metric', 'metrics', 'numbers'])

/** Content kinds that make a content slide a quotation. */
const QUOTE_KINDS = new Set(['statement', 'quote'])

/**
 * Map a pptwise IR slide onto the chrome role vocabulary.
 *
 * The top-level `type` carries the deck's coarse structure; a `content` slide's
 * `kind` decides whether the page behaves like prose, data or a quote. One mapping
 * serves the chrome skip rule and the storyboard's role requirement, so the two
 * can never disagree (V6 WP2).
 *
 * @param slideType - the IR slide's `type`, when it has one.
 * @param slideKind - the IR slide's `kind`, when it has one.
 * @returns the matching role; anything unknown is `content`, which is never skipped.
 */
export function chromeRoleFor(slideType: string | undefined, slideKind?: string): ChromeRole {
  switch (slideType) {
    case 'cover':
      return 'cover'
    case 'section':
    case 'chapter':
      return 'section'
    case 'quote':
      return 'quote'
    case 'ending':
      return 'ending'
    case 'data':
    case 'evidence':
    case 'chart':
    case 'table':
      return 'data'
    default: {
      const kind = slideKind?.toLowerCase() ?? ''
      if (DATA_KINDS.has(kind)) return 'data'
      if (QUOTE_KINDS.has(kind)) return 'quote'
      return 'content'
    }
  }
}

/**
 * @param chrome - the deck's chrome block, when declared.
 * @param role - role of the page being rendered.
 * @returns whether the page-number contract skips this page.
 */
export function isPageNumberSkipped(chrome: FusionChrome | undefined, role: ChromeRole): boolean {
  const pageNumber = chrome?.pageNumber
  if (pageNumber === undefined || pageNumber.show === false) return true
  return (pageNumber.skipRoles ?? []).includes(role)
}
