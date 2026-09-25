import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DshPptFailure } from '../engine/errors.ts'
import { packageAsset } from '../package-paths.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { resolveArtifact, resolveDeckDir, type CommandDependencies } from './context.ts'
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_PIXELS,
  RENDER_BASE_DPI,
  renderPages,
  type KitLocation,
  type RenderEngineChoice,
  type RenderEngineId,
  type RenderPagesReport,
} from '../bridge/render-pages.ts'

export { DEFAULT_MAX_PAGES, DEFAULT_MAX_PIXELS, RENDER_BASE_DPI }

/** Options for `dsh-ppt renderpages`. */
export interface RenderPagesCommandOptions {
  readonly dir: string
  /** Explicit pptx, deck-relative; defaults to the last published render. */
  readonly file?: string
  /** Output root, deck-relative; defaults to `.dsh-ppt/render`. */
  readonly output: string
  readonly engine: RenderEngineChoice
  readonly scale: number
  readonly maxPages: number
  readonly maxPixels: number
  /** Fail when a requested engine is unavailable instead of recording `skipped`. */
  readonly required: boolean
  /** Ignore a matching cache entry. */
  readonly force: boolean
  readonly deps: CommandDependencies
}

/** @param value - parsed CLI integer. @param flag - flag name for the error. @returns the value when it is a positive integer. */
export function positiveOption(value: number, flag: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new DshPptFailure('UsageError', `${flag} must be a positive integer`)
  return value
}

/**
 * Resolve the LibreOffice Kit CLI the way the plan's discovery order prescribes:
 * `DSH_PPT_LOKIT_CLI`, then a Kit installed next to the plugin or in a DSH runtime
 * under the user's home, then nothing (the caller falls back to `soffice`).
 *
 * @param input - environment, home directories, working directory and filesystem port.
 * @param input.env - process environment.
 * @param input.home - user home (parent of `~/.dsh`).
 * @param input.cwd - current working directory.
 * @param input.fs - filesystem port.
 * @param input.resolveModule - optional resolver for a Kit installed beside the plugin.
 * @returns the node and CLI paths, or null when no Kit is present.
 */
export function resolveLibreOfficeKit(input: {
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
  fs: CommandDependencies['fs']
  resolveModule?: CommandDependencies['resolveModule']
}): KitLocation | null {
  const explicit = input.env.DSH_PPT_LOKIT_CLI
  if (explicit !== undefined && explicit !== '' && input.fs.exists(explicit)) {
    const node = input.env.DSH_PPT_LOKIT_NODE !== undefined && input.env.DSH_PPT_LOKIT_NODE !== '' ? input.env.DSH_PPT_LOKIT_NODE : process.execPath
    return { node, cli: resolve(explicit) }
  }
  if (input.resolveModule !== undefined) {
    try {
      const url = input.resolveModule('@deepseek-ai/libreoffice-kit/package.json')
      const path = dirname(fileURLToPath(url))
      const cli = join(path, 'lib', 'cli.js')
      if (input.fs.exists(cli)) return { node: process.execPath, cli }
    } catch {
      // No Kit beside the plugin; the runtime scan below covers the machine layout.
    }
  }
  const roots: string[] = []
  for (const base of [input.home, input.cwd]) {
    if (!roots.includes(base)) roots.push(base)
  }
  for (const root of roots) {
    const entries = input.fs.listDir(root).slice(0, 60)
    for (const entry of entries) {
      if (!/^dsh-.*(runtime|home)$/.test(entry)) continue
      const runtime = join(root, entry)
      const direct = join(runtime, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
      if (input.fs.exists(direct)) return { node: process.execPath, cli: direct }
      const store = join(runtime, 'node_modules', '.pnpm')
      for (const stored of input.fs.listDir(store)) {
        if (!stored.startsWith('@deepseek-ai+libreoffice-kit@')) continue
        const cli = join(store, stored, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
        if (input.fs.exists(cli)) return { node: process.execPath, cli }
      }
    }
  }
  return null
}

/**
 * @param input - environment, platform and filesystem port.
 * @param input.env - process environment.
 * @param input.platform - host platform.
 * @param input.fs - filesystem port.
 * @returns the `soffice` executable, or null when no system LibreOffice is installed.
 */
export function resolveSoffice(input: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; fs: CommandDependencies['fs'] }): string | null {
  const pathValue = input.env.PATH ?? input.env.Path ?? ''
  const names = input.platform === 'win32' ? ['soffice.exe', 'soffice.com', 'soffice'] : ['soffice']
  for (const directory of pathValue.split(input.platform === 'win32' ? ';' : ':')) {
    if (directory === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (input.fs.exists(candidate)) return candidate
    }
  }
  const known =
    input.platform === 'win32'
      ? ['ProgramFiles', 'ProgramFiles(x86)']
          .map((key) => input.env[key])
          .filter((root): root is string => root !== undefined && root !== '')
          .map((root) => join(root, 'LibreOffice', 'program', 'soffice.exe'))
      : input.platform === 'darwin'
        ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
        : ['/usr/bin/soffice', '/usr/local/bin/soffice']
  return known.find((candidate) => input.fs.exists(candidate)) ?? null
}

/** @param choice - `--engine` value. @returns the engines to run, in a fixed order. */
export function enginesOf(choice: RenderEngineChoice): readonly RenderEngineId[] {
  return choice === 'both' ? ['powerpoint', 'libreoffice'] : [choice]
}

/**
 * Rasterise the deck's published pptx into page images for the requested engines.
 *
 * @param options - deck, output, engine choice, limits and dependencies.
 * @returns the per-engine report plus the `pages.json` path.
 * @throws DshPptFailure `OutputMissing` when no pptx resolves, `UsageError` for bad limits,
 *   `PathOutsideWorkspace` for an output root outside the deck, and the render-pages
 *   failures when an engine runs but fails.
 */
export function renderPagesCommand(options: RenderPagesCommandOptions): RenderPagesReport {
  const deps = options.deps
  const dir = resolveDeckDir(deps, options.dir)
  const artifact = resolveArtifact({ dir, file: options.file, fs: deps.fs })
  if (artifact === null) {
    throw new DshPptFailure('OutputMissing', 'no rendered pptx found; run `dsh-ppt render` first or pass --file')
  }
  const outputRoot = assertInsideWorkspace(dir, options.output, 'output')
  const outputRelative = options.output.replace(/\\/g, '/')
  const home = deps.env.USERPROFILE ?? deps.env.HOME ?? deps.cwd
  const kit = resolveLibreOfficeKit({ env: deps.env, home, cwd: deps.cwd, fs: deps.fs, resolveModule: deps.resolveModule })
  const engines = enginesOf(options.engine)
  const soffice = engines.includes('libreoffice') ? resolveSoffice({ env: deps.env, platform: process.platform, fs: deps.fs }) : null
  return renderPages({
    dir,
    sourcePath: artifact.path,
    sourceRelative: artifact.relative.replace(/\\/g, '/'),
    outputRoot,
    outputRelative,
    engines,
    scale: options.scale === 2 ? 2 : 1,
    maxPages: options.maxPages,
    maxPixels: options.maxPixels,
    force: options.force,
    required: options.required,
    fs: deps.fs,
    runner: deps.runner,
    env: deps.env,
    platform: process.platform,
    kit,
    soffice,
    comScript: packageAsset('scripts/win-com-export-pages.ps1'),
    powershell: deps.env.DSH_PPT_POWERSHELL ?? 'powershell',
  })
}

/**
 * @param report - a `renderpages` result.
 * @returns one human line per engine plus the summary line.
 */
export function formatRenderPagesResult(report: RenderPagesReport): string {
  const lines = [`renderpages: ${report.source} (sha256 ${report.sourceSha256}, scale ${String(report.scale)}x)`]
  for (const engine of report.engines) {
    if (engine.status === 'skipped') {
      lines.push(`  ${engine.engine}: skipped (${engine.detail ?? 'unavailable'})`)
      continue
    }
    const version = engine.version === null ? '' : ` ${engine.version}`
    lines.push(`  ${engine.engine}: ${engine.status}${version}, ${String(engine.pages.length)} page(s) → ${engine.directory ?? ''}`)
  }
  if (report.skipped.length > 0) lines.push(`  skipped: ${report.skipped.join('; ')}`)
  if (report.pagesFile !== null) lines.push(`wrote ${report.pagesFile}`)
  else lines.push('no engine produced page images')
  return lines.join('\n')
}

/** @param value - the `--scale` value as text. @returns the validated scale. @throws DshPptFailure `UsageError` when it is not 1 or 2. */
export function scaleOption(value: string): 1 | 2 {
  if (value !== '1' && value !== '2') throw new DshPptFailure('UsageError', '--scale must be 1 or 2')
  return value === '2' ? 2 : 1
}

/** @param value - the `--engine` value as text. @returns the validated engine choice. @throws DshPptFailure `UsageError` for anything else. */
export function engineOption(value: string): RenderEngineChoice {
  if (value !== 'powerpoint' && value !== 'libreoffice' && value !== 'both') {
    throw new DshPptFailure('UsageError', '--engine must be powerpoint, libreoffice or both')
  }
  return value
}

