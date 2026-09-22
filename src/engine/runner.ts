import { spawnSync } from 'node:child_process'

/**
 * One child-process invocation. Every external boundary in this package goes
 * through this shape so tests can drive it without spawning anything.
 */
export interface RunOptions {
  /** Working directory; callers pass a directory inside the deck workspace. */
  cwd: string
  /** Hard wall-clock limit; the child is killed when it expires. */
  timeoutMs: number
  /** Full environment to hand the child (build it with `buildEnv`). */
  env: NodeJS.ProcessEnv
  /** Captured-output ceiling; exceeding it fails the run. */
  maxBufferBytes?: number
}

/** Result of one child-process invocation, normalized across success and failure. */
export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  /** True when the run was killed by the timeout rather than by the program. */
  timedOut: boolean
  /** Node-level spawn error code (`ENOENT`, `EACCES`, …) or null. */
  spawnError: string | null
  /** Message that accompanied `spawnError`. */
  spawnErrorMessage: string
}

/** A function that runs one child process. */
export type Runner = (command: string, args: readonly string[], options: RunOptions) => RunResult

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * Environment variables inherited from the parent process.
 *
 * This is a whitelist, not a filter: a variable that is absent here never reaches
 * an engine or the front end, so credentials cannot leak into a child by
 * accident. Add a variable only when a command genuinely needs it, and pass it
 * through `allowCredentials` rather than widening this list.
 */
const INHERITED_ENV_KEYS: readonly string[] = [
  // Process launching and shell resolution
  'path',
  'pathext',
  'comspec',
  'systemroot',
  'systemdrive',
  'windir',
  'os',
  // Temporary and per-user directories
  'temp',
  'tmp',
  'tmpdir',
  'home',
  'homedrive',
  'homepath',
  'userprofile',
  'appdata',
  'localappdata',
  'programdata',
  'public',
  'programfiles',
  'programfiles(x86)',
  'programw6432',
  'commonprogramfiles',
  'commonprogramfiles(x86)',
  'commonprogramw6432',
  // Locale and code page
  'lang',
  'language',
  'lc_all',
  'lc_ctype',
  'tz',
  'term',
  // Network appliances: a user proxy (and its CA bundle) is a deployment fact, not a
  // credential, so the standard variables are inherited when the user sets them. The
  // fusion never sets them itself (ADR-043).
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'requests_ca_bundle',
  'curl_ca_bundle',
  'ssl_cert_file',
  'node_extra_ca_certs',
  // CPU reporting (some Python wheels read it at import time)
  'number_of_processors',
  'processor_architecture',
  'processor_identifier',
  'processor_level',
  'processor_revision',
]

/** Environment variables this package always sets for the Python engine. */
export const ENGINE_ENV: Readonly<Record<string, string>> = {
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONNOUSERSITE: '1',
}

/** The subset of the parent environment this package is willing to inherit. */
export function systemEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  const allowed = new Set(INHERITED_ENV_KEYS)
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (allowed.has(key.toLowerCase())) kept[key] = value
  }
  return kept
}

/**
 * Build the environment for one child process.
 *
 * @param options.extra - variables the command needs, applied last.
 * @param options.allowCredentials - names of parent variables to pass through
 *   even though they are not inherited by default (for example a stock-photo
 *   API key for `images search`). Anything not named here is dropped.
 * @param options.source - parent environment; defaults to `process.env`.
 * @returns the complete environment for `RunOptions.env`.
 */
export function buildEnv(
  options: { extra?: Record<string, string>; allowCredentials?: readonly string[]; source?: NodeJS.ProcessEnv } = {},
): NodeJS.ProcessEnv {
  const source = options.source ?? process.env
  const env = systemEnv(source)
  for (const name of options.allowCredentials ?? []) {
    const value = source[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) env[key] = value
  return env
}

/**
 * Run a child process and capture its output.
 *
 * Pipes are used deliberately: M0 measured every stdio mode on this platform and
 * none of them fails, so the file-contract style is a design choice for large
 * payloads rather than a workaround. Bulk artifacts still travel through files
 * because that keeps them replayable.
 *
 * @param command - absolute executable path.
 * @param args - argv without the program name.
 * @param options - working directory, timeout, environment, output ceiling.
 * @returns normalized result; the caller classifies failures.
 */
export const spawnRunner: Runner = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const error = result.error as (Error & { code?: string }) | undefined
  return {
    status: result.status ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: error?.code === 'ETIMEDOUT',
    spawnError: typeof error?.code === 'string' ? error.code : error === undefined ? null : 'UNKNOWN',
    spawnErrorMessage: error?.message ?? '',
  }
}
