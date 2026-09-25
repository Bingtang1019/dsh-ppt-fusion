import { isAbsolute, join, relative, resolve } from 'node:path'
import { createFrontend, resolvePptwiseCli, type Frontend, type ModuleResolver } from '../frontend.ts'
import { nodeFileSystem, type FileSystemPort } from '../engine/venv.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { spawnRunner, type Runner } from '../engine/runner.ts'
import { createThemeBridge } from '../bridge/theme.ts'
import { createMasterEngine } from '../engine/master.ts'
import { DEFAULT_PYPI_INDEX, createVenvManager, resolveDshHome } from '../engine/venv.ts'
import { packageAsset } from '../package-paths.ts'
import { createLoggingRunner, createWorkspaceLogSink } from '../logging.ts'
import { PINNED } from './doctor.ts'
import type { DesignRole } from '../schema/design-profile.ts'
import { STORYBOARD_FILE } from '../schema/storyboard.ts'

/**
 * Everything a deck command needs from outside itself.
 *
 * Commands take this as a parameter so tests can run them against an in-memory
 * filesystem and a scripted process runner.
 */
export interface CommandDependencies {
  readonly fs: FileSystemPort
  readonly runner: Runner
  readonly env: NodeJS.ProcessEnv
  readonly resolveModule: ModuleResolver
  readonly cwd: string
}

/** The production dependencies: real filesystem, real processes, real environment. */
export function defaultDependencies(overrides: Partial<CommandDependencies> = {}): CommandDependencies {
  return {
    fs: overrides.fs ?? nodeFileSystem,
    runner: overrides.runner ?? spawnRunner,
    env: overrides.env ?? process.env,
    resolveModule: overrides.resolveModule ?? ((specifier) => import.meta.resolve(specifier)),
    cwd: overrides.cwd ?? process.cwd(),
  }
}

/**
 * @param deps - command dependencies.
 * @param target - deck directory as given on the command line.
 * @returns the absolute deck workspace path.
 */
export function resolveDeckDir(deps: CommandDependencies, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(deps.cwd, target)
}

/**
 * The package a deck command operates on: an explicit `--file`, else the last
 * render's `out/manifest.json` entry, else the single pptx in `out/`.
 *
 * @param input.dir - absolute deck workspace.
 * @param input.file - explicit path; deck-relative unless `allowOutside`.
 * @param input.fs - filesystem port.
 * @param input.allowOutside - skip the workspace containment check (`--profile` audits their own deck).
 * @returns the absolute path plus the deck-relative spelling, or null when nothing resolves.
 * @throws DshPptFailure `PathOutsideWorkspace` when an explicit path leaves the workspace.
 */
export function resolveArtifact(input: { dir: string; file: string | undefined; fs: FileSystemPort; allowOutside?: boolean }): { path: string; relative: string } | null {
  if (input.file !== undefined) {
    const path =
      input.allowOutside === true
        ? isAbsolute(input.file)
          ? resolve(input.file)
          : resolve(input.dir, input.file)
        : assertInsideWorkspace(input.dir, input.file, 'file')
    if (!input.fs.exists(path)) return null
    return { path, relative: relative(input.dir, path) }
  }
  const manifestText = input.fs.readText(join(input.dir, 'out', 'manifest.json'))
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText) as { file?: unknown }
      if (typeof manifest.file === 'string' && manifest.file.length > 0) {
        const path = resolve(input.dir, manifest.file)
        if (input.fs.exists(path)) return { path, relative: manifest.file }
      }
    } catch {
      // A corrupt manifest is not this helper's finding; the single-pptx fallback
      // below still lets the caller run.
    }
  }
  const outDir = join(input.dir, 'out')
  if (!input.fs.isDirectory(outDir)) return null
  const candidates = input.fs.listDir(outDir).filter((name) => name.toLowerCase().endsWith('.pptx')).sort()
  if (candidates.length !== 1) return null
  const name = candidates[0] ?? ''
  return { path: join(outDir, name), relative: `out/${name}` }
}
/**
 * @param dir - absolute deck workspace, used as the child process's cwd.
 * @param deps - command dependencies.
 * @returns a pptwise front end bound to that workspace.
 * @throws DshPptFailure `PptwiseMissing` when the package is not installed.
 */
export function frontendFor(dir: string, deps: CommandDependencies): Frontend {
  return createFrontend({
    runner: loggedRunnerFor(dir, deps),
    cli: resolvePptwiseCli({
      resolve: deps.resolveModule,
      readText: (path) => {
        const text = deps.fs.readText(path)
        if (text === null) throw new Error(`cannot read ${path}`)
        return text
      },
    }),
    workspace: dir,
    env: deps.env,
  })
}

/**
 * @param dir - absolute deck workspace.
 * @param deps - command dependencies.
 * @returns the theme bridge for that workspace.
 */
export function themeBridgeFor(dir: string, deps: CommandDependencies) {
  return createThemeBridge({ workspace: dir, frontend: frontendFor(dir, deps), fs: deps.fs, upstream: PINNED.pptwise })
}

/**
 * @param dir - deck workspace.
 * @param deps - command dependencies.
 * @returns the storyboard's role per page index — storyboard-only `toc` included,
 *   `data`/`quote` folded onto content — or undefined when the storyboard is absent
 *   or unreadable. The design pass and the design audit share this mapping so a toc
 *   page is judged by the profile's toc row, not by its coarse IR type.
 */
export function designRoleMap(dir: string, deps: CommandDependencies): Map<number, DesignRole> | undefined {
  const text = deps.fs.readText(join(dir, STORYBOARD_FILE))
  if (text === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  const pages = (parsed as { pages?: unknown }).pages
  if (!Array.isArray(pages)) return undefined
  const roles = new Map<number, DesignRole>()
  for (const entry of pages) {
    if (entry === null || typeof entry !== 'object') continue
    const index = (entry as { index?: unknown }).index
    const role = (entry as { role?: unknown }).role
    if (typeof index !== 'number' || typeof role !== 'string') continue
    const mapped =
      role === 'data' || role === 'quote'
        ? 'content'
        : role === 'cover' || role === 'toc' || role === 'section' || role === 'content' || role === 'ending'
          ? role
          : null
    if (mapped !== null) roles.set(index, mapped)
  }
  return roles.size === 0 ? undefined : roles
}

/**
 * Build the engine venv manager with the same configuration `doctor` uses, so a
 * deck command and the diagnostic never disagree about where the venv is.
 *
 * @param deps - command dependencies.
 * @returns the venv manager.
 */
export function venvManagerFor(deps: CommandDependencies) {
  return createVenvManager({
    config: {
      dshHome: resolveDshHome(deps.env),
      engineVersion: PINNED.pptMaster,
      pythonVersion: PINNED.python,
      requirementsFile: packageAsset('python-assets/requirements.lock'),
      indexUrl: deps.env.DSH_PPT_PYPI_INDEX ?? DEFAULT_PYPI_INDEX,
    },
    runner: deps.runner,
    fs: deps.fs,
    env: deps.env,
  })
}

/**
 * @param dir - absolute deck workspace.
 * @param deps - command dependencies.
 * @returns the ppt-master process layer bound to that workspace.
 */
export function engineFor(dir: string, deps: CommandDependencies) {
  return createMasterEngine({ workspace: dir, venv: venvManagerFor(deps), log: createWorkspaceLogSink({ workspace: dir, fs: deps.fs }) })
}

/**
 * Wrap the injected runner so every child process of a deck command is logged
 * under that deck, as plan §3.12 requires.
 *
 * @param dir - deck workspace owning the log directory.
 * @param deps - command dependencies.
 * @returns the logging runner.
 */
export function loggedRunnerFor(dir: string, deps: CommandDependencies): Runner {
  return createLoggingRunner({ runner: deps.runner, sink: createWorkspaceLogSink({ workspace: dir, fs: deps.fs }) })
}
