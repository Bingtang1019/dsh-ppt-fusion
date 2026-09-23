import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assertInsideWorkspace, toWorkspaceRelative } from '../engine/contracts.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { resolveDshHome, type FileSystemPort } from '../engine/venv.ts'
import {
  ASSET_FORMATS,
  OFFICE_ASSETS_FILE,
  OFFICE_CATEGORIES,
  USER_ASSET_MANIFEST,
  formatOf,
  parseOfficeAssetRecord,
  parseUserAssetManifest,
  type AssetFormat,
  type OfficeAssetEntry,
  type OfficeAssetRecord,
  type OfficeAssetRoot,
  type OfficeCategory,
  type ResolvedAsset,
} from '../schema/assets.ts'
import { resolveDeckDir, type CommandDependencies } from './context.ts'

/**
 * `dsh-ppt assets`: register and copy the machine-local asset libraries
 * (V7.2 B2.5).
 *
 * Two channels are file-based and AI-free. `office` probes the asset directories
 * shipped with the installed Office/WPS on this machine, records them in
 * `office-assets.json` and copies files out of that record. `user` reads explicit
 * libraries named by `DSH_PPT_ASSET_DIRS` or the deck's own `assets/` directory,
 * each carrying `asset-manifest.json` so every item keeps a licence record. A
 * discovery or list that finds nothing fails loudly with a fallback path instead
 * of pretending the library exists.
 */

/** Licence stamped on office assets; the Office EULA covers their use in documents. */
export const OFFICE_ASSET_LICENCE = 'Microsoft Office built-in content (Office EULA applies)'

/** Asset formats each office category may contribute. */
const CATEGORY_FORMATS: Readonly<Record<OfficeCategory, readonly AssetFormat[]>> = {
  'clip-art': ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'emf', 'wmf', 'ico'],
  icon: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'emf', 'wmf', 'ico'],
  theme: ['thmx', 'potx'],
}

/** One directory the office discovery probes. */
export interface OfficeRootCandidate {
  /** Absolute directory; a missing directory is recorded with no counts. */
  readonly path: string
  readonly category: OfficeCategory
}

/** Options for `dsh-ppt assets discover --source office`. */
export interface DiscoverOfficeAssetsOptions {
  /** Deck workspace a relative `output` resolves against; defaults to the process cwd. */
  readonly dir?: string
  /** Record path, absolute or resolved against `dir`; defaults to the DSH home cache. */
  readonly output?: string
  /** Probe list; defaults to {@link officeRootCandidates}. Tests and WPS installs override it. */
  readonly roots?: readonly OfficeRootCandidate[]
  /** Recursion limit per root; defaults to 6. */
  readonly maxDepth?: number
  /** Clock seam for `discoveredAt`; defaults to the wall clock. */
  readonly now?: () => Date
  readonly deps: CommandDependencies
}

/** What one office discovery wrote. */
export interface DiscoverOfficeAssetsResult {
  readonly recordFile: string
  readonly record: OfficeAssetRecord
}

/** Options for `dsh-ppt assets list`. */
export interface AssetsListOptions {
  readonly source: 'office' | 'user'
  /** Deck workspace; the `<deck>/assets` user root and a relative `record` resolve against it. */
  readonly dir?: string
  /** Office record override, absolute or resolved against `dir`. */
  readonly record?: string
  /** Office category filter. */
  readonly category?: OfficeCategory
  /** Format filter. */
  readonly format?: AssetFormat
  readonly deps: CommandDependencies
}

/** What one listing resolved. */
export interface AssetsListResult {
  readonly source: 'office' | 'user'
  /** Directories (user) or probed roots (office) the items came from. */
  readonly roots: readonly string[]
  /** Office discovery record the items were read from. */
  readonly recordFile?: string
  readonly items: readonly ResolvedAsset[]
}

/** Options for `dsh-ppt assets copy`. */
export interface AssetCopyOptions {
  readonly source: 'office' | 'user'
  /** Library item id, as `assets list` prints it. */
  readonly id: string
  readonly dir?: string
  /** Target directory inside the deck; defaults to `assets`. */
  readonly output?: string
  /** Target file name; defaults to `<id>.<format>` and must keep that extension. */
  readonly as?: string
  /** Overwrite an existing different file instead of refusing. */
  readonly force?: boolean
  readonly record?: string
  readonly deps: CommandDependencies
}

/** What one copy produced. */
export interface AssetCopyResult {
  readonly id: string
  readonly source: 'office' | 'user'
  /** Absolute source path. */
  readonly file: string
  /** Absolute destination path. */
  readonly outputFile: string
  /** Destination path relative to the deck, slash-separated. */
  readonly relative: string
  readonly bytes: number
  /** True when an existing file with different bytes was overwritten. */
  readonly replaced: boolean
  /** True when the destination already held identical bytes; nothing was written. */
  readonly unchanged: boolean
}

/**
 * @param env - environment to read (`ProgramFiles`, `APPDATA`, `DSH_PPT_OFFICE_ROOTS`).
 * @returns the office roots to probe, custom entries first. Office ships clip art
 *   and themes as files; the modern icon gallery is cloud-hosted, so the `icon`
 *   category only appears through `DSH_PPT_OFFICE_ROOTS=icon=<dir>`.
 * @throws DshPptFailure `ContractViolation` for a malformed custom entry.
 */
export function officeRootCandidates(env: NodeJS.ProcessEnv): readonly OfficeRootCandidate[] {
  const candidates: OfficeRootCandidate[] = []
  const seen = new Set<string>()
  const add = (path: string | undefined, category: OfficeCategory): void => {
    if (path === undefined || path === '') return
    if (seen.has(path)) return
    seen.add(path)
    candidates.push({ path, category })
  }
  const custom = env.DSH_PPT_OFFICE_ROOTS
  if (custom !== undefined && custom.trim() !== '') {
    for (const raw of custom.split(delimiter)) {
      const entry = raw.trim()
      if (entry === '') continue
      const separator = entry.indexOf('=')
      const category = separator === -1 ? 'clip-art' : entry.slice(0, separator)
      const path = separator === -1 ? entry : entry.slice(separator + 1)
      if (!(OFFICE_CATEGORIES as readonly string[]).includes(category) || path === '') {
        throw new DshPptFailure('ContractViolation', `DSH_PPT_OFFICE_ROOTS entry "${entry}" must be <path> or <category>=<path> with a category of ${OFFICE_CATEGORIES.join(', ')}`, {
          detail: { entry },
        })
      }
      add(path, category as OfficeCategory)
    }
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
  const programFilesX86 = env['ProgramFiles(x86)']
  const appData = env.APPDATA
  if (programFiles !== undefined && programFiles !== '') {
    add(join(programFiles, 'Microsoft Office', 'root', 'CLIPART'), 'clip-art')
    add(join(programFiles, 'Microsoft Office', 'root', 'Office16', 'MEDIA'), 'clip-art')
    add(join(programFiles, 'Microsoft Office', 'root', 'Templates'), 'theme')
  }
  if (programFilesX86 !== undefined && programFilesX86 !== '' && programFilesX86 !== programFiles) {
    add(join(programFilesX86, 'Microsoft Office', 'root', 'CLIPART'), 'clip-art')
  }
  if (appData !== undefined && appData !== '') {
    add(join(appData, 'Microsoft', 'Templates', 'LiveContent'), 'theme')
    add(join(appData, 'Kingsoft', 'office6', 'templates'), 'theme')
    add(join(appData, 'Kingsoft', 'office6', 'res'), 'clip-art')
  }
  return candidates
}

/**
 * @param deps - command dependencies.
 * @param output - explicit record path, or undefined for the default.
 * @param dir - base a relative `output` resolves against.
 * @returns the absolute `office-assets.json` path: the explicit argument, or
 *   `<DSH_HOME>/ppt-fusion/assets/office-assets.json`.
 */
export function officeRecordPath(deps: CommandDependencies, output?: string, dir?: string): string {
  if (output !== undefined && output !== '') {
    const base = resolveDeckDir(deps, dir ?? '.')
    return isAbsolute(output) ? resolve(output) : resolve(base, output)
  }
  return join(resolveDshHome(deps.env), 'ppt-fusion', 'assets', OFFICE_ASSETS_FILE)
}

/** One file the walker accepted. */
interface WalkedFile {
  readonly path: string
  /** Path relative to the probed root, used for the id slug. */
  readonly relative: string
  readonly format: AssetFormat
}

/** What one root walk found. */
interface WalkedRoot {
  readonly counts: Readonly<Record<string, number>>
  readonly files: readonly WalkedFile[]
}

/**
 * @param fs - filesystem port.
 * @param root - directory to walk; a missing directory yields nothing.
 * @param category - category whose allowed formats the walker keeps.
 * @param maxDepth - recursion limit below the root.
 * @returns the supported files and the per-format counts.
 */
function walkRoot(fs: FileSystemPort, root: string, category: OfficeCategory, maxDepth: number): WalkedRoot {
  if (!fs.isDirectory(root)) return { counts: {}, files: [] }
  const allowed = CATEGORY_FORMATS[category]
  const counts: Record<string, number> = {}
  const files: WalkedFile[] = []
  const visit = (dir: string, depth: number): void => {
    for (const name of [...fs.listDir(dir)].sort()) {
      const path = join(dir, name)
      if (fs.isDirectory(path)) {
        if (depth < maxDepth) visit(path, depth + 1)
        continue
      }
      const format = formatOf(name)
      if (format === null || !allowed.includes(format)) continue
      counts[format] = (counts[format] ?? 0) + 1
      files.push({ path, relative: relative(root, path), format })
    }
  }
  visit(root, 0)
  return { counts, files }
}

/**
 * @param value - a relative path.
 * @returns a lowercase slug for the asset id.
 */
function slugOf(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug === '' ? 'asset' : slug
}

/**
 * Probe the local Office/WPS asset roots and write `office-assets.json`.
 *
 * Every candidate is recorded with its per-format counts, including candidates
 * whose directory is missing; only supported files become assets. A discovery
 * that finds no file at all fails instead of writing an empty record, so callers
 * fall back to `svg`, `user` or `flat` backgrounds.
 *
 * @param options - probe list, record path, depth and dependencies.
 * @returns the written record path and the record.
 * @throws DshPptFailure `OutputMissing` when no candidate holds an asset file,
 *   `ContractViolation` for a malformed `DSH_PPT_OFFICE_ROOTS` entry.
 */
export function discoverOfficeAssets(options: DiscoverOfficeAssetsOptions): DiscoverOfficeAssetsResult {
  const { deps } = options
  const fs = deps.fs
  const dir = resolveDeckDir(deps, options.dir ?? '.')
  const candidates = options.roots ?? officeRootCandidates(deps.env)
  const maxDepth = options.maxDepth ?? 6
  const roots: OfficeAssetRoot[] = []
  const walked: { entry: WalkedFile; category: OfficeCategory }[] = []
  for (const candidate of candidates) {
    const result = walkRoot(fs, candidate.path, candidate.category, maxDepth)
    roots.push({ path: candidate.path, category: candidate.category, counts: result.counts })
    for (const file of result.files) walked.push({ entry: file, category: candidate.category })
  }
  if (walked.length === 0) {
    throw new DshPptFailure(
      'OutputMissing',
      `no Office or WPS asset files were found under ${String(candidates.length)} probed root(s); use the svg, user or flat background sources, or point DSH_PPT_OFFICE_ROOTS at an installed asset directory`,
      { detail: { roots: candidates.map((candidate) => candidate.path) } },
    )
  }
  walked.sort((left, right) => compareText(left.entry.path, right.entry.path))
  const used = new Set<string>()
  const assets: OfficeAssetEntry[] = walked.map(({ entry, category }) => {
    const base = `${category}-${slugOf(entry.relative)}`
    let id = base
    let index = 2
    while (used.has(id)) {
      id = `${base}-${String(index)}`
      index += 1
    }
    used.add(id)
    return { id, file: entry.path, format: entry.format, category }
  })
  const record: OfficeAssetRecord = {
    version: 1,
    source: 'office',
    discoveredAt: (options.now?.() ?? new Date()).toISOString(),
    roots,
    assets,
  }
  const recordFile = officeRecordPath(deps, options.output, dir)
  fs.mkdirp(dirname(recordFile))
  fs.writeText(recordFile, `${JSON.stringify(record, null, 2)}\n`)
  return { recordFile, record }
}

/**
 * @param dir - deck workspace.
 * @param deps - command dependencies.
 * @returns the user library roots: every `DSH_PPT_ASSET_DIRS` entry (in order)
 *   plus `<deck>/assets` when that directory carries a manifest.
 */
export function userAssetRoots(dir: string, deps: CommandDependencies): readonly string[] {
  const roots: string[] = []
  for (const raw of (deps.env.DSH_PPT_ASSET_DIRS ?? '').split(delimiter)) {
    const entry = raw.trim()
    if (entry === '') continue
    roots.push(isAbsolute(entry) ? resolve(entry) : resolve(dir, entry))
  }
  const deckAssets = join(dir, 'assets')
  if (deps.fs.isDirectory(deckAssets) && deps.fs.exists(join(deckAssets, USER_ASSET_MANIFEST))) roots.push(deckAssets)
  return [...new Set(roots)]
}

/**
 * @param text - file contents.
 * @param path - file the contents came from, for the message.
 * @returns the parsed JSON document.
 * @throws DshPptFailure `ContractViolation` when the text is not valid JSON.
 */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { path },
      cause: error,
    })
  }
}

/**
 * @param root - absolute user library directory.
 * @param deps - command dependencies.
 * @returns the validated items of one user library.
 * @throws DshPptFailure `ContractViolation` when the manifest is absent, invalid,
 *   lists an unsupported or escaping file, or repeats an id; `OutputMissing` when
 *   a listed file is absent.
 */
function readUserLibrary(root: string, deps: CommandDependencies): readonly ResolvedAsset[] {
  const fs = deps.fs
  const manifestPath = join(root, USER_ASSET_MANIFEST)
  const text = fs.readText(manifestPath)
  if (text === null) {
    throw new DshPptFailure('ContractViolation', `${root} has no ${USER_ASSET_MANIFEST}; a user asset library must record a licence per item`, {
      detail: { root, manifest: manifestPath },
    })
  }
  const manifest = parseUserAssetManifest(parseJson(text, manifestPath))
  const items: ResolvedAsset[] = []
  const ids = new Set<string>()
  for (const entry of manifest.assets) {
    if (ids.has(entry.id)) {
      throw new DshPptFailure('ContractViolation', `${manifestPath} repeats asset id "${entry.id}"`, { detail: { manifest: manifestPath, id: entry.id } })
    }
    ids.add(entry.id)
    const file = resolve(root, entry.file)
    const inside = relative(root, file)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new DshPptFailure('ContractViolation', `${manifestPath} entry "${entry.id}" points outside the library: ${entry.file}`, {
        detail: { manifest: manifestPath, id: entry.id, file: entry.file },
      })
    }
    const format = formatOf(file)
    if (format === null) {
      throw new DshPptFailure('ContractViolation', `${manifestPath} entry "${entry.id}" has an unsupported format: ${entry.file}`, {
        detail: { manifest: manifestPath, id: entry.id, file: entry.file },
      })
    }
    if (entry.format !== undefined && entry.format !== format) {
      throw new DshPptFailure('ContractViolation', `${manifestPath} entry "${entry.id}" declares format ${entry.format} but the file is ${format}`, {
        detail: { manifest: manifestPath, id: entry.id, declared: entry.format, actual: format },
      })
    }
    if (!fs.exists(file) || fs.isDirectory(file)) {
      throw new DshPptFailure('OutputMissing', `${manifestPath} entry "${entry.id}" lists a file that is absent: ${file}`, {
        detail: { manifest: manifestPath, id: entry.id, file },
      })
    }
    items.push({
      id: entry.id,
      source: 'user',
      file,
      format,
      category: 'user',
      licence: entry.licence,
      root,
      ...(entry.author === undefined ? {} : { author: entry.author }),
    })
  }
  return items
}

/**
 * List the items of one library source.
 *
 * @param options - source, workspace, record override and filters.
 * @returns the resolved items, their roots and (for office) the record path.
 * @throws DshPptFailure `UsageError` for a bad filter, `OutputMissing` when the
 *   office record or the user library is absent, `ContractViolation` when a
 *   document is invalid or two libraries share an id.
 */
export function listAssets(options: AssetsListOptions): AssetsListResult {
  const { deps } = options
  const fs = deps.fs
  const dir = resolveDeckDir(deps, options.dir ?? '.')
  if (options.format !== undefined && !(ASSET_FORMATS as readonly string[]).includes(options.format)) {
    throw new DshPptFailure('UsageError', `unsupported format filter "${options.format}"; use one of ${ASSET_FORMATS.join(', ')}`, {
      detail: { format: options.format },
    })
  }
  if (options.category !== undefined && !(OFFICE_CATEGORIES as readonly string[]).includes(options.category)) {
    throw new DshPptFailure('UsageError', `unsupported category filter "${String(options.category)}"; use one of ${OFFICE_CATEGORIES.join(', ')}`, {
      detail: { category: options.category },
    })
  }
  let items: ResolvedAsset[]
  let roots: string[]
  let recordFile: string | undefined
  if (options.source === 'office') {
    const recordPath = officeRecordPath(deps, options.record, dir)
    recordFile = recordPath
    const text = fs.readText(recordPath)
    if (text === null) {
      throw new DshPptFailure('OutputMissing', `no office discovery record at ${recordPath}; run \`dsh-ppt assets discover --source office\` first`, {
        detail: { recordPath },
      })
    }
    const record = parseOfficeAssetRecord(parseJson(text, recordPath))
    roots = record.roots.map((root) => root.path)
    items = record.assets.map((asset) => {
      if (!fs.exists(asset.file)) {
        throw new DshPptFailure('OutputMissing', `${recordPath} lists ${asset.file}, which is no longer on disk; re-run \`dsh-ppt assets discover --source office\``, {
          detail: { recordPath, file: asset.file, id: asset.id },
        })
      }
      return {
        id: asset.id,
        source: 'office' as const,
        file: asset.file,
        format: asset.format,
        category: asset.category,
        licence: OFFICE_ASSET_LICENCE,
        root: recordPath,
      }
    })
  } else {
    roots = [...userAssetRoots(dir, deps)]
    if (roots.length === 0) {
      throw new DshPptFailure(
        'OutputMissing',
        `no user asset library found; set DSH_PPT_ASSET_DIRS or add ${join('<deck>', 'assets', USER_ASSET_MANIFEST)}`,
        { detail: { dir } },
      )
    }
    if (options.category !== undefined) {
      throw new DshPptFailure('UsageError', 'the --category filter only applies to --source office', { detail: { category: options.category } })
    }
    items = []
    const byId = new Map<string, ResolvedAsset>()
    for (const root of roots) {
      for (const item of readUserLibrary(root, deps)) {
        const previous = byId.get(item.id)
        if (previous !== undefined) {
          throw new DshPptFailure('ContractViolation', `asset id "${item.id}" appears in both ${previous.root} and ${item.root}; user libraries must use unique ids`, {
            detail: { id: item.id, roots: [previous.root, item.root] },
          })
        }
        byId.set(item.id, item)
        items.push(item)
      }
    }
  }
  const filtered = items.filter((item) => (options.category === undefined || item.category === options.category) && (options.format === undefined || item.format === options.format))
  return { source: options.source, roots, items: filtered, ...(recordFile === undefined ? {} : { recordFile }) }
}

/**
 * Copy one library item into the deck.
 *
 * The destination is always inside the deck; an existing file with different
 * bytes is refused unless `--force` is passed, and an identical file is left
 * alone so repeated runs stay idempotent.
 *
 * @param options - source, id, destination directory and dependencies.
 * @returns the source, destination and byte count.
 * @throws DshPptFailure `UsageError` for an unknown id, `PathOutsideWorkspace`
 *   for a destination outside the deck, `ContractViolation` for a bad target
 *   name or a different existing file without `--force`, `OutputMissing` when
 *   the source file is unreadable.
 */
export function copyAsset(options: AssetCopyOptions): AssetCopyResult {
  const { deps } = options
  const fs = deps.fs
  const dir = resolveDeckDir(deps, options.dir ?? '.')
  const listing = listAssets({ source: options.source, dir, deps, ...(options.record === undefined ? {} : { record: options.record }) })
  const matches = listing.items.filter((item) => item.id === options.id)
  if (matches.length === 0) {
    throw new DshPptFailure('UsageError', `no ${options.source} asset with id "${options.id}"; run \`dsh-ppt assets list --source ${options.source}\``, {
      detail: { id: options.id, source: options.source },
    })
  }
  const item = matches[0] as ResolvedAsset
  const outputDir = assertInsideWorkspace(dir, options.output ?? 'assets', 'output')
  const name = options.as ?? `${item.id}.${item.format}`
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new DshPptFailure('ContractViolation', `--as must be a plain file name: ${name}`, { detail: { as: options.as } })
  }
  if (!name.toLowerCase().endsWith(`.${item.format}`)) {
    throw new DshPptFailure('ContractViolation', `--as must keep the .${item.format} extension: ${name}`, { detail: { as: options.as, format: item.format } })
  }
  const outputFile = join(outputDir, name)
  const bytes = fs.readBytes(item.file)
  if (bytes === null) {
    throw new DshPptFailure('OutputMissing', `the library file is unreadable: ${item.file}`, { detail: { file: item.file, id: item.id } })
  }
  const existing = fs.readBytes(outputFile)
  if (existing !== null && existing.equals(bytes)) {
    return { id: item.id, source: item.source, file: item.file, outputFile, relative: toWorkspaceRelative(dir, outputFile), bytes: bytes.length, replaced: false, unchanged: true }
  }
  if (existing !== null && options.force !== true) {
    throw new DshPptFailure('ContractViolation', `${outputFile} already exists with different bytes; pass --force to replace it`, {
      detail: { outputFile, id: item.id },
    })
  }
  fs.mkdirp(outputDir)
  fs.writeBytes(outputFile, bytes)
  return {
    id: item.id,
    source: item.source,
    file: item.file,
    outputFile,
    relative: toWorkspaceRelative(dir, outputFile),
    bytes: bytes.length,
    replaced: existing !== null,
    unchanged: false,
  }
}

/**
 * @param result - one discovery.
 * @returns the human-readable discovery summary.
 */
export function formatOfficeDiscovery(result: DiscoverOfficeAssetsResult): string {
  const lines = [`office assets: ${result.recordFile}`]
  for (const root of result.record.roots) {
    const counts = Object.entries(root.counts)
      .map(([format, count]) => `${format}=${String(count)}`)
      .join(' ')
    lines.push(`  ${root.category.padEnd(9)} ${root.path}  ${counts === '' ? 'no asset files' : counts}`)
  }
  const used = result.record.roots.filter((root) => Object.keys(root.counts).length > 0).length
  lines.push(`  ${String(result.record.assets.length)} asset(s) in ${String(used)} root(s)`)
  return lines.join('\n')
}

/**
 * @param result - one listing.
 * @returns one line per item, the source summary, and a fallback hint when nothing matched.
 */
export function formatAssetsList(result: AssetsListResult): string {
  const lines = result.items.map((item) => {
    const licence = item.source === 'user' ? `\t${item.licence}${item.author === undefined ? '' : ` / ${item.author}`}` : ''
    return `${item.id}\t${item.format}\t${item.category}\t${item.file}${licence}`
  })
  lines.push(`${result.source}: ${String(result.items.length)} asset(s) from ${String(result.roots.length)} root(s)`)
  if (result.items.length === 0) {
    lines.push(
      result.source === 'office'
        ? 'no asset matched; the local discovery covers Office clip art and themes, while modern PowerPoint icons are cloud-hosted - point DSH_PPT_OFFICE_ROOTS=icon=<dir> at a local icon directory or use the user/svg sources'
        : 'no asset matched; check the manifest entries and the --format filter',
    )
  }
  return lines.join('\n')
}

/**
 * @param result - one copy.
 * @returns the human-readable copy summary.
 */
export function formatAssetCopy(result: AssetCopyResult): string {
  const state = result.unchanged ? 'unchanged' : result.replaced ? 'replaced' : 'copied'
  return `${state} ${result.relative} (${String(result.bytes)} B) from ${result.file}`
}

/**
 * @param left - first string.
 * @param right - second string.
 * @returns -1, 0 or 1 by code unit, so the order does not depend on the locale.
 */
function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
