import { z } from 'zod'
import { DshPptFailure } from '../engine/errors.ts'
import { describeIssues } from './fusion.ts'

/**
 * Asset-library contracts (V7.2 B2.5).
 *
 * Two libraries feed a deck without any AI: the **user** library (explicit
 * `asset-manifest.json` with licence/author per item) and the **office** library
 * (icons, clip art and themes discovered inside the local Office/WPS installation and
 * recorded as `office-assets.json`). Both are copy-in sources: the deck only ever
 * receives the files a caller explicitly copies, and a discovery that finds nothing
 * fails loudly instead of pretending the library exists.
 */

/** File name of a user library's manifest. */
export const USER_ASSET_MANIFEST = 'asset-manifest.json'

/** File name of the recorded office discovery. */
export const OFFICE_ASSETS_FILE = 'office-assets.json'

/**
 * Formats a library may offer. `thmx` and `potx` are Office theme/template
 * files: the local discovery records them under the `theme` category, and
 * `assets copy` treats them like any other library file.
 */
export const ASSET_FORMATS = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'emf', 'wmf', 'ico', 'thmx', 'potx'] as const
export type AssetFormat = (typeof ASSET_FORMATS)[number]

/** Categories an office discovery recognises. */
export const OFFICE_CATEGORIES = ['clip-art', 'icon', 'theme'] as const
export type OfficeCategory = (typeof OFFICE_CATEGORIES)[number]

/** @returns the asset format for a path, or null when the extension is not an asset format. */
export function formatOf(path: string): AssetFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  if (match === null) return null
  const extension = match[1]?.toLowerCase() ?? ''
  return (ASSET_FORMATS as readonly string[]).includes(extension) ? (extension as AssetFormat) : null
}

/** One item of a user library manifest. */
export interface UserAssetEntry {
  readonly id: string
  /** Path relative to the manifest's directory. */
  readonly file: string
  readonly source: 'user'
  readonly licence: string
  readonly author?: string
  readonly format?: AssetFormat
  readonly widthPx?: number
  readonly heightPx?: number
}

/** A user library manifest. */
export interface UserAssetManifest {
  readonly version: 1
  readonly assets: readonly UserAssetEntry[]
}

/** Zod schema for `asset-manifest.json`; unknown fields and missing licences are rejected. */
export const UserAssetManifestSchema = z.strictObject({
  version: z.literal(1),
  assets: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'id must be a lowercase slug'),
        file: z.string().min(1),
        source: z.literal('user'),
        licence: z.string().min(1, 'a user asset needs a licence'),
        author: z.string().min(1).optional(),
        format: z.enum(ASSET_FORMATS).optional(),
        widthPx: z.number().int().positive().optional(),
        heightPx: z.number().int().positive().optional(),
      }),
    )
    .min(1),
})

/** One officer-library root the discovery walked. */
export interface OfficeAssetRoot {
  readonly path: string
  readonly category: OfficeCategory
  /** Extension → file count, for the record's honesty about what was found. */
  readonly counts: Readonly<Record<string, number>>
}

/** One office asset the discovery recorded. */
export interface OfficeAssetEntry {
  readonly id: string
  /** Absolute path of the asset inside the installation. */
  readonly file: string
  readonly format: AssetFormat
  readonly category: OfficeCategory
}

/** The recorded office discovery. */
export interface OfficeAssetRecord {
  readonly version: 1
  readonly source: 'office'
  readonly discoveredAt: string
  readonly roots: readonly OfficeAssetRoot[]
  readonly assets: readonly OfficeAssetEntry[]
}

/** Zod schema for `office-assets.json`. */
export const OfficeAssetRecordSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal('office'),
  discoveredAt: z.string().min(1),
  roots: z.array(
    z.strictObject({
      path: z.string().min(1),
      category: z.enum(OFFICE_CATEGORIES),
      counts: z.record(z.string(), z.number().int().nonnegative()),
    }),
  ),
  assets: z.array(
    z.strictObject({
      id: z.string().min(1),
      file: z.string().min(1),
      format: z.enum(ASSET_FORMATS),
      category: z.enum(OFFICE_CATEGORIES),
    }),
  ),
})

/** A resolved library item, whichever source it came from. */
export interface ResolvedAsset {
  readonly id: string
  readonly source: 'office' | 'user'
  /** Absolute path of the file to copy. */
  readonly file: string
  readonly format: AssetFormat
  readonly category: string
  readonly licence: string
  readonly author?: string
  /** Absolute library root or discovery record the item was resolved from. */
  readonly root: string
}

/**
 * @param raw - parsed JSON of a user asset manifest.
 * @returns the validated manifest.
 * @throws DshPptFailure `ContractViolation` listing every field that is wrong.
 */
export function parseUserAssetManifest(raw: unknown): UserAssetManifest {
  const result = UserAssetManifestSchema.safeParse(raw)
  if (!result.success) {
    const messages = describeIssues(result.error.issues)
    throw new DshPptFailure('ContractViolation', `${USER_ASSET_MANIFEST} is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data as UserAssetManifest
}

/**
 * @param raw - parsed JSON of an office discovery record.
 * @returns the validated record.
 * @throws DshPptFailure `ContractViolation` listing every field that is wrong.
 */
export function parseOfficeAssetRecord(raw: unknown): OfficeAssetRecord {
  const result = OfficeAssetRecordSchema.safeParse(raw)
  if (!result.success) {
    const messages = describeIssues(result.error.issues)
    throw new DshPptFailure('ContractViolation', `${OFFICE_ASSETS_FILE} is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data as OfficeAssetRecord
}
