/**
 * Stable failure vocabulary for every `dsh-ppt` subcommand.
 *
 * Each code is a contract: the CLI prints `dsh-ppt: <code> <message>` on stderr
 * and exits non-zero, `audit --json` may reuse the code, and tests assert on the
 * code rather than on message text. Adding a code is non-breaking; renaming one
 * is a breaking change.
 */
export type FailureCode =
  /** The pptwise package is not installed or its CLI entry cannot be resolved. */
  | 'PptwiseMissing'
  /** pptwise exited non-zero or produced unparseable structured output. */
  | 'PptwiseFailed'
  /** The engine venv directory does not exist. */
  | 'VenvMissing'
  /** The venv exists but does not carry the pinned engine version. */
  | 'EngineVersionMismatch'
  /** uv or the interpreter used to build the venv is unavailable. */
  | 'UvMissing'
  /** The child process could not be started at all. */
  | 'SpawnFailed'
  /** The child process exceeded its class timeout and was killed. */
  | 'EngineTimeout'
  /** The child process exited non-zero; `detail.stdout`/`detail.stderr` keep the captured output. */
  | 'EngineExit'
  /** The command exited zero but its contracted output file is absent or empty. */
  | 'OutputMissing'
  /** A caller passed an argument the command registry does not accept. */
  | 'ContractViolation'
  /** A path argument resolved outside the deck workspace. */
  | 'PathOutsideWorkspace'
  /** The doctor run has at least one failed check. */
  | 'DoctorFailed'
  /** The command line itself is wrong. */
  | 'UsageError'

/** A failure that carries a stable code and optional structured detail. */
export class DshPptFailure extends Error {
  readonly code: FailureCode
  readonly detail: Readonly<Record<string, unknown>>

  /**
   * @param code - stable failure code reported to the caller.
   * @param message - one sentence naming the failed subject and the observed state.
   * @param options - `detail` travels into `--json` output; `cause` is preserved for debugging.
   */
  constructor(code: FailureCode, message: string, options: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DshPptFailure'
    this.code = code
    this.detail = options.detail ?? {}
  }
}

/**
 * @param error - value caught from an arbitrary boundary.
 * @returns true when the value is a `DshPptFailure`.
 */
export function isDshPptFailure(error: unknown): error is DshPptFailure {
  return error instanceof DshPptFailure
}

/**
 * @param error - value caught from an arbitrary boundary.
 * @returns the single stderr line the CLI prints for it.
 */
export function formatFailure(error: unknown): string {
  if (isDshPptFailure(error)) return `dsh-ppt: ${error.code} ${error.message}`
  return `dsh-ppt: Internal ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Keep the last lines of a child process's stderr for diagnostics.
 *
 * @param text - captured stderr.
 * @param lines - how many trailing lines to keep.
 * @returns the trimmed tail, or an empty string when nothing was captured.
 */
export function tailOf(text: string, lines = 8): string {
  const kept = text.trimEnd().split(/\r?\n/).slice(-lines).join('\n').trim()
  return kept
}
