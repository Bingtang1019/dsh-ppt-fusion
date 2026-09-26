// Worktree versions for the deck: `propose` renders into an immutable version
// directory, `approve` publishes one to `out/`, and `discard` removes it without
// touching the trunk (ADR-086, plan Part C).
//
// The split is deliberate. Rendering is the expensive step, so a version owns a
// complete artifact set (`deck.pptx`, `manifest.json`, `compat-report.json`,
// `audit.json`, `review.json`, `pages/`) and everything after that is a file
// operation. `out/` only ever changes inside `publishProposal`: it writes each
// artifact to a sibling temporary file and renames it into place, so a crash
// leaves either the old trunk or the new one, never a half-written pptx. The
// version directory keeps its own copy, which is what makes `diff <id> trunk`
// possible after the publish.
//
// The record inside a version is immutable; its lifecycle lives in `status.json`
// beside it. A rewrite of `proposal.json` would change the thing a diff compares,
// and the trunk record (`.dsh-ppt/trunk.json`) names the one version `out/` holds.
import { createHash, randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import type { FileSystemPort } from '../engine/venv.ts'
import { DshPptFailure } from '../engine/errors.ts'

/** Deck-relative directory holding every proposal version. */
export const PROPOSALS_DIR = join('.dsh-ppt', 'versions')

/** File naming one version's immutable artifact set. */
export const PROPOSAL_RECORD = 'proposal.json'

/** File naming one version's lifecycle state. */
export const PROPOSAL_STATUS = 'status.json'

/** Deck-relative record naming the version `out/` currently holds. */
export const TRUNK_RECORD = join('.dsh-ppt', 'trunk.json')

/** Append-only log of approvals and discards. */
export const HISTORY_FILE = join(PROPOSALS_DIR, 'history.jsonl')

/** Schema version of every record this module writes. */
export const WORKTREE_SCHEMA_VERSION = 1

/** Drafts kept before `propose` prunes the oldest (the approved trunk never prunes). */
export const PROPOSAL_KEEP = 10

/** Lifecycle state of one version. */
export type ProposalStatus = 'draft' | 'approved' | 'discarded'

/** What one version contains, relative to the deck. */
export interface ProposalFiles {
  /** The rendered package, named as the deck names it. */
  readonly pptx: string
  readonly manifest?: string
  readonly compat?: string
  readonly audit?: string
  readonly review?: string
  /** Directory of page snapshots, one subdirectory per engine. */
  readonly pages?: string
}

/** The immutable half of a version. */
export interface ProposalRecord {
  readonly schemaVersion: number
  readonly id: string
  readonly createdAt: string
  readonly message?: string
  readonly source: { readonly file: string; readonly sha256: string; readonly bytes: number; readonly slides: number }
  readonly files: ProposalFiles
}

/** The mutable half of a version. */
export interface ProposalStatusFile {
  readonly schemaVersion: number
  readonly status: ProposalStatus
  readonly updatedAt: string
  readonly trunk?: { readonly at: string; readonly file: string; readonly sha256: string }
}

/** A version as the commands read it. */
export interface ProposalView {
  readonly id: string
  readonly dir: string
  readonly record: ProposalRecord
  readonly status: ProposalStatusFile
}

/** What `out/` holds, written once per approval. */
export interface TrunkRecord {
  readonly schemaVersion: number
  readonly id: string
  readonly at: string
  readonly file: string
  readonly sha256: string
  readonly bytes: number
  readonly slides: number
}

/** One appended lifecycle event. */
export interface HistoryEntry {
  readonly at: string
  readonly id: string
  readonly action: 'approved' | 'discarded'
  readonly file?: string
  readonly sha256?: string
}

/** @param bytes - artifact bytes. @returns the lowercase hex sha256. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param now - clock reading; tests pass a fixed one.
 * @param suffix - random suffix; tests pass a fixed one.
 * @returns a sortable proposal id, `p-YYYYMMDD-HHMMSS-xxxxxx`.
 */
export function proposalId(now: Date = new Date(), suffix: string = randomBytes(3).toString('hex')): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
  return `p-${stamp}-${suffix}`
}

/** @param deckDir - absolute deck workspace. @param id - proposal id. @returns its directory. */
export function proposalDir(deckDir: string, id: string): string {
  return join(deckDir, PROPOSALS_DIR, id)
}

/**
 * @param fs - filesystem port.
 * @param path - absolute file path.
 * @returns the parsed file, or null when it is absent or malformed (an unreadable
 *   record is reported by `versions list` as a missing version, not as a crash).
 */
function readJson<T>(fs: FileSystemPort, path: string): T | null {
  const text = fs.readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Write a file through a temporary sibling so readers never see half of it. */
function writeJsonAtomic(fs: FileSystemPort, path: string, value: unknown): void {
  const temporary = `${path}.tmp`
  fs.writeText(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.rename(temporary, path)
}

/** @returns true when the value looks like the record this module writes. */
function isProposalRecord(value: unknown): value is ProposalRecord {
  const record = value as ProposalRecord | null
  return (
    record !== null &&
    typeof record === 'object' &&
    record.schemaVersion === WORKTREE_SCHEMA_VERSION &&
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.source?.sha256 === 'string' &&
    typeof record.files?.pptx === 'string'
  )
}

/** @returns true when the value looks like the status this module writes. */
function isProposalStatus(value: unknown): value is ProposalStatusFile {
  const status = value as ProposalStatusFile | null
  return status !== null && typeof status === 'object' && typeof status.status === 'string' && typeof status.updatedAt === 'string'
}

/**
 * @param fs - filesystem port.
 * @param deckDir - absolute deck workspace.
 * @param id - proposal id.
 * @returns the version, or null when the directory or either record is unusable.
 */
export function readProposal(fs: FileSystemPort, deckDir: string, id: string): ProposalView | null {
  const dir = proposalDir(deckDir, id)
  if (!fs.isDirectory(dir)) return null
  const record = readJson<unknown>(fs, join(dir, PROPOSAL_RECORD))
  const status = readJson<unknown>(fs, join(dir, PROPOSAL_STATUS))
  if (!isProposalRecord(record) || !isProposalStatus(status)) return null
  return { id, dir, record, status }
}

/**
 * @param fs - filesystem port.
 * @param deckDir - absolute deck workspace.
 * @returns every readable version, newest first.
 */
export function listProposals(fs: FileSystemPort, deckDir: string): ProposalView[] {
  const root = join(deckDir, PROPOSALS_DIR)
  if (!fs.isDirectory(root)) return []
  return fs
    .listDir(root)
    .filter((name) => fs.isDirectory(join(root, name)))
    .map((name) => readProposal(fs, deckDir, name))
    .filter((view): view is ProposalView => view !== null)
    .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt))
}

/** @param fs - filesystem port. @param deckDir - absolute deck workspace. @returns the trunk record, or null. */
export function readTrunk(fs: FileSystemPort, deckDir: string): TrunkRecord | null {
  const record = readJson<TrunkRecord>(fs, join(deckDir, TRUNK_RECORD))
  return record !== null && typeof record.sha256 === 'string' && typeof record.file === 'string' ? record : null
}

/** Append one lifecycle event; a missing log file is created by the write. */
function appendHistory(fs: FileSystemPort, deckDir: string, entry: HistoryEntry): void {
  const path = join(deckDir, HISTORY_FILE)
  const previous = fs.readText(path) ?? ''
  fs.mkdirp(join(deckDir, PROPOSALS_DIR))
  fs.writeText(path, `${previous}${JSON.stringify(entry)}\n`)
}

/** Write the status file for one version. */
function writeStatus(fs: FileSystemPort, deckDir: string, id: string, status: ProposalStatus, trunk?: ProposalStatusFile['trunk']): void {
  writeJsonAtomic(fs, join(proposalDir(deckDir, id), PROPOSAL_STATUS), {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    status,
    updatedAt: new Date().toISOString(),
    ...(trunk === undefined ? {} : { trunk }),
  } satisfies ProposalStatusFile)
}

/**
 * Register a rendered artifact set as a draft version.
 *
 * @param fs - filesystem port.
 * @param deckDir - absolute deck workspace.
 * @param record - the immutable record; its `files` must already exist on disk.
 * @param options.keep - drafts to retain; the approved trunk never prunes.
 * @returns the registered version and the ids pruning removed.
 */
export function writeProposal(
  fs: FileSystemPort,
  deckDir: string,
  record: ProposalRecord,
  options: { keep?: number } = {},
): { view: ProposalView; pruned: string[] } {
  const dir = proposalDir(deckDir, record.id)
  fs.mkdirp(dir)
  writeJsonAtomic(fs, join(dir, PROPOSAL_RECORD), record)
  writeJsonAtomic(fs, join(dir, PROPOSAL_STATUS), { schemaVersion: WORKTREE_SCHEMA_VERSION, status: 'draft', updatedAt: record.createdAt } satisfies ProposalStatusFile)
  const view = readProposal(fs, deckDir, record.id)
  if (view === null) throw new DshPptFailure('ContractViolation', `the proposal record for ${record.id} could not be read back`, { detail: { dir } })
  return { view, pruned: pruneProposals(fs, deckDir, options.keep ?? PROPOSAL_KEEP) }
}

/**
 * Publish one version to `out/`, atomically per artifact.
 *
 * @param fs - filesystem port.
 * @param deckDir - absolute deck workspace.
 * @param id - proposal id.
 * @returns the trunk record now describing `out/`.
 * @throws DshPptFailure `OutputMissing` when the version or one of its artifacts is gone,
 *   `ContractViolation` when the version was discarded or approved already.
 */
export function publishProposal(fs: FileSystemPort, deckDir: string, id: string): TrunkRecord {
  const view = readProposal(fs, deckDir, id)
  if (view === null) throw new DshPptFailure('OutputMissing', `no proposal ${id} under ${join(deckDir, PROPOSALS_DIR)}`, { detail: { id } })
  if (view.status.status === 'discarded') throw new DshPptFailure('ContractViolation', `proposal ${id} was discarded and cannot be published`, { detail: { id } })
  const at = new Date().toISOString()
  if (view.status.status === 'approved' && view.status.trunk !== undefined) {
    const trunk = readTrunk(fs, deckDir)
    if (trunk !== null && trunk.id === id) return trunk
  }
  const target = basename(view.record.files.pptx)
  const outDir = join(deckDir, 'out')
  fs.mkdirp(outDir)
  // Every path in the record is deck-relative, which is what makes a version movable
  // and what `diff` resolves against the deck; publishing must not join it on the
  // version directory a second time.
  // The package travels as bytes and the records as text: the port's text reader
  // would corrupt a package and its byte reader cannot see a text artifact.
  const copies: { readonly from: string; readonly to: string; readonly kind: 'bytes' | 'text'; readonly rewriteManifest?: boolean }[] = [
    { from: join(deckDir, view.record.files.pptx), to: join(outDir, target), kind: 'bytes' },
  ]
  if (view.record.files.manifest !== undefined) {
    copies.push({ from: join(deckDir, view.record.files.manifest), to: join(outDir, 'manifest.json'), kind: 'text', rewriteManifest: true })
  }
  if (view.record.files.compat !== undefined) copies.push({ from: join(deckDir, view.record.files.compat), to: join(outDir, 'compat-report.json'), kind: 'text' })
  const intent = join(outDir, '.publish.json')
  fs.writeText(intent, `${JSON.stringify({ schemaVersion: WORKTREE_SCHEMA_VERSION, id, at, files: copies.map((copy) => basename(copy.to)) })}\n`)
  for (const copy of copies) {
    const temporary = `${copy.to}.publish-${id}.tmp`
    if (copy.kind === 'text') {
      const text = fs.readText(copy.from)
      if (text === null) throw new DshPptFailure('OutputMissing', `proposal ${id} is missing ${copy.from}`, { detail: { id, file: copy.from } })
      fs.writeText(temporary, copy.rewriteManifest === true ? rewriteManifestText(text, `out/${target}`) : text)
    } else {
      const bytes = fs.readBytes(copy.from)
      if (bytes === null) throw new DshPptFailure('OutputMissing', `proposal ${id} is missing ${copy.from}`, { detail: { id, file: copy.from } })
      fs.writeBytes(temporary, bytes)
    }
    fs.rename(temporary, copy.to)
  }
  const trunk: TrunkRecord = {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    id,
    at,
    file: `out/${target}`,
    sha256: view.record.source.sha256,
    bytes: view.record.source.bytes,
    slides: view.record.source.slides,
  }
  writeJsonAtomic(fs, join(deckDir, TRUNK_RECORD), trunk)
  writeStatus(fs, deckDir, id, 'approved', { at, file: trunk.file, sha256: trunk.sha256 })
  appendHistory(fs, deckDir, { at, id, action: 'approved', file: trunk.file, sha256: trunk.sha256 })
  fs.removeTree(intent)
  return trunk
}

/**
 * @param text - the version's manifest.
 * @param file - the trunk-relative package path.
 * @returns the manifest with its `file` field pointing at the published copy.
 */
function rewriteManifestText(text: string, file: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>
  return `${JSON.stringify({ ...parsed, file }, null, 2)}\n`
}

/**
 * Remove a draft version. A discarded version leaves no card behind, and the
 * append-only history is the only trace it existed.
 *
 * @param fs - filesystem port.
 * @param deckDir - absolute deck workspace.
 * @param id - proposal id.
 * @throws DshPptFailure `OutputMissing` when the version is gone, `ContractViolation`
 *   when it is the approved trunk.
 */
export function discardProposal(fs: FileSystemPort, deckDir: string, id: string): void {
  const view = readProposal(fs, deckDir, id)
  if (view === null) throw new DshPptFailure('OutputMissing', `no proposal ${id} under ${join(deckDir, PROPOSALS_DIR)}`, { detail: { id } })
  const trunk = readTrunk(fs, deckDir)
  if (view.status.status === 'approved' && trunk?.id === id) {
    throw new DshPptFailure('ContractViolation', `proposal ${id} is the published trunk; render a new draft instead of discarding it`, { detail: { id } })
  }
  const at = new Date().toISOString()
  appendHistory(fs, deckDir, { at, id, action: 'discarded' })
  fs.removeTree(view.dir)
}

/**
 * Keep the newest versions and drop the rest; the approved trunk never prunes.
 *
 * @param fs - filesystem port.
 * @param deckDir - absolute deck workspace.
 * @param keep - versions to retain, at least 1.
 * @returns the ids that were removed.
 */
export function pruneProposals(fs: FileSystemPort, deckDir: string, keep: number = PROPOSAL_KEEP): string[] {
  const limit = Math.max(1, keep)
  const trunk = readTrunk(fs, deckDir)
  const views = listProposals(fs, deckDir)
  const removed: string[] = []
  views.forEach((view, offset) => {
    if (offset < limit || view.id === trunk?.id) return
    fs.removeTree(view.dir)
    removed.push(view.id)
  })
  return removed
}

/**
 * @param views - versions to print.
 * @returns a table with one row per version, newest first.
 */
export function formatProposals(views: readonly ProposalView[]): string {
  if (views.length === 0) return 'no drafts under .dsh-ppt/versions; run `dsh-ppt propose <dir>` first'
  const rows = views.map((view) => [
    view.id,
    view.status.status,
    view.record.createdAt,
    `${String(view.record.source.slides)}p`,
    view.record.source.sha256.slice(0, 12),
    `${String(view.record.source.bytes)} B`,
    view.record.message ?? '',
  ])
  const header = ['id', 'status', 'created', 'slides', 'sha256', 'bytes', 'message']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()
  return [line(header), ...rows.map((row) => line(row))].join('\n')
}