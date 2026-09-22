import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative } from '../engine/contracts.ts'
import type { ImageOrientation, ImageProvider } from '../engine/contracts.ts'
import { assertPublicHttpUrl } from '../policy/url-policy.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'

/** One recorded image, as the engine's manifest item. */
export interface ImageSourceItem {
  readonly filename: string
  readonly provider: string
  readonly licenseName: string
  readonly licenseUrl: string | null
  readonly author: string | null
  readonly pageUrl: string | null
  readonly downloadUrl: string | null
  readonly requiresAttribution: boolean
  readonly attributionText: string
  readonly title?: string
}

/** Parameters for `dsh-ppt images search`. */
export interface ImagesSearchOptions {
  readonly dir: string
  readonly query: string
  readonly provider?: ImageProvider
  readonly orientation?: ImageOrientation
  readonly filename?: string
  readonly minWidth?: number
  readonly strictNoAttribution?: boolean
  /** Download directory, deck-relative; defaults to `assets`. */
  readonly output?: string
  /** Manifest path, deck-relative; defaults to `<output>/image_sources.json`. */
  readonly manifest?: string
  readonly saveCandidates?: boolean
  readonly maxCandidates?: number
  readonly fromUrl?: string
  readonly purpose?: string
  readonly slide?: number
  readonly deps: CommandDependencies
  /** DNS resolver seam for the URL policy, injected by tests. */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>
}

/** What one image search recorded. */
export interface ImagesSearchResult {
  readonly query: string
  readonly outputDir: string
  readonly manifestPath: string
  readonly items: readonly ImageSourceItem[]
}

/**
 * @param raw - one manifest item as the engine wrote it.
 * @returns the item in the fusion's field names.
 * @throws DshPptFailure `ContractViolation` when a required attribution field is absent.
 */
function readItem(raw: Record<string, unknown>, index: number): ImageSourceItem {
  const text = (key: string): string | null => (typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : null)
  const filename = text('filename')
  const provider = text('provider')
  const licenseName = text('license_name')
  const requiresAttribution = raw.attribution_required === true
  const attributionText = text('attribution_text')
  const missing = [
    filename === null ? 'filename' : null,
    provider === null ? 'provider' : null,
    licenseName === null ? 'license_name' : null,
    requiresAttribution && attributionText === null ? 'attribution_text' : null,
  ].filter((entry): entry is string => entry !== null)
  if (missing.length > 0) {
    throw new DshPptFailure('ContractViolation', `image manifest item ${String(index)} is missing ${missing.join(', ')}, so the image cannot be attributed`, {
      detail: { index, missing, item: raw },
    })
  }
  return {
    filename: filename ?? '',
    provider: provider ?? '',
    licenseName: licenseName ?? '',
    licenseUrl: text('license_url'),
    author: text('author'),
    pageUrl: text('source_page_url'),
    downloadUrl: text('download_url'),
    requiresAttribution,
    attributionText: attributionText ?? '',
    ...(text('title') === null ? {} : { title: text('title') as string }),
  }
}

/**
 * Search openly licensed images, record where each one came from, and prove the
 * attribution is complete.
 *
 * The engine owns the download and the manifest; this command owns the policy
 * (`--from-url` passes the same public-http guard as `source`), the default paths
 * (`assets/` and `assets/image_sources.json`) and the validation that every recorded
 * image carries the provenance the plan asks for. `--strict-no-attribution` is passed
 * through and re-checked here: a manifest item that still requires attribution fails.
 *
 * @param options - workspace, query, provider/filter options and paths.
 * @returns the recorded items and the manifest path.
 * @throws DshPptFailure `UsageError` for a refused `--from-url`, `OutputMissing` when
 *   the engine writes no manifest, and `ContractViolation` for incomplete attribution.
 */
export async function imagesSearch(options: ImagesSearchOptions): Promise<ImagesSearchResult> {
  if (options.query.trim() === '' && options.fromUrl === undefined) {
    throw new DshPptFailure('UsageError', 'images search needs a query, or --from-url for a directly selected image', { detail: {} })
  }
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const outputDir = toWorkspaceRelative(dir, resolve(dir, options.output ?? 'assets'))
  const manifestPath = toWorkspaceRelative(dir, resolve(dir, options.manifest ?? join(options.output ?? 'assets', 'image_sources.json')))
  fs.mkdirp(resolve(dir, outputDir))
  if (options.fromUrl !== undefined) {
    await assertPublicHttpUrl(options.fromUrl, options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost })
  }
  // The engine requires a filename in single-query mode; derive one from the query (or the
  // URL extension) so callers only have to name it when they care.
  const filename = options.filename ?? defaultFilename(options.query, options.fromUrl)
  engineFor(dir, options.deps).imageSearch({
    query: options.query,
    output: outputDir,
    manifest: manifestPath,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.orientation === undefined ? {} : { orientation: options.orientation }),
    filename,
    ...(options.minWidth === undefined ? {} : { minWidth: options.minWidth }),
    ...(options.strictNoAttribution === true ? { strictNoAttribution: true } : {}),
    ...(options.saveCandidates === true ? { saveCandidates: true } : {}),
    ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
    ...(options.fromUrl === undefined ? {} : { fromUrl: options.fromUrl }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.slide === undefined ? {} : { slide: options.slide }),
  })
  const text = fs.readText(resolve(dir, manifestPath))
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `image-search wrote no manifest at ${manifestPath}`, { detail: { manifest: manifestPath, query: options.query } })
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { manifest: manifestPath },
      cause: error,
    })
  }
  const rawItems = typeof payload === 'object' && payload !== null && Array.isArray((payload as { items?: unknown }).items) ? ((payload as { items: unknown[] }).items) : null
  if (rawItems === null) {
    throw new DshPptFailure('ContractViolation', `${manifestPath} has no items array`, { detail: { manifest: manifestPath } })
  }
  const items = rawItems.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new DshPptFailure('ContractViolation', `${manifestPath} items[${String(index)}] is not an object`, { detail: { manifest: manifestPath, index } })
    }
    return readItem(entry as Record<string, unknown>, index)
  })
  const unattributed = options.strictNoAttribution === true ? items.filter((item) => item.requiresAttribution || item.attributionText === '') : []
  if (unattributed.length > 0) {
    throw new DshPptFailure('ContractViolation', `--strict-no-attribution was requested but ${unattributed.map((item) => item.filename).join(', ')} still require attribution`, {
      detail: { files: unattributed.map((item) => item.filename) },
    })
  }
  return { query: options.query, outputDir, manifestPath, items }
}

/** @param query - search terms. @param fromUrl - optional direct URL. @returns a safe filename. */
function defaultFilename(query: string, fromUrl: string | undefined): string {
  const extension = fromUrl === undefined ? '.jpg' : (/.\w{2,4}$/.exec(new URL(fromUrl).pathname)?.[0] ?? '.jpg')
  const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `${slug === '' ? 'image' : slug}${extension}`
}

/**
 * @param result - an image search result.
 * @returns one attribution line per recorded image, plus the manifest path.
 */
export function formatImagesSearch(result: ImagesSearchResult): string {
  const lines = result.items.map((item) => `${item.filename}: ${item.attributionText === '' ? `${item.provider} / ${item.licenseName}` : item.attributionText}`)
  lines.push(`manifest ${result.manifestPath}`)
  return lines.join('\n')
}
