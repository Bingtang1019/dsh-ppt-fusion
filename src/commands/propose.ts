// Worktree commands: `propose`, `approve`, `discard`, `versions` (ADR-086, plan Part C).
//
// `propose` is the only command that renders, and it renders into the version
// directory instead of `out/`, so a draft cannot reach the trunk by accident. The
// artifact set it records is the one a reviewer needs: the package, the render
// manifest and compat report, the audit findings for that exact package, the
// review record when one exists, and (with `--render`) the page snapshots.
//
// `approve` and `discard` are thin: the decisions live in `src/bridge/worktree.ts`
// so the CLI, the tool and the tests all enforce the same rules.
import { join } from 'node:path'
import { loadDeck } from '../deck.ts'
import { DshPptFailure } from '../engine/errors.ts'
import type { FileSystemPort } from '../engine/venv.ts'
import { auditDeck } from './audit.ts'
import { renderDeck } from './render.ts'
import { renderPagesCommand, type RenderPagesCommandOptions } from './renderpages.ts'
import { resolveDeckDir, type CommandDependencies } from './context.ts'
import type { RenderEngineChoice } from '../bridge/render-pages.ts'
import { DEFAULT_MAX_PAGES, DEFAULT_MAX_PIXELS } from '../bridge/render-pages.ts'
import {
  PROPOSALS_DIR,
  PROPOSAL_RECORD,
  discardProposal,
  formatProposals,
  listProposals,
  proposalDir,
  proposalId,
  publishProposal,
  readProposal,
  readTrunk,
  sha256Of,
  writeProposal,
  type ProposalRecord,
  type ProposalView,
  type TrunkRecord,
} from '../bridge/worktree.ts'

/** Audit records a version's `audit.json`. */
export const PROPOSAL_AUDIT_SCHEMA_VERSION = 1

/** Everything `propose` needs. */
export interface ProposeOptions {
  readonly dir: string
  /** Fixed id; defaults to a timestamped one. */
  readonly id?: string
  /** Free-text note shown by `versions` and the review card. */
  readonly message?: string
  /** Also rasterise the draft's pages into `<version>/pages`. */
  readonly render?: boolean
  readonly engine: RenderEngineChoice
  readonly scale: number
  readonly maxPages: number
  readonly maxPixels: number
  readonly deps: CommandDependencies
}

/** What one `propose` produced. */
export interface ProposeResult {
  readonly view: ProposalView
  /** Older drafts this call pruned. */
  readonly pruned: readonly string[]
  /** Page snapshot report when `--render` ran. */
  readonly pages?: { readonly engines: readonly { readonly engine: string; readonly status: string; readonly pages: readonly { readonly index: number; readonly file: string }[] }[]; readonly skipped: readonly string[] }
}

/** The recorded audit of one version. */
export interface ProposalAuditRecord {
  readonly schemaVersion: number
  readonly generatedAt: string
  readonly ok: boolean
  readonly findings: readonly unknown[]
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number }
}

/**
 * @param findings - audit findings.
 * @returns how many there are per level.
 */
function countFindings(findings: readonly { level: string }[]): ProposalAuditRecord['counts'] {
  return {
    error: findings.filter((finding) => finding.level === 'error').length,
    warning: findings.filter((finding) => finding.level === 'warning').length,
    info: findings.filter((finding) => finding.level === 'info').length,
  }
}

/** @returns the deck-relative directory of a version. */
function relativeVersionDir(id: string): string {
  return join(PROPOSALS_DIR, id)
}

/**
 * Render into a version directory and register it as a draft.
 *
 * @param options - deck, optional id/message, page-snapshot flags, dependencies.
 * @returns the registered version, what pruning removed, and the page report.
 * @throws DshPptFailure when the deck does not render, so no draft is registered.
 */
export async function proposeDeck(options: ProposeOptions): Promise<ProposeResult> {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  // The id is checked before the deck is read: a bad argument must not depend on
  // the workspace being complete, and a duplicate must never start a render.
  const id = options.id ?? proposalId()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new DshPptFailure('UsageError', `proposal id "${id}" may only contain letters, digits, dot, dash and underscore`)
  if (readProposal(fs, dir, id) !== null) throw new DshPptFailure('ContractViolation', `proposal ${id} already exists; pass --id with another value or discard it first`)
  const context = loadDeck(dir, fs)
  const relativeDir = relativeVersionDir(id)
  const pptxName = `${context.deck.name}.pptx`
  const relativePptx = join(relativeDir, pptxName)
  const rendered = await renderDeck({ dir, output: relativePptx, manifestDir: relativeDir, deps: options.deps })

  // The audit is recorded for this exact package, not for the trunk: `--file`
  // points it at the draft.
  const audit = await auditDeck({ dir, file: relativePptx, strict: false, pixels: false, deps: options.deps })
  const auditRecord: ProposalAuditRecord = {
    schemaVersion: PROPOSAL_AUDIT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ok: audit.ok,
    findings: audit.findings,
    counts: countFindings(audit.findings),
  }
  fs.writeText(join(dir, relativeDir, 'audit.json'), `${JSON.stringify(auditRecord, null, 2)}\n`)

  const review = fs.readText(join(dir, '.dsh-ppt', 'review', 'review.json'))
  if (review !== null) fs.writeText(join(dir, relativeDir, 'review.json'), review)

  let pages: ProposeResult['pages']
  if (options.render === true) {
    const report = renderPagesCommand({
      dir,
      file: relativePptx,
      output: join(relativeDir, 'pages'),
      engine: options.engine,
      scale: options.scale,
      maxPages: options.maxPages,
      maxPixels: options.maxPixels,
      required: false,
      force: false,
      deps: options.deps,
    } satisfies RenderPagesCommandOptions)
    pages = {
      // The entries, not just the count: the session card serves these files by index,
      // and a count only tells it how many thumbnails it cannot draw.
      engines: report.engines.map((engine) => ({ engine: engine.engine, status: engine.status, pages: engine.pages.map((page) => ({ index: page.index, file: page.file })) })),
      skipped: report.skipped,
    }
  }

  const record: ProposalRecord = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    ...(options.message === undefined ? {} : { message: options.message }),
    source: { file: relativePptx, sha256: rendered.sha256, bytes: rendered.bytes, slides: rendered.slides },
    files: {
      pptx: relativePptx,
      manifest: join(relativeDir, 'manifest.json'),
      compat: join(relativeDir, 'compat-report.json'),
      audit: join(relativeDir, 'audit.json'),
      ...(review === null ? {} : { review: join(relativeDir, 'review.json') }),
      ...(pages === undefined ? {} : { pages: join(relativeDir, 'pages') }),
    },
  }
  const { view, pruned } = writeProposal(fs, dir, record)
  return { view, pruned, ...(pages === undefined ? {} : { pages }) }
}

/** Everything `approve` and `discard` need. */
export interface ProposalActionOptions {
  readonly dir: string
  readonly id: string
  readonly deps: CommandDependencies
}

/**
 * Publish one draft to `out/`.
 *
 * @param options - deck, proposal id, dependencies.
 * @returns the trunk record and the version now marked approved.
 */
export function approveProposal(options: ProposalActionOptions): { trunk: TrunkRecord; view: ProposalView } {
  const dir = resolveDeckDir(options.deps, options.dir)
  const trunk = publishProposal(options.deps.fs, dir, options.id)
  const view = readProposal(options.deps.fs, dir, options.id)
  if (view === null) throw new DshPptFailure('OutputMissing', `proposal ${options.id} disappeared during publish`, { detail: { id: options.id } })
  return { trunk, view }
}

/**
 * Remove one draft; the trunk is never touched.
 *
 * @param options - deck, proposal id, dependencies.
 * @returns the id and the trunk the deck still holds (null when `out/` was never published).
 */
export function discardProposalById(options: ProposalActionOptions): { id: string; trunk: TrunkRecord | null } {
  const dir = resolveDeckDir(options.deps, options.dir)
  discardProposal(options.deps.fs, dir, options.id)
  return { id: options.id, trunk: readTrunk(options.deps.fs, dir) }
}

/**
 * @param input.dir - deck directory as given on the command line.
 * @param input.deps - command dependencies.
 * @returns every version plus the trunk record.
 */
export function listVersions(input: { dir: string; deps: CommandDependencies }): { views: readonly ProposalView[]; trunk: TrunkRecord | null; formatted: string } {
  const dir = resolveDeckDir(input.deps, input.dir)
  const views = listProposals(input.deps.fs, dir)
  const trunk = readTrunk(input.deps.fs, dir)
  return { views, trunk, formatted: formatProposals(views) }
}

/**
 * @param fs - filesystem port.
 * @param dir - absolute deck workspace.
 * @param id - proposal id.
 * @returns the version directory, for callers that need the raw files.
 */
export function versionDirectory(fs: FileSystemPort, dir: string, id: string): string {
  if (readProposal(fs, dir, id) === null) throw new DshPptFailure('OutputMissing', `no proposal ${id} under ${join(dir, PROPOSALS_DIR)}`, { detail: { id } })
  return proposalDir(dir, id)
}

/** Default page ceilings shared by the CLI and the tool. */
export const PROPOSE_PAGE_DEFAULTS = { maxPages: DEFAULT_MAX_PAGES, maxPixels: DEFAULT_MAX_PIXELS } as const

/** Re-exported so the CLI can test a record without importing the module. */
export { sha256Of, PROPOSAL_RECORD }
