import { isDshPptFailure, DshPptFailure } from '../engine/errors.ts'
import { promptAudit } from '../engine/contracts.ts'
import { packageAsset, packageRoot } from '../package-paths.ts'
import { venvManagerFor, type CommandDependencies } from './context.ts'

/** Options for `dsh-ppt skill audit`. */
export interface SkillAuditOptions {
  /** Treat warnings as failures, matching `audit --strict`. */
  readonly strict: boolean
  readonly deps: CommandDependencies
  /** Repository root holding the manifest's document globs; defaults to the package root. */
  readonly root?: string
  /** Audit manifest, absolute or root-relative; defaults to the shipped manifest. */
  readonly manifest?: string
}

/** One `prompt-audit` finding, normalized to the fusion finding vocabulary. */
export interface SkillAuditFinding {
  readonly level: 'error' | 'warning'
  /** Stable engine code, e.g. `REFERENCE_MISSING` or `DUPLICATE_EXACT_CANDIDATES`. */
  readonly code: string
  readonly message: string
  /** Corpus-relative file the finding is about, or an empty string for a global one. */
  readonly path: string
  /** 1-based line, or 0 for a global finding. */
  readonly line: number
}

/** Report returned by `dsh-ppt skill audit --json` and used by `dsh-ppt audit`. */
export interface SkillAuditReport {
  readonly ok: boolean
  readonly strict: boolean
  /** Absolute repository root the audit scanned. */
  readonly root: string
  readonly manifest: string
  readonly files: number
  readonly tokens: number
  readonly maxTokens: number
  readonly errors: number
  readonly warnings: number
  readonly findings: readonly SkillAuditFinding[]
}

/** The subset of the engine report this package reads; unknown fields are ignored. */
interface EnginePromptAuditReport {
  readonly summary?: {
    readonly files?: unknown
    readonly tokens?: unknown
    readonly max_tokens?: unknown
    readonly errors?: unknown
    readonly warnings?: unknown
  }
  readonly findings?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/**
 * Run the engine budget gate over the shipped SKILL and its vendored references.
 *
 * The engine reports its findings as JSON on stdout and exits non-zero when it
 * found errors, so an `EngineExit` carrying a parseable report is a result, not a
 * crash. A missing report or an `AUDIT_SETUP_ERROR` envelope is a failure.
 *
 * @param options - strictness, dependencies and optional root/manifest overrides.
 * @returns the normalized report; `ok` follows the requested strictness.
 * @throws DshPptFailure `VenvMissing`, `EngineExit`, `OutputMissing` or `SpawnFailed`.
 */
export function runSkillAudit(options: SkillAuditOptions): SkillAuditReport {
  const root = options.root ?? packageRoot()
  const manifest = options.manifest ?? packageAsset('skills/dsh-ppt-fusion/prompt_audit_manifest.json')
  const invocation = promptAudit({ root, manifest })
  const stdout = runEngine(options.deps, invocation, root)
  const report = parseEngineReport(stdout)

  const findings = normalizeFindings(report.findings)
  const files = numberField(report.summary?.files, 'summary.files', stdout)
  const tokens = numberField(report.summary?.tokens, 'summary.tokens', stdout)
  const maxTokens = numberField(report.summary?.max_tokens, 'summary.max_tokens', stdout)
  const errors = findings.filter((finding) => finding.level === 'error').length
  const warnings = findings.length - errors
  return {
    ok: errors === 0 && (!options.strict || warnings === 0),
    strict: options.strict,
    root,
    manifest,
    files,
    tokens,
    maxTokens,
    errors,
    warnings,
    findings,
  }
}

/**
 * @param report - the audited report.
 * @returns the one-line summary plus one line per finding.
 */
export function formatSkillAuditReport(report: SkillAuditReport): string {
  const verdict = report.ok ? 'OK' : report.strict && report.errors === 0 ? 'FAIL (--strict)' : 'FAIL'
  const lines = [
    `prompt-audit: ${String(report.files)} files, ${String(report.tokens)}/${String(report.maxTokens)} tokens, ${String(report.errors)} error(s), ${String(report.warnings)} warning(s) — ${verdict}`,
  ]
  for (const finding of report.findings) {
    const where = finding.path === '' ? '' : ` ${finding.path}${finding.line > 0 ? `:${String(finding.line)}` : ''}`
    lines.push(`  [${finding.level.toUpperCase()}] ${finding.code}${where}: ${finding.message}`)
  }
  return lines.join('\n')
}

/**
 * Run one engine invocation, keeping the report of a non-zero exit.
 *
 * @param deps - command dependencies.
 * @param invocation - the rehearsed `prompt-audit` argv.
 * @param root - the audited repository root, used as the child's cwd.
 * @returns captured stdout.
 * @throws DshPptFailure when the venv is missing, the child cannot start, or the
 *   exit carries no report.
 */
function runEngine(deps: CommandDependencies, invocation: ReturnType<typeof promptAudit>, root: string): string {
  try {
    return venvManagerFor(deps).run(invocation, { workspace: root }).result.stdout
  } catch (error) {
    if (isDshPptFailure(error) && error.code === 'EngineExit' && typeof error.detail.stdout === 'string') {
      return error.detail.stdout
    }
    throw error
  }
}

/**
 * @param stdout - engine stdout.
 * @returns the parsed report.
 * @throws DshPptFailure `EngineExit` for the engine's setup-error envelope,
 *   `OutputMissing` when stdout is not a report.
 */
function parseEngineReport(stdout: string): EnginePromptAuditReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    throw new DshPptFailure('OutputMissing', `prompt-audit did not print a JSON report: ${firstLine(stdout) || '(empty stdout)'}`, {
      detail: { stdout: firstLine(stdout) },
    })
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new DshPptFailure('OutputMissing', 'prompt-audit printed JSON that is not a report object', { detail: { stdout: firstLine(stdout) } })
  }
  const report = parsed as EnginePromptAuditReport
  if (report.error !== undefined) {
    const code = typeof report.error.code === 'string' ? report.error.code : 'AUDIT_SETUP_ERROR'
    const message = typeof report.error.message === 'string' ? report.error.message : 'no message'
    throw new DshPptFailure('EngineExit', `prompt-audit could not run: ${code} ${message}`)
  }
  if (report.summary === undefined || report.findings === undefined) {
    throw new DshPptFailure('OutputMissing', 'prompt-audit report has no summary or findings', { detail: { stdout: firstLine(stdout) } })
  }
  if (!Array.isArray(report.findings)) {
    throw new DshPptFailure('OutputMissing', 'prompt-audit findings is not an array', { detail: { stdout: firstLine(stdout) } })
  }
  return report
}

/** @returns the findings with only the fields the fusion vocabulary keeps. */
function normalizeFindings(raw: unknown): SkillAuditFinding[] {
  const findings: SkillAuditFinding[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as { severity?: unknown; code?: unknown; message?: unknown; path?: unknown; line?: unknown }
    findings.push({
      level: candidate.severity === 'error' ? 'error' : 'warning',
      code: typeof candidate.code === 'string' ? candidate.code : 'prompt-audit',
      message: typeof candidate.message === 'string' ? candidate.message : 'prompt-audit finding',
      path: typeof candidate.path === 'string' ? candidate.path : '',
      line: typeof candidate.line === 'number' ? candidate.line : 0,
    })
  }
  return findings
}

/** @returns a required numeric summary field. @throws DshPptFailure `OutputMissing`. */
function numberField(value: unknown, label: string, stdout: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new DshPptFailure('OutputMissing', `prompt-audit report field ${label} is missing or not a number`, { detail: { stdout: firstLine(stdout) } })
}

/** @returns the first non-empty line, trimmed. */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? ''
}
