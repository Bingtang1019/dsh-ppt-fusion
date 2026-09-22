import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, win32 } from 'node:path'
import { DshPptFailure, tailOf } from './errors.ts'
import type { EngineInvocation } from './contracts.ts'
import { ENGINE_ENV, buildEnv, type RunResult, type Runner } from './runner.ts'

/** Filesystem operations the venv manager needs; injected so tests never touch disk. */
export interface FileSystemPort {
  exists(path: string): boolean
  isDirectory(path: string): boolean
  listDir(path: string): string[]
  readText(path: string): string | null
  writeText(path: string, text: string): void
  /** Byte reader for binary artifacts (pptx packages); text readers would corrupt them. */
  readBytes(path: string): Buffer | null
  writeBytes(path: string, bytes: Buffer): void
  /** Move a file, replacing the destination; the atomic publish step needs it. */
  rename(from: string, to: string): void
  removeTree(path: string): void
  mkdirp(path: string): void
}

/** The real filesystem. */
export const nodeFileSystem: FileSystemPort = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listDir: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  writeText: (path, text) => writeFileSync(path, text, 'utf8'),
  readBytes: (path) => {
    try {
      return readFileSync(path)
    } catch {
      return null
    }
  },
  writeBytes: (path, bytes) => writeFileSync(path, bytes),
  rename: (from, to) => renameSync(from, to),
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
}

/** Absolute paths inside one engine venv. */
export interface VenvPaths {
  /** `<dshHome>/ppt-fusion/venvs/ppt-master-<version>`. */
  readonly root: string
  /** Interpreter inside the venv; never resolved through PATH. */
  readonly pythonExe: string
  /** Dispatcher executable inside the venv. */
  readonly engineExe: string
  /** Directory the engine's distributions live in. */
  readonly sitePackages: string
}

/** What `state()` observed about a venv. */
export interface VenvState {
  readonly paths: VenvPaths
  readonly exists: boolean
  readonly pythonPresent: boolean
  readonly enginePresent: boolean
  /** Distribution version found in site-packages, or null. */
  readonly installedVersion: string | null
  /** Human-readable problems; empty means the venv is usable. */
  readonly problems: readonly string[]
  readonly ok: boolean
}

/** How uv was located. */
export interface UvResolution {
  /** Executable to invoke. */
  readonly command: string
  /** Arguments that must precede the uv subcommand (used for `python -m uv`). */
  readonly baseArgs: readonly string[]
  /** Which rule found it, for `doctor` output. */
  readonly source: 'DSH_PPT_UV' | 'local-packages' | 'user-bin' | 'path' | 'python-module'
}

/** Configuration for one engine venv. */
export interface VenvConfig {
  /** `$DSH_HOME`; holds the venv tree and nothing else. */
  readonly dshHome: string
  /** Pinned engine version, e.g. `0.1.128`. */
  readonly engineVersion: string
  /** Python series used to build the venv, e.g. `3.13`. */
  readonly pythonVersion: string
  /** Locked requirements file consumed by `uv pip install -r`. */
  readonly requirementsFile: string
  /** Package index; defaults to the Tsinghua mirror used on this machine. */
  readonly indexUrl: string
}

/** Default package index for engine installs. */
export const DEFAULT_PYPI_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/**
 * @param env - environment to read.
 * @returns `$DSH_HOME`, falling back to `~/.dsh`.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * @param dshHome - `$DSH_HOME`.
 * @param engineVersion - pinned engine version.
 * @param pythonVersion - Python series, used for the POSIX site-packages path.
 * @param platform - platform id; defaults to the running one.
 * @returns the venv's absolute paths.
 */
export function venvPaths(
  dshHome: string,
  engineVersion: string,
  pythonVersion: string,
  platform: NodeJS.Platform = process.platform,
): VenvPaths {
  // The layout follows the argument, not the host, so the same call produces the
  // same paths everywhere and the CI leg for the other platform is testable.
  const windows = platform === 'win32'
  const join = windows ? win32.join : posix.join
  const root = join(dshHome, 'ppt-fusion', 'venvs', `ppt-master-${engineVersion}`)
  return {
    root,
    pythonExe: windows ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python'),
    engineExe: windows ? join(root, 'Scripts', 'ppt-master.exe') : join(root, 'bin', 'ppt-master'),
    sitePackages: windows ? join(root, 'Lib', 'site-packages') : join(root, 'lib', `python${pythonVersion}`, 'site-packages'),
  }
}

/**
 * Locate uv without relying on PATH.
 *
 * M0 measured that uv exists only inside the Windows Store interpreter's
 * `local-packages` script directory, so that location is searched first; PATH
 * and `python -m uv` remain as fallbacks for other machines and for CI.
 *
 * @param options.runner - process runner used for the PATH and module probes.
 * @param options.fs - filesystem port.
 * @param options.env - environment to inspect.
 * @param options.localAppData - `%LOCALAPPDATA%`, injected for tests.
 * @returns the uv invocation.
 * @throws DshPptFailure `UvMissing` when no candidate works.
 */
export function resolveUv(options: {
  runner: Runner
  fs: FileSystemPort
  env?: NodeJS.ProcessEnv
  localAppData?: string
  platform?: NodeJS.Platform
}): UvResolution {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exeName = platform === 'win32' ? 'uv.exe' : 'uv'
  const override = env.DSH_PPT_UV
  if (override !== undefined && override.trim() !== '' && isAbsolute(override) && options.fs.exists(override)) {
    return { command: override, baseArgs: [], source: 'DSH_PPT_UV' }
  }

  const localAppData = options.localAppData ?? env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData !== '') {
    const packagesRoot = join(localAppData, 'Packages')
    for (const storeDir of options.fs.listDir(packagesRoot)) {
      if (!storeDir.startsWith('PythonSoftwareFoundation.Python.')) continue
      const localPackages = join(packagesRoot, storeDir, 'LocalCache', 'local-packages')
      for (const series of options.fs.listDir(localPackages)) {
        const candidate = join(localPackages, series, 'Scripts', exeName)
        if (options.fs.exists(candidate)) return { command: candidate, baseArgs: [], source: 'local-packages' }
      }
    }
  }

  const userBin = join(homedir(), platform === 'win32' ? join('.local', 'bin', exeName) : join('.local', 'bin', exeName))
  if (options.fs.exists(userBin)) return { command: userBin, baseArgs: [], source: 'user-bin' }

  const probe = options.runner(platform === 'win32' ? 'where.exe' : 'which', [exeName], {
    cwd: homedir(),
    timeoutMs: 20_000,
    env: buildEnv({ source: env }),
  })
  const found = probe.status === 0 ? probe.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') : undefined
  if (found !== undefined) return { command: found, baseArgs: [], source: 'path' }

  const python = platform === 'win32' ? 'python' : 'python3'
  const moduleProbe = options.runner(python, ['-m', 'uv', '--version'], {
    cwd: homedir(),
    timeoutMs: 30_000,
    env: buildEnv({ source: env }),
  })
  if (moduleProbe.status === 0) return { command: python, baseArgs: ['-m', 'uv'], source: 'python-module' }

  throw new DshPptFailure('UvMissing', 'uv was not found; set DSH_PPT_UV to its absolute path or install it with `python -m pip install --user uv`', {
    detail: { searched: ['DSH_PPT_UV', 'local-packages', '~/.local/bin', 'PATH', 'python -m uv'] },
  })
}

/**
 * Create the engine venv manager.
 *
 * `install` and `repair` are the only operations that touch the network, and
 * callers reach them from `doctor`/`install` only: the DSH boot path never
 * installs anything.
 *
 * @param options.config - venv location, pinned version, lock file and index.
 * @param options.runner - process runner.
 * @param options.fs - filesystem port.
 * @param options.env - environment for uv invocations.
 * @returns the manager used by `doctor`, `engine/master.ts`, and the CLI.
 */
export function createVenvManager(options: {
  config: VenvConfig
  runner: Runner
  fs?: FileSystemPort
  env?: NodeJS.ProcessEnv
}) {
  const fs = options.fs ?? nodeFileSystem
  const env = options.env ?? process.env
  const { config } = options
  const paths = venvPaths(config.dshHome, config.engineVersion, config.pythonVersion)

  const runUv = (uv: UvResolution, args: readonly string[], timeoutMs: number): RunResult =>
    options.runner(uv.command, [...uv.baseArgs, ...args], {
      cwd: config.dshHome,
      timeoutMs,
      env: buildEnv({ source: env }),
    })

  const state = (): VenvState => {
    const exists = fs.isDirectory(paths.root)
    const pythonPresent = fs.exists(paths.pythonExe)
    const enginePresent = fs.exists(paths.engineExe)
    const distributions = fs.listDir(paths.sitePackages).filter((entry) => entry.startsWith('ppt_master-') && entry.endsWith('.dist-info'))
    const versionMatch = /^ppt_master-(.+)\.dist-info$/.exec(distributions[0] ?? '')
    const installedVersion = versionMatch?.[1] ?? null
    const problems: string[] = []
    if (!exists) problems.push(`venv directory is absent: ${paths.root}`)
    else {
      if (!pythonPresent) problems.push(`interpreter is absent: ${paths.pythonExe}`)
      if (!enginePresent) problems.push(`engine executable is absent: ${paths.engineExe}`)
      if (installedVersion === null) problems.push('no ppt_master distribution found in site-packages')
      else if (installedVersion !== config.engineVersion) {
        problems.push(`installed engine is ${installedVersion}, pinned version is ${config.engineVersion}`)
      }
    }
    return { paths, exists, pythonPresent, enginePresent, installedVersion, problems, ok: problems.length === 0 }
  }

  const assertLockFile = (): string => {
    if (!fs.exists(config.requirementsFile)) {
      throw new DshPptFailure('OutputMissing', `locked requirements file is absent: ${config.requirementsFile}`, {
        detail: { requirementsFile: config.requirementsFile },
      })
    }
    return config.requirementsFile
  }

  const install = (): { uv: UvResolution; created: boolean; installOutput: string } => {
    const uv = resolveUv({ runner: options.runner, fs, env })
    const lockFile = assertLockFile()
    fs.mkdirp(join(config.dshHome, 'ppt-fusion', 'venvs'))
    if (!fs.exists(paths.pythonExe)) {
      const created = runUv(uv, ['venv', '--python', config.pythonVersion, paths.root], 600_000)
      if (created.status !== 0) {
        throw new DshPptFailure('SpawnFailed', `uv venv failed: ${tailOf(created.stderr) || `exit ${String(created.status)}`}`, {
          detail: { command: uv.command, source: uv.source },
        })
      }
    }
    const installed = runUv(
      uv,
      ['pip', 'install', '--python', paths.pythonExe, '--index-url', config.indexUrl, '-r', lockFile],
      900_000,
    )
    if (installed.status !== 0) {
      throw new DshPptFailure('EngineExit', `uv pip install failed: ${tailOf(installed.stderr) || `exit ${String(installed.status)}`}`, {
        detail: { indexUrl: config.indexUrl },
      })
    }
    return { uv, created: true, installOutput: installed.stdout }
  }

  /**
   * Bring the venv to the pinned state.
   *
   * @param options.force - remove the directory first and rebuild from scratch.
   */
  const ensure = (ensureOptions: { force?: boolean } = {}): VenvState => {
    if (ensureOptions.force === true && fs.exists(paths.root)) fs.removeTree(paths.root)
    const before = state()
    if (before.ok) return before
    install()
    const after = state()
    if (!after.ok) {
      throw new DshPptFailure('EngineVersionMismatch', `engine venv is unusable after install: ${after.problems.join('; ')}`, {
        detail: { problems: after.problems, root: paths.root },
      })
    }
    return after
  }

  /**
   * Run one registered engine invocation.
   *
   * @param invocation - argv, timeout and expected outputs from `contracts.ts`.
   * @param runOptions.workspace - absolute deck workspace; also the child's cwd.
   * @param runOptions.allowCredentials - parent variables to pass through.
   * @returns the raw result plus the resolved absolute output paths.
   * @throws DshPptFailure for a missing venv, a timeout, a non-zero exit, or a
   *   missing contracted output file.
   */
  const run = (
    invocation: EngineInvocation,
    runOptions: { workspace: string; allowCredentials?: readonly string[] },
  ): { result: RunResult; outputFiles: readonly string[] } => {
    const current = state()
    if (!current.ok) {
      const missing = !current.exists
      throw new DshPptFailure(
        missing ? 'VenvMissing' : 'EngineVersionMismatch',
        missing
          ? `engine venv is absent at ${paths.root}; run \`dsh-ppt doctor --repair\``
          : `engine venv is unusable: ${current.problems.join('; ')}`,
        { detail: { root: paths.root, problems: current.problems } },
      )
    }
    const result = options.runner(paths.engineExe, invocation.argv, {
      cwd: runOptions.workspace,
      timeoutMs: invocation.timeoutMs,
      env: buildEnv({ source: env, extra: ENGINE_ENV, allowCredentials: runOptions.allowCredentials }),
    })
    if (result.timedOut) {
      throw new DshPptFailure('EngineTimeout', `${invocation.id} exceeded ${invocation.timeoutMs} ms and was killed`, {
        detail: { id: invocation.id, timeoutMs: invocation.timeoutMs },
      })
    }
    if (result.spawnError !== null) {
      throw new DshPptFailure('SpawnFailed', `cannot start ${paths.engineExe} in ${runOptions.workspace}: ${result.spawnErrorMessage || result.spawnError}`, {
        detail: { id: invocation.id, spawnError: result.spawnError, cwd: runOptions.workspace },
      })
    }
    if (result.status !== 0) {
      throw new DshPptFailure('EngineExit', `${invocation.id} exited ${String(result.status)}: ${tailOf(result.stderr) || tailOf(result.stdout)}`, {
        detail: { id: invocation.id, status: result.status, stderr: tailOf(result.stderr, 40) },
      })
    }
    const outputFiles = invocation.outputFiles.map((entry) => {
      const absolute = isAbsolute(entry) ? entry : join(runOptions.workspace, entry)
      if (!fs.exists(absolute)) {
        throw new DshPptFailure('OutputMissing', `${invocation.id} exited 0 but did not write ${entry}`, {
          detail: { id: invocation.id, missing: entry, expected: absolute },
        })
      }
      return absolute
    })
    return { result, outputFiles }
  }

  return { config, paths, state, ensure, install, run, runUv }
}
