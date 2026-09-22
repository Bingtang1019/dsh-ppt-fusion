import { join } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { parseCheckpoint, type CheckpointPhase } from '../schema/checkpoint.ts'
import { resolveDeckDir, type CommandDependencies } from './context.ts'

/** Options for `dsh-ppt resume`. */
export interface ResumeOptions {
  readonly dir: string
  /** Also write the brief to `.dsh-ppt/resume.md`. */
  readonly write: boolean
  readonly deps: CommandDependencies
}

/** One artifact the checkpoint claims, resolved against the deck. */
export interface ResumeArtifact {
  /** Workspace-relative path as written in the checkpoint, with forward slashes. */
  readonly path: string
  readonly exists: boolean
}

/** The published package recorded by `out/manifest.json`, when one exists. */
export interface ResumePublished {
  readonly file: string
  readonly sha256: string
  readonly bytes: number
  readonly slides: number
}

/** Report returned by `dsh-ppt resume --json`. */
export interface ResumeReport {
  /** False when the checkpoint claims an artifact that is no longer there. */
  readonly ok: boolean
  readonly dir: string
  readonly checkpoint: string
  readonly version: number
  readonly phase: CheckpointPhase
  readonly deck: string | null
  readonly updatedAt: string | null
  readonly notes: string
  readonly artifacts: readonly ResumeArtifact[]
  readonly missing: readonly string[]
  /** Non-fatal inconsistencies, e.g. an unreadable `out/manifest.json`. */
  readonly problems: readonly string[]
  readonly published: ResumePublished | null
  /** Commands the next phase runs, in order. */
  readonly next: readonly string[]
  /** `.dsh-ppt/resume.md` when `--write` was given and the brief was written. */
  readonly written: string | null
}

/**
 * Read `.dsh-ppt/checkpoint.json` and report where the workflow stopped.
 *
 * The checkpoint is written by the SKILL at the end of every phase; this command
 * never guesses progress from the filesystem. It checks the artifacts the
 * checkpoint claims and points at the next phase's commands, and it reads
 * `out/manifest.json` so a published package is reported from its own hash
 * rather than from the model's memory.
 *
 * @param options - deck directory, `--write`, and dependencies.
 * @returns the resume report; `ok` is false when a claimed artifact is missing.
 * @throws DshPptFailure `OutputMissing` when no checkpoint exists, `ContractViolation`
 *   when it is not JSON or violates the schema, `PathOutsideWorkspace` for an
 *   artifact path that escapes the deck.
 */
export function runResume(options: ResumeOptions): ResumeReport {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const checkpointFile = join('.dsh-ppt', 'checkpoint.json')
  const text = fs.readText(join(dir, checkpointFile))
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `${checkpointFile} does not exist under ${dir}; the SKILL writes it at the end of every phase`, {
      detail: { expected: join(dir, checkpointFile) },
    })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${checkpointFile} is not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { path: checkpointFile },
    })
  }
  const checkpoint = parseCheckpoint(raw)

  const artifacts: ResumeArtifact[] = []
  const missing: string[] = []
  for (const entry of checkpoint.artifacts) {
    const absolute = assertInsideWorkspace(dir, entry, 'artifacts[]')
    const exists = fs.exists(absolute)
    const relative = entry.replace(/\\/g, '/').replace(/^\.\//, '')
    artifacts.push({ path: relative, exists })
    if (!exists) missing.push(relative)
  }

  const problems: string[] = []
  const published = readPublished(fs, dir, problems)
  const report: ResumeReport = {
    ok: missing.length === 0,
    dir,
    checkpoint: checkpointFile.replace(/\\/g, '/'),
    version: checkpoint.version,
    phase: checkpoint.phase,
    deck: checkpoint.deck ?? null,
    updatedAt: checkpoint.updatedAt ?? null,
    notes: checkpoint.notes,
    artifacts,
    missing,
    problems,
    published,
    next: nextCommands(checkpoint.phase, dir),
    written: null,
  }
  if (!options.write) return report
  const brief = join(dir, '.dsh-ppt', 'resume.md')
  fs.mkdirp(join(dir, '.dsh-ppt'))
  fs.writeText(brief, formatResumeBrief(report))
  return { ...report, written: '.dsh-ppt/resume.md' }
}

/**
 * @param report - the resume report.
 * @returns the one-line status plus the next commands and any missing artifacts.
 */
export function formatResumeReport(report: ResumeReport): string {
  const lines = [
    `resume ${report.dir}: checkpoint phase ${report.phase}, ${String(report.artifacts.length - report.missing.length)}/${String(report.artifacts.length)} artifact(s) present` +
      `${report.published === null ? '' : `, published ${report.published.file}`}`,
  ]
  for (const problem of report.problems) lines.push(`problem: ${problem}`)
  for (const path of report.missing) lines.push(`missing: ${path}`)
  if (report.notes !== '') lines.push(`notes: ${report.notes}`)
  lines.push('next:')
  for (const command of report.next) lines.push(`  - ${command}`)
  if (report.written !== null) lines.push(`wrote ${report.written}`)
  return lines.join('\n')
}

/** @returns the markdown brief `--write` persists for a fresh session. */
export function formatResumeBrief(report: ResumeReport): string {
  const lines = [
    `# Resume brief`,
    '',
    `- deck: \`${report.dir}\``,
    `- checkpoint: \`${report.checkpoint}\` (phase ${report.phase}${report.updatedAt === null ? '' : `, updated ${report.updatedAt}`})`,
    `- artifacts: ${String(report.artifacts.length - report.missing.length)}/${String(report.artifacts.length)} present`,
  ]
  if (report.published !== null) {
    lines.push(`- published: \`${report.published.file}\` sha256 \`${report.published.sha256}\` (${String(report.published.slides)} slides)`)
  }
  for (const problem of report.problems) lines.push(`- problem: ${problem}`)
  for (const path of report.missing) lines.push(`- missing: \`${path}\``)
  if (report.notes !== '') lines.push('', `Notes: ${report.notes}`)
  lines.push('', '## Next commands', '')
  for (const command of report.next) lines.push(`1. \`${command}\``)
  return `${lines.join('\n')}\n`
}

/**
 * @param phase - the last completed phase, as the checkpoint records it.
 * @param dir - absolute deck directory, substituted into the commands.
 * @returns the entry commands of the next phase, in order.
 */
export function nextCommands(phase: CheckpointPhase, dir: string): string[] {
  const commands: Record<CheckpointPhase, readonly string[]> = {
    '0': [`dsh-ppt init ${dir}`],
    '1': ['dsh-ppt theme list', `dsh-ppt theme try <ids>`],
    '2': [`dsh-ppt plan ${dir}`],
    '3': [`dsh-ppt validate ${dir}`],
    '4': [`dsh-ppt validate ${dir}`, `dsh-ppt deep render ${dir}`, `dsh-ppt audit ${dir}`],
    '5': [`dsh-ppt render ${dir}`],
    '6': [`dsh-ppt audit ${dir} --pixels`],
    '7': [`dsh-ppt audit ${dir} --strict`],
  }
  return [...commands[phase]]
}

/**
 * Read the published package description, if `out/manifest.json` exists and is readable.
 *
 * @param fs - filesystem port.
 * @param dir - deck directory.
 * @param problems - collector for non-fatal inconsistencies.
 * @returns the published fields, or null when nothing is published.
 */
function readPublished(fs: CommandDependencies['fs'], dir: string, problems: string[]): ResumePublished | null {
  const text = fs.readText(join(dir, 'out', 'manifest.json'))
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    problems.push('out/manifest.json is not JSON; run `dsh-ppt render` again')
    return null
  }
  const manifest = parsed as { file?: unknown; sha256?: unknown; bytes?: unknown; slides?: unknown }
  if (typeof manifest.file !== 'string' || typeof manifest.sha256 !== 'string' || typeof manifest.bytes !== 'number' || typeof manifest.slides !== 'number') {
    problems.push('out/manifest.json is missing file/sha256/bytes/slides; run `dsh-ppt render` again')
    return null
  }
  return { file: manifest.file, sha256: manifest.sha256, bytes: manifest.bytes, slides: manifest.slides }
}
