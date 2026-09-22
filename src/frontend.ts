import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DshPptFailure, tailOf } from './engine/errors.ts'
import { buildEnv, type RunResult, type Runner } from './engine/runner.ts'

/** Wall-clock budgets for the front-end commands. */
export const FRONTEND_TIMEOUTS = {
  validate: 120_000,
  render: 600_000,
  audit: 300_000,
  themes: 60_000,
  themeNew: 120_000,
  themeTry: 300_000,
  brandExtract: 300_000,
  doctor: 600_000,
} as const

/** A resolved pptwise installation. */
export interface PptwiseCli {
  /** Absolute path to the package root. */
  readonly packageDir: string
  /** Absolute path to `dist/cli.js`. */
  readonly cliPath: string
  /** Version declared by the package manifest. */
  readonly version: string
}

/** Resolves a module specifier to a file URL string. */
export type ModuleResolver = (specifier: string) => string

/** Default resolver: the same resolution Node would perform for this package. */
export const importMetaResolver: ModuleResolver = (specifier) => import.meta.resolve(specifier)

/**
 * Locate the pinned pptwise CLI.
 *
 * pptwise seals its JavaScript API (nothing is exported through its package
 * `exports` map), so the CLI plus its JSON and file output is the only supported
 * interface; this is the one place that finds it.
 *
 * @param options.resolve - module resolver, injected in tests.
 * @param options.readText - file reader, injected in tests.
 * @returns package directory, CLI path and declared version.
 * @throws DshPptFailure `PptwiseMissing` when the package or its CLI is absent.
 */
export function resolvePptwiseCli(
  options: { resolve?: ModuleResolver; readText?: (path: string) => string } = {},
): PptwiseCli {
  const resolveModule = options.resolve ?? importMetaResolver
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'))
  let manifestUrl: string
  try {
    manifestUrl = resolveModule('@liustack/pptwise/package.json')
  } catch (error) {
    throw new DshPptFailure('PptwiseMissing', 'pptwise is not installed; run `pnpm add @liustack/pptwise@0.35.0`', {
      detail: { specifier: '@liustack/pptwise/package.json' },
      cause: error,
    })
  }
  const manifestPath = manifestUrl.startsWith('file:') ? fileURLToPath(manifestUrl) : manifestUrl
  const packageDir = dirname(manifestPath)
  let version = 'unknown'
  try {
    const manifest = JSON.parse(readText(manifestPath)) as { version?: string }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch (error) {
    throw new DshPptFailure('PptwiseMissing', `pptwise manifest is unreadable at ${manifestPath}`, { cause: error })
  }
  const cliPath = join(packageDir, 'dist', 'cli.js')
  try {
    readText(cliPath)
  } catch (error) {
    throw new DshPptFailure('PptwiseMissing', `pptwise CLI entry is absent at ${cliPath}`, {
      detail: { cliPath },
      cause: error,
    })
  }
  return { packageDir, cliPath, version }
}

/** One audit finding, as pptwise emits it. */
export interface AuditFinding {
  readonly page?: number
  readonly slide?: number
  readonly slideId?: string
  readonly code?: string
  readonly severity?: string
  readonly message?: string
  readonly detail?: unknown
}

/** The `audit --json` report envelope. */
export interface AuditReport {
  readonly findings?: readonly AuditFinding[]
  readonly pagesAudited?: number
  readonly pagesSkipped?: number
  readonly checks?: unknown
}

/** Result of a command whose non-zero exit carries data rather than a tool error. */
export interface DataResult<T> {
  readonly status: number
  readonly ok: boolean
  readonly data: T
  readonly stdout: string
  readonly stderr: string
}

/**
 * Extract the outermost JSON value from a command's stdout.
 *
 * M0 measured that some pptwise commands interleave progress lines with the JSON
 * document (the quality checker does the same), so a strict `JSON.parse` of the
 * whole stream is not a valid assumption.
 *
 * @param text - captured stdout.
 * @param context - command name used in the failure message.
 * @returns the parsed value.
 * @throws DshPptFailure `PptwiseFailed` when no JSON document is present.
 */
export function parseJsonPayload<T>(text: string, context: string): T {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T
      } catch (error) {
        throw new DshPptFailure('PptwiseFailed', `${context} printed a JSON-like payload that does not parse`, {
          detail: { stdoutTail: tailOf(text, 20) },
          cause: error,
        })
      }
    }
    throw new DshPptFailure('PptwiseFailed', `${context} printed no JSON payload`, { detail: { stdoutTail: tailOf(text, 20) } })
  }
}

export interface FrontendOptions {
  /** Resolved pptwise CLI. */
  readonly cli: PptwiseCli
  /** Deck workspace used as the child's cwd. */
  readonly workspace: string
  /** Process runner, injected in tests. */
  readonly runner: Runner
  /** Node executable for the CLI; defaults to the running interpreter. */
  readonly nodeExe?: string
  /** Environment source; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Create the pptwise front end.
 *
 * @param options - CLI location, workspace, runner and environment.
 * @returns typed wrappers over the pptwise commands this package drives.
 */
export function createFrontend(options: FrontendOptions) {
  const nodeExe = options.nodeExe ?? process.execPath
  const env = options.env ?? process.env

  const invoke = (args: readonly string[], timeoutMs: number): RunResult =>
    options.runner(nodeExe, [options.cli.cliPath, ...args], {
      cwd: options.workspace,
      timeoutMs,
      env: buildEnv({ source: env }),
    })

  const checkSpawn = (result: RunResult, command: string): void => {
    if (result.timedOut) {
      throw new DshPptFailure('EngineTimeout', `pptwise ${command} exceeded its time budget and was killed`, {
        detail: { command },
      })
    }
    if (result.spawnError !== null) {
      // A missing working directory surfaces as ENOENT on the executable, so the
      // message names the cwd it was started in.
      throw new DshPptFailure('SpawnFailed', `cannot start pptwise in ${options.workspace}: ${result.spawnErrorMessage || result.spawnError}`, {
        detail: { command, spawnError: result.spawnError, cwd: options.workspace },
      })
    }
  }

  const failureFrom = (command: string, result: RunResult): DshPptFailure =>
    new DshPptFailure('PptwiseFailed', `pptwise ${command} exited ${String(result.status)}: ${tailOf(result.stderr) || tailOf(result.stdout)}`, {
      detail: { command, status: result.status, stdout: tailOf(result.stdout, 40), stderr: tailOf(result.stderr, 40) },
    })

  return {
    cli: options.cli,

    /**
     * Validate an IR file or deck project.
     *
     * `validate` reports invalid decks through exit code 1 and a message, so a
     * non-zero exit is data rather than a tool failure.
     */
    validate(target: string): DataResult<{ message: string }> {
      const result = invoke(['validate', target], FRONTEND_TIMEOUTS.validate)
      checkSpawn(result, 'validate')
      if (result.status !== 0 && result.status !== 1) throw failureFrom('validate', result)
      return {
        status: result.status ?? 1,
        ok: result.status === 0,
        data: { message: (result.stdout.trim() || result.stderr.trim()) },
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },

    /** Render an IR file or deck project to a pptx; every non-zero exit is a gate failure. */
    render(target: string, renderOptions: { output?: string; draft?: boolean; allowDroppedContent?: boolean } = {}): {
      outputFile: string | undefined
      stdout: string
    } {
      const args = ['render', target]
      if (renderOptions.output !== undefined) args.push('-o', renderOptions.output)
      if (renderOptions.draft === true) args.push('--draft')
      if (renderOptions.allowDroppedContent === true) args.push('--allow-dropped-content')
      const result = invoke(args, FRONTEND_TIMEOUTS.render)
      checkSpawn(result, 'render')
      if (result.status !== 0) throw failureFrom('render', result)
      const reported = /wrote\s+(.+?)\s+\(/.exec(result.stdout)?.[1]?.trim()
      return { outputFile: reported ?? renderOptions.output, stdout: result.stdout }
    },

    /** Deterministic geometry audit; findings travel in the report, not in the exit code. */
    audit(target: string, auditOptions: { pixels?: boolean } = {}): DataResult<AuditReport> {
      const args = ['audit', target, '--json']
      if (auditOptions.pixels === true) args.push('--pixels')
      const result = invoke(args, FRONTEND_TIMEOUTS.audit)
      checkSpawn(result, 'audit')
      if (result.status !== 0 && result.status !== 1) throw failureFrom('audit', result)
      return {
        status: result.status ?? 1,
        ok: result.status === 0,
        data: parseJsonPayload<AuditReport>(result.stdout, 'pptwise audit'),
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },

    /** List the factory theme catalog. */
    themes(): readonly { id: string; label?: string; occasions?: readonly string[]; identity?: string }[] {
      const result = invoke(['themes', '--json'], FRONTEND_TIMEOUTS.themes)
      checkSpawn(result, 'themes')
      if (result.status !== 0) throw failureFrom('themes', result)
      return parseJsonPayload<{ id: string; label?: string; occasions?: string[]; identity?: string }[]>(result.stdout, 'pptwise themes')
    },

    /** Write a complete ThemeFile v2 by copying a preset; the file must appear. */
    themeNew(params: { from: string; output: string; id?: string }): { outputFile: string } {
      const args = ['theme', 'new', '--from', params.from, '-o', params.output]
      if (params.id !== undefined) args.push('--id', params.id)
      const result = invoke(args, FRONTEND_TIMEOUTS.themeNew)
      checkSpawn(result, 'theme new')
      if (result.status !== 0) throw failureFrom('theme new', result)
      return { outputFile: resolve(options.workspace, params.output) }
    },

    /** Re-derive a theme from a new primary colour, keeping its page menu. */
    themeFork(params: { id: string; primary: string; newId?: string; output?: string }): { stdout: string } {
      const args = ['theme', 'fork', params.id, '--primary', params.primary]
      if (params.newId !== undefined) args.push('--id', params.newId)
      if (params.output !== undefined) args.push('-o', params.output)
      const result = invoke(args, FRONTEND_TIMEOUTS.themeNew)
      checkSpawn(result, 'theme fork')
      if (result.status !== 0) throw failureFrom('theme fork', result)
      return { stdout: result.stdout }
    },

    /** Render the fitting-room sample under 2-4 themes into a contact sheet. */
    themeTry(params: { ids: string; output?: string }): { stdout: string } {
      const args = ['theme', 'try', params.ids]
      if (params.output !== undefined) args.push('-o', params.output)
      const result = invoke(args, FRONTEND_TIMEOUTS.themeTry)
      checkSpawn(result, 'theme try')
      if (result.status !== 0) throw failureFrom('theme try', result)
      return { stdout: result.stdout }
    },

    /** Extract colors and fonts from an Office file into a complete theme. */
    brandExtract(params: { file: string; output: string; from?: string }): { outputFile: string } {
      const args = ['brand', 'extract', params.file, '-o', params.output]
      if (params.from !== undefined) args.push('--from', params.from)
      const result = invoke(args, FRONTEND_TIMEOUTS.brandExtract)
      checkSpawn(result, 'brand extract')
      if (result.status !== 0) throw failureFrom('brand extract', result)
      return { outputFile: resolve(options.workspace, params.output) }
    },

    /** Diagnose the pptwise install; the report is data, a hard failure is not. */
    doctor(): DataResult<Record<string, unknown>> {
      const result = invoke(['doctor', '--json'], FRONTEND_TIMEOUTS.doctor)
      checkSpawn(result, 'doctor')
      if (result.status !== 0 && result.status !== 1) throw failureFrom('doctor', result)
      return {
        status: result.status ?? 1,
        ok: result.status === 0,
        data: parseJsonPayload<Record<string, unknown>>(result.stdout, 'pptwise doctor'),
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },
  }
}

/** The front-end surface, as returned by `createFrontend`. */
export type Frontend = ReturnType<typeof createFrontend>
