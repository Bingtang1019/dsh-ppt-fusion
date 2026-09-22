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
}

/** One page entry. A deep page must say why it is deep. */
export type FusionPage =
  | { readonly index: number; readonly route: 'pptwise' }
  | { readonly index: number; readonly route: 'ppt-master'; readonly deep: z.infer<typeof DeepPageSpecSchema> }

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

const PageSchema = z.discriminatedUnion('route', [
  z.strictObject({ index: z.number().int().positive(), route: z.literal('pptwise') }),
  z.strictObject({ index: z.number().int().positive(), route: z.literal('ppt-master'), deep: DeepPageSpecSchema }),
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
