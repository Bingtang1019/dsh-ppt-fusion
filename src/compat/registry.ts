import { z } from 'zod'
import { DshPptFailure } from '../engine/errors.ts'
import registryJson from './registry.json'

/**
 * The compatibility policy in machine-readable form: one entry per version-sensitive
 * marker (marker XPath, lowest Office release, WPS support, whether an MCE fallback is
 * required, and the registered downgrade), plus the three levels the plan defines
 * (plan §3.14, contracts §8).
 *
 * The JSON is imported so the bundler inlines it: `dist/cli.js` cannot lose the
 * registry on a user machine.
 */

/** Levels `--compat` accepts, weakest target first. */
export const COMPAT_LEVELS = ['safe', 'standard', 'max'] as const

/** One compatibility target level. */
export type CompatLevel = (typeof COMPAT_LEVELS)[number]

const FeatureSchema = z.strictObject({
  feature: z.string().min(1),
  namespace: z.string().min(1),
  marker: z.string().min(1),
  minOffice: z.number().int(),
  wpsSupport: z.enum(['required', 'tolerated', 'partial', 'ignored', 'unverified']),
  mceFallbackRequired: z.boolean(),
  downgradeTo: z.string().min(1).nullable(),
  requiresPngSibling: z.boolean().optional(),
  measured: z.strictObject({ presentIn: z.string(), note: z.string() }).optional(),
})

const LevelSchema = z.strictObject({
  label: z.string().min(1),
  minOffice: z.number().int(),
  allows: z.array(z.string().min(1)),
  forbids: z.array(z.string().min(1)),
  notes: z.string().min(1),
})

/** Schema of `src/compat/registry.json`. */
export const CompatRegistrySchema = z.strictObject({
  schema: z.literal('dsh-ppt-fusion.compat-registry.v1'),
  version: z.number().int().positive(),
  measuredAt: z.string().min(1),
  measuredBy: z.string().min(1),
  levels: z.record(z.enum(COMPAT_LEVELS), LevelSchema),
  features: z.array(FeatureSchema),
  unverifiedOnThisMachine: z.array(z.string()),
})

/** One registry entry. */
export type CompatFeature = z.infer<typeof FeatureSchema>

/** One level's allowance list. */
export type CompatLevelSpec = z.infer<typeof LevelSchema>

/** The whole registry. */
export type CompatRegistry = z.infer<typeof CompatRegistrySchema>

/**
 * @param raw - parsed JSON of `registry.json`.
 * @returns the validated registry.
 * @throws DshPptFailure `ContractViolation` naming every field that is wrong.
 */
export function parseCompatRegistry(raw: unknown): CompatRegistry {
  const result = CompatRegistrySchema.safeParse(raw)
  if (!result.success) {
    const messages = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new DshPptFailure('ContractViolation', `compat registry is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data
}

let cached: CompatRegistry | null = null

/** @returns the bundled registry, validated once. */
export function loadCompatRegistry(): CompatRegistry {
  cached ??= parseCompatRegistry(registryJson)
  return cached
}

/**
 * @param level - value from `--compat` or the manifest.
 * @returns the level, or null when the value is not one of `COMPAT_LEVELS`.
 */
export function asCompatLevel(level: string): CompatLevel | null {
  return (COMPAT_LEVELS as readonly string[]).includes(level) ? (level as CompatLevel) : null
}

/**
 * @param registry - loaded registry.
 * @param feature - feature name.
 * @returns the registry entry.
 * @throws DshPptFailure `ContractViolation` when the registry does not list the feature,
 *   because the compat pass never invents policy for a marker it does not know.
 */
export function requireFeature(registry: CompatRegistry, feature: string): CompatFeature {
  const entry = registry.features.find((candidate) => candidate.feature === feature)
  if (entry === undefined) {
    throw new DshPptFailure('ContractViolation', `the compat registry has no feature named ${feature}`, { detail: { feature } })
  }
  return entry
}

/**
 * Rank an Office release label for comparison.
 *
 * `registry.json` writes the Microsoft 365 level as `365`; ranking it numerically
 * against the year-numbered releases would sort it below Office 2010.
 *
 * @param release - a `minOffice` value from the registry.
 * @returns a comparable rank.
 */
export function officeRank(release: number): number {
  return release === 365 ? 99 : release >= 2000 ? release - 2000 : release
}

/**
 * @param registry - loaded registry.
 * @param level - target level.
 * @param feature - registry entry.
 * @returns true when the level's Office release understands the marker and the level
 *   does not forbid it; false means a registered downgrade (or a refusal) is required.
 */
export function levelAllows(registry: CompatRegistry, level: CompatLevel, feature: CompatFeature): boolean {
  const spec = registry.levels[level]
  return officeRank(feature.minOffice) <= officeRank(spec.minOffice) && !spec.forbids.includes(feature.feature)
}
