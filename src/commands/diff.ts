// `dsh-ppt diff <a> <b>`: compare two worktree versions, or a version against the
// published trunk (ADR-086, plan Part C).
//
// A reference is either `trunk`/`out` or a proposal id. Each side resolves to three
// optional inputs — the package, the audit findings and a directory of page images —
// and the requested modes run on whatever both sides have. A mode whose inputs are
// missing is reported as skipped instead of guessed at, which is what keeps the
// output honest when a draft was proposed without `--render`.
import { join } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { auditDeck } from './audit.ts'
import { resolveArtifact, resolveDeckDir, type CommandDependencies } from './context.ts'
import { readProposal, readTrunk } from '../bridge/worktree.ts'
import { diffAudit, diffRender, diffSemantic, type AuditDelta, type RenderDiff, type SemanticDiff } from '../bridge/deck-diff.ts'
import type { FusionFinding } from '../audit.ts'

/** Everything `diff` needs. */
export interface DiffOptions {
  readonly dir: string
  /** `trunk`, `out`, or a proposal id. */
  readonly left: string
  readonly right: string
  /** Run the T1 page comparison (default when neither mode is named). */
  readonly semantic: boolean
  /** Run the page-image comparison (default when neither mode is named). */
  readonly render: boolean
  /** Run the audit delta (default when neither mode is named). */
  readonly audit: boolean
  readonly deps: CommandDependencies
}

/** One side of a diff, as resolved from the deck. */
export interface DiffSide {
  readonly ref: string
  /** Deck-relative package path, or null when the side has no package. */
  readonly pptx: string | null
  /** Absolute page directory, or null when the side has no snapshots. */
  readonly pages: string | null
  /** Findings recorded for this side, or null when none were available. */
  readonly findings: readonly FusionFinding[] | null
  readonly pinned: boolean | null
}

/** What `diff` produced. */
export interface DiffResult {
  readonly left: DiffSide
  readonly right: DiffSide
  readonly semantic?: SemanticDiff
  readonly audit?: AuditDelta
  readonly render?: RenderDiff
  readonly skipped: readonly string[]
  readonly summary: string
}

/** @param ref - a reference spelling. @returns true for the published trunk. */
function isTrunk(ref: string): boolean {
  return ref === 'trunk' || ref === 'out'
}

/** @param fs - filesystem port. @param root - candidate page root. @returns the directory holding page images, or null. */
function pickPagesDir(fs: CommandDependencies['fs'], root: string): string | null {
  if (!fs.isDirectory(root)) return null
  const entries = fs.listDir(root)
  if (entries.some((name) => /^page-\d+\.png$/.test(name))) return root
  for (const name of entries) {
    const candidate = join(root, name)
    if (fs.isDirectory(candidate) && fs.listDir(candidate).some((file) => /^page-\d+\.png$/.test(file))) return candidate
  }
  return null
}

/** @param fs - filesystem port. @param path - absolute audit record. @returns its findings, or null. */
function readAuditRecord(fs: CommandDependencies['fs'], path: string): FusionFinding[] | null {
  const text = fs.readText(path)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as { findings?: unknown }
    return Array.isArray(parsed.findings) ? (parsed.findings as FusionFinding[]) : null
  } catch {
    return null
  }
}

/**
 * @param input.ref - reference spelling.
 * @param input.dir - absolute deck workspace.
 * @param input.wantAudit - whether the audit delta is needed; the trunk's audit is
 *   reused from the version it published, and recomputed only when no version recorded one.
 * @param input.deps - command dependencies.
 * @returns the resolved side, with `null` for every input it does not have.
 */
async function resolveSide(input: { ref: string; dir: string; wantAudit: boolean; deps: CommandDependencies }): Promise<DiffSide> {
  const { fs } = input.deps
  if (isTrunk(input.ref)) {
    const artifact = resolveArtifact({ dir: input.dir, file: undefined, fs })
    const pages = pickPagesDir(fs, join(input.dir, '.dsh-ppt', 'render'))
    const trunk = readTrunk(fs, input.dir)
    const published = trunk === null ? null : readProposal(fs, input.dir, trunk.id)
    const auditFile = published?.record.files.audit
    const findings =
      auditFile !== undefined
        ? readAuditRecord(fs, join(input.dir, auditFile))
        : input.wantAudit && artifact !== null
          ? (await auditDeck({ dir: input.dir, file: artifact.relative, strict: false, pixels: false, deps: input.deps })).findings
          : null
    return { ref: input.ref, pptx: artifact?.relative ?? null, pages, findings, pinned: auditFile !== undefined }
  }
  const view = readProposal(fs, input.dir, input.ref)
  if (view === null) throw new DshPptFailure('OutputMissing', `no proposal ${input.ref} under ${join(input.dir, '.dsh-ppt', 'versions')}`, { detail: { ref: input.ref } })
  const pages = view.record.files.pages === undefined ? null : pickPagesDir(fs, join(input.dir, view.record.files.pages))
  const recorded = view.record.files.audit === undefined ? null : readAuditRecord(fs, join(input.dir, view.record.files.audit))
  return { ref: input.ref, pptx: view.record.files.pptx, pages, findings: recorded, pinned: view.record.files.audit !== undefined }
}

/**
 * Compare two versions of a deck.
 *
 * @param options - deck, the two references, the modes to run, dependencies.
 * @returns the per-mode results plus the text summary.
 * @throws DshPptFailure `OutputMissing` when a reference does not resolve or a package is unreadable.
 */
export async function diffVersions(options: DiffOptions): Promise<DiffResult> {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const anyMode = options.semantic || options.render || options.audit
  const modes = {
    semantic: anyMode ? options.semantic : true,
    audit: anyMode ? options.audit : true,
    render: anyMode ? options.render : true,
  }
  const left = await resolveSide({ ref: options.left, dir, wantAudit: modes.audit, deps: options.deps })
  const right = await resolveSide({ ref: options.right, dir, wantAudit: modes.audit, deps: options.deps })
  const skipped: string[] = []
  const lines: string[] = [`diff ${left.ref} -> ${right.ref}`]
  if (left.pptx !== null && right.pptx !== null) lines.push(`  packages: ${left.pptx} vs ${right.pptx}`)

  let semantic: SemanticDiff | undefined
  if (modes.semantic) {
    if (left.pptx === null || right.pptx === null) {
      skipped.push(`semantic: ${left.pptx === null ? left.ref : right.ref} has no package`)
    } else {
      const leftBytes = fs.readBytes(join(dir, left.pptx))
      const rightBytes = fs.readBytes(join(dir, right.pptx))
      if (leftBytes === null || rightBytes === null) throw new DshPptFailure('OutputMissing', `package is not readable: ${leftBytes === null ? left.pptx ?? '' : right.pptx ?? ''}`)
      semantic = await diffSemantic(leftBytes, rightBytes)
      lines.push(`  semantic: ${semantic.summary}`)
      for (const page of semantic.pages.filter((entry) => entry.status !== 'same')) {
        lines.push(`    page ${String(page.index)} ${page.status}: ${page.changedParts.length === 0 ? '- oh' : page.changedParts.join(', ')}${page.notes.length === 0 ? '' : ` (${page.notes.join('; ')})`}`)
      }
      if (semantic.globalParts.length > 0) lines.push(`    shared parts: ${semantic.globalParts.slice(0, 8).join(', ')}${semantic.globalParts.length > 8 ? `, and ${String(semantic.globalParts.length - 8)} more` : ''}`)
    }
  }

  let audit: AuditDelta | undefined
  if (modes.audit) {
    const leftFindings = left.findings
    const rightFindings = right.findings
    if (leftFindings === null || rightFindings === null) {
      skipped.push(`audit: ${leftFindings === null ? left.ref : right.ref} has no recorded findings`)
    } else {
      audit = diffAudit(leftFindings, rightFindings)
      lines.push(`  ${audit.summary}`)
      for (const finding of audit.added.slice(0, 8)) lines.push(`    + page ${finding.page === undefined ? '-' : String(finding.page)} ${finding.rule}: ${finding.message}`)
      for (const finding of audit.removed.slice(0, 8)) lines.push(`    - page ${finding.page === undefined ? '-' : String(finding.page)} ${finding.rule}: ${finding.message}`)
    }
  }

  let render: RenderDiff | undefined
  if (modes.render) {
    if (left.pages === null || right.pages === null) {
      skipped.push(`render: ${left.pages === null ? left.ref : right.ref} has no page snapshots (propose/renderpages with --render)`)
    } else {
      render = await diffRender(left.pages, right.pages, { fs })
      lines.push(`  ${render.summary}`)
      for (const page of render.pages.filter((entry) => entry.rate >= 0.01).sort((a, b) => b.rate - a.rate).slice(0, 8)) {
        lines.push(`    page ${String(page.index)}: ${(page.rate * 100).toFixed(2)} % of pixels differ`)
      }
    }
  }

  if (skipped.length > 0) lines.push(`  skipped: ${skipped.join('; ')}`)
  const result: DiffResult = {
    left,
    right,
    ...(semantic === undefined ? {} : { semantic }),
    ...(audit === undefined ? {} : { audit }),
    ...(render === undefined ? {} : { render }),
    skipped,
    summary: lines.join('\n'),
  }
  return result
}