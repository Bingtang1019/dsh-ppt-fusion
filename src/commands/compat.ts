import { isAbsolute, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { OpcPackage } from '../bridge/opc.ts'
import { inspectCompat, type CompatFinding, type CompatInspection } from '../bridge/compat.ts'
import type { CompatLevel } from '../compat/registry.ts'
import { resolveDeckDir, type CommandDependencies } from './context.ts'

/** Parameters for `dsh-ppt compat lint`. */
export interface CompatLintOptions {
  /** Directory the file path resolves against; the workspace guard uses it too. */
  readonly dir: string
  readonly file: string
  readonly level: CompatLevel
  /** Promote warning-level findings to failures. */
  readonly strict: boolean
  readonly deps: CommandDependencies
}

/** Everything `compat lint` produced. */
export interface CompatLintResult {
  readonly file: string
  readonly level: CompatLevel
  readonly strict: boolean
  readonly inspection: CompatInspection
  /** Findings that fail the command: every error, plus warnings under `--strict`. */
  readonly failures: readonly CompatFinding[]
  readonly ok: boolean
}

/**
 * Scan and lint one rendered package against the compatibility registry, without
 * changing it. This is the read-only half of the render chain's compat step, so an
 * artifact can be re-checked against another level at any time (plan §3.14 step 4).
 *
 * @param options - file, workspace, level, strictness and dependencies.
 * @returns the inspection plus the findings that make the command fail.
 * @throws DshPptFailure `PathOutsideWorkspace` for a file outside `--dir`, and
 *   `OutputMissing` when the file is unreadable or empty.
 */
export async function compatLint(options: CompatLintOptions): Promise<CompatLintResult> {
  const workspace = resolveDeckDir(options.deps, options.dir)
  const target = assertInsideWorkspace(workspace, isAbsolute(options.file) ? resolve(options.file) : resolve(workspace, options.file), 'file')
  const bytes = options.deps.fs.readBytes(target)
  if (bytes === null || bytes.length === 0) {
    throw new DshPptFailure('OutputMissing', `no package at ${target}`, { detail: { file: target } })
  }
  const pkg = await OpcPackage.read(bytes)
  const inspection = inspectCompat(pkg, { level: options.level })
  const failures = inspection.findings.filter((finding) => finding.level === 'error' || options.strict)
  return { file: target, level: options.level, strict: options.strict, inspection, failures, ok: failures.length === 0 }
}

/** @returns the lint result as the `--json` document. */
export function compatLintDocument(result: CompatLintResult): Record<string, unknown> {
  return {
    file: result.file,
    level: result.level,
    strict: result.strict,
    ok: result.ok,
    counts: {
      occurrences: result.inspection.occurrences.length,
      errors: result.inspection.findings.filter((finding) => finding.level === 'error').length,
      warnings: result.inspection.findings.filter((finding) => finding.level === 'warning').length,
    },
    occurrences: result.inspection.occurrences,
    findings: result.inspection.findings,
  }
}

/**
 * @param result - a lint result.
 * @returns one summary line plus one line per failure and per non-failing warning.
 */
export function formatCompatLint(result: CompatLintResult): string {
  const lines = [
    `compat lint ${result.file}: level=${result.level} registry=v${String(result.inspection.registryVersion)} strict=${result.strict ? 'yes' : 'no'} ${result.ok ? 'ok' : 'failed'} (${String(result.inspection.occurrences.length)} occurrence(s), ${String(result.inspection.findings.length)} finding(s))`,
  ]
  for (const finding of result.inspection.findings) {
    const failing = result.failures.includes(finding)
    lines.push(`  ${failing ? 'FAIL' : 'note'} ${finding.level} ${finding.rule} ${finding.part}: ${finding.message}`)
  }
  return lines.join('\n')
}
