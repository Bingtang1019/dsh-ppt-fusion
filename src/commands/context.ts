import { isAbsolute, resolve } from 'node:path'
import { createFrontend, resolvePptwiseCli, type Frontend, type ModuleResolver } from '../frontend.ts'
import { nodeFileSystem, type FileSystemPort } from '../engine/venv.ts'
import { spawnRunner, type Runner } from '../engine/runner.ts'
import { createThemeBridge } from '../bridge/theme.ts'
import { createMasterEngine } from '../engine/master.ts'
import { DEFAULT_PYPI_INDEX, createVenvManager, resolveDshHome } from '../engine/venv.ts'
import { packageAsset } from '../package-paths.ts'
import { createLoggingRunner, createWorkspaceLogSink } from '../logging.ts'
import { PINNED } from './doctor.ts'

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
