import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative } from '../engine/contracts.ts'
import { imageGenCredentials } from '../engine/contracts.ts'
import type { ImageGenProvider, ImageOrientation, ImageProvider } from '../engine/contracts.ts'
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
  readonly minHeight?: number
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

/** Environment switch that enables the optional image-generation extension (V7.2 B5.5). */
export const IMAGE_GEN_FLAG = 'DSH_PPT_ENABLE_IMAGE_GEN'

/** Asset fallback order printed when generation is disabled or unavailable. */
export const IMAGE_GEN_FALLBACK = ['svg', 'user', 'office (when discovered)', 'flat', 'photo (dsh-ppt images search)'] as const

/** Options for `dsh-ppt images generate` (V7.2 B5.5). */
export interface ImagesGenerateOptions {
  /** Deck workspace. */
  readonly dir: string
  readonly prompt: string
  readonly provider: ImageGenProvider
  /** Output directory, deck-relative; defaults to `assets`. */
  readonly output?: string
  /** File name inside the output directory; defaults to `ai-<slug>.png`. */
  readonly filename?: string
  readonly aspectRatio?: string
  readonly imageSize?: string
  /** Free-text purpose recorded in the manifest. */
  readonly purpose?: string
  readonly slide?: number
  readonly deps: CommandDependencies
}

/** What one generation produced and recorded. */
export interface ImagesGenerateResult {
  /** Actual file written, deck-relative. */
  readonly outputFile: string
  readonly provider: string
  readonly bytes: number
  readonly width: number | null
  readonly height: number | null
  /** Provenance manifest, deck-relative. */
  readonly manifestPath: string
  /** Summary of the prompt recorded in the manifest. */
  readonly promptSummary: string
}

/** @param prompt - generation prompt. @returns a lowercase slug for the default file name. */
function promptSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug === '' ? 'image' : slug
}

/** @param dir - absolute output directory. @param stem - file stem. @param fs - filesystem port. @returns the produced file name, or null. */
function findGeneratedFile(dir: string, stem: string, fs: CommandDependencies['fs']): string | null {
  if (!fs.isDirectory(dir)) return null
  const candidates = fs.listDir(dir).filter((name) => name.startsWith(`${stem}.`)).sort()
  return candidates.find((name) => /\.(?:png|jpe?g|webp)$/i.test(name)) ?? candidates[0] ?? null
}

/**
 * Generate one image through the optional engine extension and record its provenance.
 *
 * Disabled by default: without `DSH_PPT_ENABLE_IMAGE_GEN=1` the command refuses and
 * prints the asset fallback order instead of reaching the engine. When enabled it
 * requires the provider's key and passes only that provider's environment knobs to
 * the child (ADR-064; ADR-013's exclusion is narrowed only here). Every successful
 * image is recorded in `<output>/image_sources.json` with `provider: ai-image-*`,
 * the prompt summary, size and the review note; a generated file without that record
 * is never returned.
 *
 * @param options - workspace, prompt, provider, output paths and dependencies.
 * @returns the written image and its provenance record.
 * @throws DshPptFailure `ContractViolation` when the extension is disabled or the
 *   manifest cannot be written, `UsageError` when the provider key is absent,
 *   `OutputMissing` when the engine exits without a readable image.
 */
export async function imagesGenerate(options: ImagesGenerateOptions): Promise<ImagesGenerateResult> {
  const { deps } = options
  if (deps.env[IMAGE_GEN_FLAG] !== '1') {
    throw new DshPptFailure('ContractViolation', `image generation is disabled; set ${IMAGE_GEN_FLAG}=1 to use this optional extension. Asset fallback order: ${IMAGE_GEN_FALLBACK.join(' → ')}`, {
      detail: { flag: IMAGE_GEN_FLAG, enabled: false, fallback: [...IMAGE_GEN_FALLBACK] },
    })
  }
  const keyName = options.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'
  if ((deps.env[keyName] ?? '').trim() === '') {
    throw new DshPptFailure('UsageError', `${keyName} is not set, so the ${options.provider} image backend cannot run; export the key or fall back to ${IMAGE_GEN_FALLBACK.join(' → ')}`, {
      detail: { env: keyName, provider: options.provider, fallback: [...IMAGE_GEN_FALLBACK] },
    })
  }
  const dir = resolveDeckDir(deps, options.dir)
  const outputRel = toWorkspaceRelative(dir, resolve(dir, options.output ?? 'assets'))
  const outputDir = resolve(dir, outputRel)
  const filename = options.filename ?? `ai-${promptSlug(options.prompt)}.png`
  if (!/\.(?:png|jpe?g|webp)$/i.test(filename)) {
    throw new DshPptFailure('ContractViolation', `image filename must end in .png, .jpg, .jpeg or .webp: ${filename}`, { detail: { filename } })
  }
  deps.fs.mkdirp(outputDir)
  engineFor(dir, deps).imageGenerate(
    {
      prompt: options.prompt,
      provider: options.provider,
      output: outputRel,
      filename,
      ...(options.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio }),
      ...(options.imageSize === undefined ? {} : { imageSize: options.imageSize }),
    },
    { credentials: imageGenCredentials(options.provider) },
  )
  const stem = filename.replace(/\.[^.]+$/, '')
  const produced = findGeneratedFile(outputDir, stem, deps.fs)
  if (produced === null) {
    throw new DshPptFailure('OutputMissing', `image generation reported success but wrote no ${stem}.* under ${outputRel}`, { detail: { output: outputRel, filename } })
  }
  const bytes = deps.fs.readBytes(join(outputDir, produced))
  if (bytes === null || bytes.length === 0) {
    throw new DshPptFailure('OutputMissing', `the generated image is unreadable: ${outputRel}/${produced}`, { detail: { output: outputRel, filename: produced } })
  }
  let width: number | null = null
  let height: number | null = null
  try {
    const { default: sharp } = await import('sharp')
    const metadata = await sharp(bytes).metadata()
    width = metadata.width ?? null
    height = metadata.height ?? null
  } catch {
    // Metadata is optional provenance; a format sharp cannot read still ships.
  }
  const manifestPath = join(outputRel, 'image_sources.json').replace(/\\/g, '/')
  const manifestFile = resolve(dir, manifestPath)
  const promptSummary = options.prompt.trim().slice(0, 200)
  const provider = `ai-image-${options.provider}`
  const item = {
    filename: produced,
    slide: options.slide === undefined ? '' : String(options.slide),
    purpose: options.purpose ?? '',
    prompt: promptSummary,
    provider,
    stage: 'generate',
    title: promptSummary,
    author: provider,
    source_page_url: '',
    download_url: '',
    license_name: 'AI-generated content (review required)',
    license_url: '',
    license_tier: 'generated',
    attribution_required: true,
    width,
    height,
    attribution_text: `${produced} — ${provider} 生成内容，需人工复核后使用`,
    selection_method: 'generated',
    status: 'generated',
  }
  const existing = deps.fs.readText(manifestFile)
  let document: { items: unknown[] } = { items: [] }
  if (existing !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(existing)
    } catch (error) {
      throw new DshPptFailure('ContractViolation', `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { detail: { manifest: manifestPath }, cause: error })
    }
    const items = (parsed as { items?: unknown }).items
    if (!Array.isArray(items)) throw new DshPptFailure('ContractViolation', `${manifestPath} has no items array; refusing to overwrite it`, { detail: { manifest: manifestPath } })
    document = { items }
  }
  const kept = document.items.filter((entry) => (entry as { filename?: unknown }).filename !== produced)
  deps.fs.writeText(manifestFile, `${JSON.stringify({ items: [...kept, item], generated_at: new Date().toISOString() }, null, 2)}\n`)
  return { outputFile: join(outputRel, produced).replace(/\\/g, '/'), provider, bytes: bytes.length, width, height, manifestPath, promptSummary }
}

/**
 * @param result - one generation.
 * @returns the human-readable line the CLI prints without `--json`.
 */
export function formatImagesGenerate(result: ImagesGenerateResult): string {
  const size = result.width === null || result.height === null ? 'unknown size' : `${String(result.width)}x${String(result.height)}`
  return `${result.outputFile}: ${result.provider} ${size}, provenance in ${result.manifestPath} (review before publishing)`
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
  // The zero-config providers are unreachable from some networks; a keyed provider is then
  // the only working path, so its key must reach the engine child.
  engineFor(dir, options.deps).imageSearch(
    {
      query: options.query,
      output: outputDir,
      manifest: manifestPath,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.orientation === undefined ? {} : { orientation: options.orientation }),
      filename,
      ...(options.minWidth === undefined ? {} : { minWidth: options.minWidth }),
      ...(options.minHeight === undefined ? {} : { minHeight: options.minHeight }),
      ...(options.strictNoAttribution === true ? { strictNoAttribution: true } : {}),
      ...(options.saveCandidates === true ? { saveCandidates: true } : {}),
      ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
      ...(options.fromUrl === undefined ? {} : { fromUrl: options.fromUrl }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.slide === undefined ? {} : { slide: options.slide }),
    },
    { credentials: ['PEXELS_API_KEY', 'PIXABAY_API_KEY', 'IMAGE_SEARCH_CONCURRENCY'] },
  )
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
