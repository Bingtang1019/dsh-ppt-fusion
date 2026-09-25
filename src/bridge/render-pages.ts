import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FileSystemPort } from '../engine/venv.ts'
import type { Runner } from '../engine/runner.ts'
import { DshPptFailure, tailOf } from '../engine/errors.ts'

/** Engines that can rasterise a deck into page images. */
export type RenderEngineId = 'libreoffice' | 'powerpoint'

/** Engines accepted on the command line, including the "try both" spelling. */
export type RenderEngineChoice = RenderEngineId | 'both'

/** Schema version of `manifest.json` / `pages.json`. */
export const RENDER_PAGES_SCHEMA_VERSION = 1

/** Slides rendered unless `--max-pages` raises the ceiling. */
export const DEFAULT_MAX_PAGES = 30

/** Per-page pixel ceiling, the same default the LibreOffice Kit applies. */
export const DEFAULT_MAX_PIXELS = 16_777_216

/** DPI of `--scale 1`; the kit's `--dpi` and PowerPoint's export size derive from it. */
export const RENDER_BASE_DPI = 96

/** Wall-clock ceiling for one engine's raster pass. */
export const RENDER_TIMEOUT_MS = 900_000

/** Resolved LibreOffice Kit entry points, as the office skill publishes them. */
export interface KitLocation {
  /** Absolute Node executable used to launch the kit CLI. */
  readonly node: string
  /** Absolute path of `@deepseek-ai/libreoffice-kit/lib/cli.js`. */
  readonly cli: string
}

/** One page image on disk, relative to its engine directory. */
export interface RenderPage {
  readonly index: number
  readonly file: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly sha256: string
}

/** What one engine did for one `renderpages` run. */
export interface RenderEngineReport {
  readonly engine: RenderEngineId
  readonly status: 'rendered' | 'cached' | 'skipped'
  /** Engine version the cache key was computed against; null when the engine never ran. */
  readonly version: string | null
  /** Deck-relative engine directory, or null when the engine was skipped. */
  readonly directory: string | null
  readonly cacheKey: string | null
  readonly pages: readonly RenderPage[]
  /** Why the engine was skipped, or the engine's own backend detail. */
  readonly detail?: string
}

/** The whole `renderpages` result, also written as `pages.json`. */
export interface RenderPagesReport {
  readonly schemaVersion: number
  /** Deck-relative pptx that was rasterised. */
  readonly source: string
  readonly sourceSha256: string
  readonly scale: number
  readonly maxPages: number
  readonly maxPixels: number
  readonly engines: readonly RenderEngineReport[]
  /** Deck-relative `pages.json`, or null when no engine produced anything. */
  readonly pagesFile: string | null
  readonly skipped: readonly string[]
}

/** Everything one `renderpages` run needs from outside. */
export interface RenderPagesRequest {
  /** Absolute deck workspace (child-process cwd). */
  readonly dir: string
  /** Absolute pptx path. */
  readonly sourcePath: string
  /** Deck-relative pptx path recorded in the manifests. */
  readonly sourceRelative: string
  /** Absolute output root, normally `<deck>/.dsh-ppt/render`. */
  readonly outputRoot: string
  /** Deck-relative output root for the report. */
  readonly outputRelative: string
  readonly engines: readonly RenderEngineId[]
  readonly scale: 1 | 2
  readonly maxPages: number
  readonly maxPixels: number
  /** Re-render even when the cache matches. */
  readonly force: boolean
  /** Fail the command when any requested engine is skipped. */
  readonly required: boolean
  readonly fs: FileSystemPort
  readonly runner: Runner
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  /** Resolved LibreOffice Kit, or null when the caller found none. */
  readonly kit: KitLocation | null
  /** Resolved `soffice`, used only when the kit is absent. */
  readonly soffice: string | null
  /** Absolute path of `scripts/win-com-export-pages.ps1`. */
  readonly comScript: string
  /** PowerShell executable for the COM leg. */
  readonly powershell: string
}

/** Stored/measured shape of one engine manifest. */
interface EngineManifest {
  readonly schemaVersion: number
  readonly engine: RenderEngineId
  readonly engineVersion: string
  readonly cacheKey: string
  readonly source: string
  readonly sourceSha256: string
  readonly scale: number
  readonly dpi: number
  readonly maxPages: number
  readonly maxPixels: number
  readonly pages: readonly RenderPage[]
}

/** One engine's probe outcome: how to render, or why it cannot. */
interface EngineProbe {
  readonly version: string | null
  readonly detail?: string
  readonly unavailable?: string
}

/** @param bytes - file bytes. @returns lowercase SHA-256 hex. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @param parts - the cache-key inputs. @returns a stable `sha256:`-prefixed key. */
export function renderCacheKey(parts: { sourceSha256: string; engine: RenderEngineId; engineVersion: string; scale: number; maxPages: number; maxPixels: number }): string {
  return `sha256:${sha256(Buffer.from(JSON.stringify(parts), 'utf8'))}`
}

/** @param text - the payload a runner captured, possibly after log lines. @returns the first JSON object that parses, or null. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  let start = text.indexOf('{')
  let attempts = 0
  while (start >= 0 && attempts < 32) {
    attempts += 1
    try {
      const parsed = JSON.parse(text.slice(start)) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // The next `{` may start the payload; keep scanning.
    }
    start = text.indexOf('{', start + 1)
  }
  return null
}

/** @param value - candidate. @returns the value when it is a positive integer. */
function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Rasterise a deck with every requested engine, reusing cached page images.
 *
 * @param request - paths, limits, engine locations and injected boundaries.
 * @returns per-engine outcomes plus the written `pages.json`.
 * @throws DshPptFailure `OutputMissing` when the source pptx is unreadable,
 *   `EngineExit`/`EngineTimeout` when an engine fails, `OutputMissing` when an
 *   engine succeeds without writing the contracted pages, and `ContractViolation`
 *   when `--required` is set and an engine is unavailable.
 */
export function renderPages(request: RenderPagesRequest): RenderPagesReport {
  const sourceBytes = request.fs.readBytes(request.sourcePath)
  if (sourceBytes === null || sourceBytes.length === 0) {
    throw new DshPptFailure('OutputMissing', `cannot read the source deck ${request.sourceRelative}`)
  }
  const sourceSha256 = sha256(sourceBytes)
  const dpi = RENDER_BASE_DPI * request.scale
  const reports: RenderEngineReport[] = []
  const skipped: string[] = []
  for (const engine of request.engines) {
    const report = renderEngine(engine, request, sourceSha256, dpi)
    reports.push(report)
    if (report.status === 'skipped') skipped.push(`${engine}: ${report.detail ?? 'unavailable'}`)
  }
  const pagesFile = reports.some((report) => report.status !== 'skipped') ? join(request.outputRelative, 'pages.json') : null
  // `pages.json` is the deck's snapshot index, not just this run's receipt: keep the
  // engines of a previous run for the same source so `--engine libreoffice` does not
  // erase the PowerPoint half of the index.
  const previous = readPagesReport(request.fs, request.outputRoot)
  const engines = previous !== null && previous.sourceSha256 === sourceSha256
    ? [...reports, ...previous.engines.filter((entry) => !reports.some((report) => report.engine === entry.engine))]
    : reports
  const report: RenderPagesReport = {
    schemaVersion: RENDER_PAGES_SCHEMA_VERSION,
    source: request.sourceRelative,
    sourceSha256,
    scale: request.scale,
    maxPages: request.maxPages,
    maxPixels: request.maxPixels,
    engines,
    pagesFile,
    skipped,
  }
  if (pagesFile !== null) {
    request.fs.mkdirp(request.outputRoot)
    request.fs.writeText(join(request.outputRoot, 'pages.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (request.required && skipped.length > 0) {
    throw new DshPptFailure('ContractViolation', `--required was set but ${String(skipped.length)} engine(s) could not run: ${skipped.join('; ')}`)
  }
  return report
}

/**
 * @param engine - engine id.
 * @param request - the run request.
 * @param sourceSha256 - the pptx digest.
 * @param dpi - resolved export DPI.
 * @returns the engine's report, rendering only when the cache does not match.
 */
function renderEngine(engine: RenderEngineId, request: RenderPagesRequest, sourceSha256: string, dpi: number): RenderEngineReport {
  const directory = join(request.outputRoot, engine)
  const directoryRelative = join(request.outputRelative, engine)
  const probe = probeEngine(engine, request)
  if (probe.unavailable !== undefined) {
    return { engine, status: 'skipped', version: null, directory: null, cacheKey: null, pages: [], detail: probe.unavailable }
  }
  const cacheKey = renderCacheKey({ sourceSha256, engine, engineVersion: probe.version ?? 'unknown', scale: request.scale, maxPages: request.maxPages, maxPixels: request.maxPixels })
  const cached = request.force ? null : readCached(request.fs, directory, { sourceSha256, engine, scale: request.scale, maxPages: request.maxPages, maxPixels: request.maxPixels, engineVersion: probe.version ?? 'unknown' })
  if (cached !== null) {
    return { engine, status: 'cached', version: probe.version, directory: directoryRelative, cacheKey: cached.cacheKey, pages: cached.pages, ...(probe.detail === undefined ? {} : { detail: probe.detail }) }
  }
  const pages = renderEnginePages(engine, request, { dpi, cacheKey, sourceSha256, version: probe.version })
  request.fs.removeTree(directory)
  request.fs.mkdirp(directory)
  for (const page of pages) {
    const bytes = request.fs.readBytes(join(request.outputRoot, `${engine}.tmp`, page.file))
    if (bytes === null) throw new DshPptFailure('OutputMissing', `${engine} reported ${page.file} but the file is absent`)
    request.fs.writeBytes(join(directory, page.file), bytes)
  }
  const manifest: EngineManifest = {
    schemaVersion: RENDER_PAGES_SCHEMA_VERSION,
    engine,
    engineVersion: probe.version ?? 'unknown',
    cacheKey,
    source: request.sourceRelative,
    sourceSha256,
    scale: request.scale,
    dpi,
    maxPages: request.maxPages,
    maxPixels: request.maxPixels,
    pages,
  }
  request.fs.writeText(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  request.fs.removeTree(join(request.outputRoot, `${engine}.tmp`))
  return { engine, status: 'rendered', version: probe.version, directory: directoryRelative, cacheKey, pages, ...(probe.detail === undefined ? {} : { detail: probe.detail }) }
}

/**
 * @param engine - engine id.
 * @param request - the run request.
 * @returns the engine version and backend, or the reason it cannot run.
 */
function probeEngine(engine: RenderEngineId, request: RenderPagesRequest): EngineProbe {
  if (engine === 'powerpoint') {
    if (request.platform !== 'win32') return { version: null, unavailable: 'PowerPoint COM runs on Windows hosts only' }
    const probe = request.runner(
      request.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', 'try { $app = New-Object -ComObject PowerPoint.Application; Write-Output ("ok " + $app.Version); $app.Quit() } catch { Write-Output ("fail " + $_.Exception.Message); exit 1 }'],
      { cwd: request.dir, timeoutMs: 120_000, env: request.env },
    )
    const output = `${probe.stdout}${probe.stderr}`.trim()
    if (probe.status !== 0 || !output.startsWith('ok')) return { version: null, unavailable: `PowerPoint COM is unavailable: ${tailOf(output, 3) || probe.spawnErrorMessage}` }
    return { version: output.slice(2).trim() || null }
  }
  if (request.kit !== null) {
    const probe = request.runner(request.kit.node, [request.kit.cli, 'capabilities', '--json'], { cwd: request.dir, timeoutMs: 180_000, env: request.env })
    const parsed = parseJsonObject(probe.stdout)
    const runtime = parsed?.runtime as Record<string, unknown> | undefined
    const version = typeof runtime?.version === 'string' ? runtime.version : null
    if (probe.status !== 0 || version === null) {
      return { version: null, unavailable: `the LibreOffice Kit CLI failed: ${tailOf(probe.stderr || probe.stdout, 3) || probe.spawnErrorMessage}` }
    }
    const backend = typeof runtime?.backend === 'string' ? runtime.backend : 'unknown'
    return { version, detail: `libreoffice-kit ${version} (${backend})` }
  }
  if (request.soffice !== null) {
    const probe = request.runner(request.soffice, ['--version'], { cwd: request.dir, timeoutMs: 120_000, env: request.env })
    const version = `${probe.stdout}`.trim().split(/\r?\n/)[0] ?? ''
    if (probe.status !== 0 || version === '') return { version: null, unavailable: `soffice failed to report a version: ${tailOf(probe.stderr, 3) || probe.spawnErrorMessage}` }
    const raster = request.runner('pdftoppm', ['-v'], { cwd: request.dir, timeoutMs: 60_000, env: request.env })
    if (raster.spawnError !== null) return { version: null, unavailable: 'system soffice is present but pdftoppm is missing; set DSH_PPT_LOKIT_CLI to the LibreOffice Kit CLI' }
    return { version, detail: `system soffice (${version})` }
  }
  return { version: null, unavailable: 'no LibreOffice Kit CLI and no soffice on PATH; set DSH_PPT_LOKIT_CLI or install @deepseek-ai/libreoffice-kit' }
}

/**
 * @param fs - filesystem port.
 * @param directory - absolute engine directory.
 * @param expected - the fields a cached manifest must match.
 * @returns the cached pages, or null when the cache is absent, stale or incomplete.
 */
function readCached(
  fs: FileSystemPort,
  directory: string,
  expected: { sourceSha256: string; engine: RenderEngineId; scale: number; maxPages: number; maxPixels: number; engineVersion: string },
): EngineManifest | null {
  const text = fs.readText(join(directory, 'manifest.json'))
  if (text === null) return null
  let parsed: Partial<EngineManifest>
  try {
    parsed = JSON.parse(text) as Partial<EngineManifest>
  } catch {
    return null
  }
  if (
    parsed.schemaVersion !== RENDER_PAGES_SCHEMA_VERSION ||
    parsed.engine !== expected.engine ||
    parsed.sourceSha256 !== expected.sourceSha256 ||
    parsed.scale !== expected.scale ||
    parsed.maxPages !== expected.maxPages ||
    parsed.maxPixels !== expected.maxPixels ||
    parsed.engineVersion !== expected.engineVersion ||
    typeof parsed.cacheKey !== 'string' ||
    !Array.isArray(parsed.pages) ||
    parsed.pages.length === 0
  ) {
    return null
  }
  for (const page of parsed.pages) {
    if (typeof page.file !== 'string' || !fs.exists(join(directory, page.file))) return null
  }
  return { ...(parsed as EngineManifest), pages: parsed.pages }
}

/**
 * @param engine - engine id.
 * @param request - the run request.
 * @param context - resolved DPI, cache key, source digest and engine version.
 * @returns the page records, hashing every produced image.
 */
function renderEnginePages(engine: RenderEngineId, request: RenderPagesRequest, context: { dpi: number; cacheKey: string; sourceSha256: string; version: string | null }): RenderPage[] {
  const temp = join(request.outputRoot, `${engine}.tmp`)
  request.fs.removeTree(temp)
  // `temp` stays absent on purpose: the LibreOffice Kit requires a fresh
  // `--output-dir`, and the COM script creates its own directory.
  try {
    const images =
      engine === 'powerpoint'
        ? exportWithPowerPoint(engine, request, temp, context.dpi)
        : exportWithLibreOffice(engine, request, temp, context.dpi)
    if (images.length === 0) throw new DshPptFailure('OutputMissing', `${engine} produced no page images`)
    if (images.length > request.maxPages) {
      throw new DshPptFailure('ContractViolation', `${engine} rendered ${String(images.length)} pages, above --max-pages ${String(request.maxPages)}`)
    }
    const pages: RenderPage[] = []
    for (const image of images) {
      const bytes = request.fs.readBytes(join(temp, image.file))
      if (bytes === null || bytes.length === 0) throw new DshPptFailure('OutputMissing', `${engine} reported ${image.file} but wrote no bytes`)
      if (image.width * image.height > request.maxPixels) {
        throw new DshPptFailure('ContractViolation', `${engine} page ${String(image.index)} is ${String(image.width)}x${String(image.height)}, above --max-pixels ${String(request.maxPixels)}`)
      }
      pages.push({ index: image.index, file: image.file, width: image.width, height: image.height, bytes: bytes.length, sha256: sha256(bytes) })
    }
    pages.sort((left, right) => left.index - right.index)
    return pages
  } catch (error) {
    request.fs.removeTree(temp)
    throw error
  }
}

/** One image an engine reported, before hashing. */
interface EngineImage {
  readonly index: number
  readonly file: string
  readonly width: number
  readonly height: number
}

/**
 * @param engine - engine label for error messages.
 * @param request - the run request.
 * @param temp - fresh absolute directory the engine may write into.
 * @param dpi - export DPI.
 * @returns the images the engine wrote.
 */
function exportWithPowerPoint(engine: RenderEngineId, request: RenderPagesRequest, temp: string, dpi: number): EngineImage[] {
  const result = request.runner(
    request.powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', request.comScript, '-Deck', request.sourcePath, '-OutDir', temp, '-Dpi', String(dpi), '-MaxPages', String(request.maxPages), '-MaxPixels', String(request.maxPixels), '-Json'],
    { cwd: request.dir, timeoutMs: RENDER_TIMEOUT_MS, env: request.env },
  )
  if (result.timedOut) throw new DshPptFailure('EngineTimeout', `${engine} exceeded ${String(RENDER_TIMEOUT_MS)} ms`)
  if (result.spawnError !== null) throw new DshPptFailure('SpawnFailed', `${engine} could not start: ${result.spawnErrorMessage}`)
  const parsed = parseJsonObject(result.stdout)
  if (parsed === null || parsed.ok !== true) {
    throw new DshPptFailure('EngineExit', `${engine} failed: ${String(parsed?.error ?? tailOf(result.stderr || result.stdout, 5))}`)
  }
  const width = positiveInt(parsed.width)
  const height = positiveInt(parsed.height)
  const pages = Array.isArray(parsed.pages) ? parsed.pages : []
  const images: EngineImage[] = []
  for (const entry of pages) {
    const record = entry as Record<string, unknown>
    const index = positiveInt(record.index)
    const file = typeof record.file === 'string' ? record.file : null
    if (index === null || file === null || width === null || height === null) {
      throw new DshPptFailure('ContractViolation', `${engine} returned an unusable page record: ${JSON.stringify(entry)}`)
    }
    images.push({ index, file, width, height })
  }
  return images
}

/**
 * @param engine - engine label for error messages.
 * @param request - the run request.
 * @param temp - fresh absolute directory the engine may write into.
 * @param dpi - export DPI.
 * @returns the images the engine wrote, renamed to the shared `page-NNNN.png` convention.
 */
function exportWithLibreOffice(engine: RenderEngineId, request: RenderPagesRequest, temp: string, dpi: number): EngineImage[] {
  if (request.kit === null) return exportWithSoffice(engine, request, temp, dpi)
  const result = request.runner(
    request.kit.node,
    [request.kit.cli, 'render', '--input', request.sourcePath, '--output-dir', temp, '--dpi', String(dpi), '--max-pages', String(request.maxPages), '--max-pixels', String(request.maxPixels), '--timeout-ms', String(RENDER_TIMEOUT_MS)],
    { cwd: request.dir, timeoutMs: RENDER_TIMEOUT_MS + 60_000, env: request.env },
  )
  if (result.timedOut) throw new DshPptFailure('EngineTimeout', `${engine} exceeded ${String(RENDER_TIMEOUT_MS)} ms`)
  if (result.spawnError !== null) throw new DshPptFailure('SpawnFailed', `${engine} could not start: ${result.spawnErrorMessage}`)
  const parsed = parseJsonObject(result.stdout)
  if (parsed === null) throw new DshPptFailure('EngineExit', `${engine} wrote no JSON result: ${tailOf(result.stderr || result.stdout, 5)}`)
  const images = Array.isArray(parsed.images) ? parsed.images : []
  const converted: EngineImage[] = []
  for (const entry of images) {
    const record = entry as Record<string, unknown>
    const index = positiveInt(record.index)
    const path = typeof record.path === 'string' ? record.path : null
    const width = positiveInt(record.width)
    const height = positiveInt(record.height)
    if (index === null || path === null || width === null || height === null) {
      throw new DshPptFailure('ContractViolation', `${engine} returned an unusable page record: ${JSON.stringify(entry)}`)
    }
    const file = `page-${String(index).padStart(4, '0')}.png`
    const bytes = request.fs.readBytes(path)
    if (bytes === null) throw new DshPptFailure('OutputMissing', `${engine} reported ${path} but the file is absent`)
    request.fs.writeBytes(join(temp, file), bytes)
    converted.push({ index, file, width, height })
  }
  return converted
}

/**
 * @param engine - engine label for error messages.
 * @param request - the run request.
 * @param temp - fresh absolute directory the engine may write into.
 * @param dpi - export DPI.
 * @returns the images the system soffice plus pdftoppm wrote.
 */
function exportWithSoffice(engine: RenderEngineId, request: RenderPagesRequest, temp: string, dpi: number): EngineImage[] {
  const soffice = request.soffice
  if (soffice === null) throw new DshPptFailure('ContractViolation', `${engine} has no engine to run`)
  const pdfDir = join(temp, 'pdf')
  request.fs.mkdirp(pdfDir)
  const convert = request.runner(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', pdfDir, request.sourcePath], { cwd: request.dir, timeoutMs: RENDER_TIMEOUT_MS, env: request.env })
  if (convert.timedOut) throw new DshPptFailure('EngineTimeout', `${engine} exceeded ${String(RENDER_TIMEOUT_MS)} ms`)
  if (convert.status !== 0) throw new DshPptFailure('EngineExit', `${engine} convert exited ${String(convert.status)}: ${tailOf(convert.stderr || convert.stdout, 5)}`)
  const pdf = request.fs.listDir(pdfDir).find((name) => name.toLowerCase().endsWith('.pdf'))
  if (pdf === undefined) throw new DshPptFailure('OutputMissing', `${engine} wrote no PDF under ${pdfDir}`)
  const prefix = join(temp, 'page')
  const raster = request.runner('pdftoppm', ['-png', '-r', String(dpi), join(pdfDir, pdf), prefix], { cwd: request.dir, timeoutMs: RENDER_TIMEOUT_MS, env: request.env })
  if (raster.timedOut) throw new DshPptFailure('EngineTimeout', `${engine} raster exceeded ${String(RENDER_TIMEOUT_MS)} ms`)
  if (raster.status !== 0 || raster.spawnError !== null) {
    throw new DshPptFailure('EngineExit', `${engine} raster failed: ${tailOf(raster.stderr || raster.stdout, 5) || raster.spawnErrorMessage}`)
  }
  const images: EngineImage[] = []
  const files = request.fs.listDir(temp).filter((name) => /^page-\d+\.png$/i.test(name)).sort()
  for (const [offset, name] of files.entries()) {
    const index = offset + 1
    const file = `page-${String(index).padStart(4, '0')}.png`
    // `?? Buffer.alloc(0)` here used to record a 0x0 page instead of failing: an
    // unreadable raster must stop the run, not become a page-size change downstream.
    const source = request.fs.readBytes(join(temp, name))
    if (source === null || source.length === 0) throw new DshPptFailure('OutputMissing', `${engine} wrote ${name} but it cannot be read`)
    if (name !== file) request.fs.writeBytes(join(temp, file), source)
    const written = request.fs.readBytes(join(temp, file)) ?? source
    const size = pngSize(written)
    if (size === null) throw new DshPptFailure('ContractViolation', `${engine} passed ${name} through as a page image, but it is not a PNG`)
    images.push({ index, file, width: size.width, height: size.height })
  }
  return images
}

/** @param bytes - a PNG file, or null. @returns its IHDR dimensions when readable. */
function pngSize(bytes: Buffer | null): { width: number; height: number } | null {
  if (bytes === null || bytes.length < 24) return null
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * @param fs - filesystem port.
 * @param outputRoot - absolute render root.
 * @returns the previous `pages.json` summary, or null when it is absent or unreadable.
 */
function readPagesReport(fs: FileSystemPort, outputRoot: string): RenderPagesReport | null {
  const text = fs.readText(join(outputRoot, 'pages.json'))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as Partial<RenderPagesReport>
    if (parsed.schemaVersion !== RENDER_PAGES_SCHEMA_VERSION || !Array.isArray(parsed.engines) || typeof parsed.sourceSha256 !== 'string') return null
    return parsed as RenderPagesReport
  } catch {
    return null
  }
}