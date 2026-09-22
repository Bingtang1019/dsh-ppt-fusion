import { z } from 'zod'
import { join } from 'node:path'
import { SLIDE_FORMATS, type SlideFormat } from '../engine/contracts.ts'

/**
 * Why a page needs the deep engine.
 *
 * This is the fusion's own vocabulary, derived from the routing table in plan
 * §3.3: each kind names the PowerPoint object the page exists to produce.
 */
export const DEEP_PAGE_KINDS = ['native-chart', 'native-table', 'formula', 'freeform', 'template-mirror'] as const

/** A deep page's reason for existing. */
export type DeepPageKind = (typeof DEEP_PAGE_KINDS)[number]

/**
 * Files a deep page directory must contain before the engine is allowed to run.
 *
 * `page.svg` is the authored page. Anything else a given kind needs (a chart
 * payload, a template materialisation output) is produced by the M3/M5 wrappers
 * inside the same directory, so only the authored file is required up front.
 */
export const REQUIRED_DEEP_FILES: readonly string[] = ['page.svg']

/** One deep page's declaration inside the manifest. */
export interface DeepPageSpec {
  /** Directory holding the page, relative to the deck workspace. */
  readonly dir: string
  readonly kind: DeepPageKind
  readonly format: SlideFormat
}

/** Zod schema for a deep page declaration. */
export const DeepPageSpecSchema = z.strictObject({
  dir: z.string().min(1),
  kind: z.enum(DEEP_PAGE_KINDS),
  format: z.enum(SLIDE_FORMATS),
})

/**
 * @param workspace - absolute deck workspace.
 * @param spec - deep page declaration.
 * @returns absolute paths of the files that must exist for this page to render.
 */
export function requiredDeepFiles(workspace: string, spec: DeepPageSpec): string[] {
  return REQUIRED_DEEP_FILES.map((name) => join(workspace, spec.dir, name))
}

/**
 * @param workspace - absolute deck workspace.
 * @param spec - deep page declaration.
 * @param exists - filesystem predicate, injected so this stays pure.
 * @returns absolute paths that are required but absent.
 */
export function missingDeepFiles(workspace: string, spec: DeepPageSpec, exists: (path: string) => boolean): string[] {
  return requiredDeepFiles(workspace, spec).filter((path) => !exists(path))
}
