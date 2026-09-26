import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createFakeFileSystem } from '../../tests/support/fake-runner.ts'
import {
  PROPOSAL_KEEP,
  PROPOSALS_DIR,
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
} from './worktree.ts'

const deck = join(process.cwd(), 'tmp', 'worktree-deck')

/** @returns an in-memory filesystem holding one deck and one rendered draft. */
function fixture(options: { id?: string; createdAt?: string; withManifest?: boolean; into?: ReturnType<typeof createFakeFileSystem> } = {}): {
  fs: ReturnType<typeof createFakeFileSystem>
  record: ProposalRecord
} {
  const id = options.id ?? 'p-20260927-010000-aaaaaa'
  const dir = proposalDir(deck, id)
  const pptx = Buffer.from('PK\u0003\u0004 fake pptx bytes')
  const fs = options.into ?? createFakeFileSystem({ files: { [join(deck, 'deck.json')]: '{"name":"demo"}', [join(dir, 'proposal.json')]: '{"placeholder":true}', [join(dir, 'status.json')]: '{"placeholder":true}' }, directories: [deck, dir, join(deck, 'out')] })
  fs.mkdirp(dir)
  fs.writeBytes(join(dir, 'deck.pptx'), pptx)
  fs.writeText(join(dir, 'audit.json'), JSON.stringify({ schemaVersion: 1, findings: [] }))
  if (options.withManifest !== false) fs.writeText(join(dir, 'manifest.json'), JSON.stringify({ name: 'deck', file: `.dsh-ppt/versions/${id}/deck.pptx`, slides: 3 }, null, 2))
  const record: ProposalRecord = {
    schemaVersion: 1,
    id,
    createdAt: options.createdAt ?? '2026-09-27T01:00:00.000Z',
    message: 'first draft',
    source: { file: join(PROPOSALS_DIR, id, 'deck.pptx'), sha256: sha256Of(pptx), bytes: pptx.length, slides: 3 },
    files: { pptx: join(PROPOSALS_DIR, id, 'deck.pptx'), manifest: join(PROPOSALS_DIR, id, 'manifest.json'), audit: join(PROPOSALS_DIR, id, 'audit.json') },
  }
  return { fs, record }
}

describe('proposal versions', () => {
  it('registers a draft and lists it', () => {
    const { fs, record } = fixture()
    const { view, pruned } = writeProposal(fs, deck, record)
    expect(view.status.status).toBe('draft')
    expect(pruned).toEqual([])
    const views = listProposals(fs, deck)
    expect(views.map((entry) => entry.id)).toEqual([record.id])
    expect(views[0]?.record.message).toBe('first draft')
  })

  it('publishes a draft into out/ without touching the version copy', () => {
    const { fs, record } = fixture()
    writeProposal(fs, deck, record)
    const trunk = publishProposal(fs, deck, record.id)
    expect(trunk.id).toBe(record.id)
    expect(trunk.file).toBe('out/deck.pptx')
    expect(trunk.sha256).toBe(record.source.sha256)
    expect(fs.readBytes(join(deck, 'out', 'deck.pptx'))?.toString()).toBe('PK\u0003\u0004 fake pptx bytes')
    expect(JSON.parse(fs.readText(join(deck, 'out', 'manifest.json')) ?? '{}').file).toBe('out/deck.pptx')
    expect(fs.readBytes(join(proposalDir(deck, record.id), 'deck.pptx'))?.length).toBeGreaterThan(0)
    expect(fs.readText(join(deck, 'out', '.publish.json'))).toBeNull()
    expect(readProposal(fs, deck, record.id)?.status.status).toBe('approved')
    expect(readTrunk(fs, deck)?.id).toBe(record.id)
  })

  it('is idempotent when the same version is approved twice', () => {
    const { fs, record } = fixture()
    writeProposal(fs, deck, record)
    const first = publishProposal(fs, deck, record.id)
    const second = publishProposal(fs, deck, record.id)
    expect(second).toEqual(first)
  })

  it('keeps the trunk continuous across two approvals', () => {
    const first = fixture({ id: 'p-20260927-010000-aaaaaa', createdAt: '2026-09-27T01:00:00.000Z' })
    writeProposal(first.fs, deck, first.record)
    const second = fixture({ id: 'p-20260927-020000-bbbbbb', createdAt: '2026-09-27T02:00:00.000Z', into: first.fs })
    writeProposal(first.fs, deck, second.record)
    publishProposal(first.fs, deck, first.record.id)
    const trunk = publishProposal(first.fs, deck, second.record.id)
    expect(trunk.id).toBe(second.record.id)
    expect(readProposal(first.fs, deck, first.record.id)?.status.status).toBe('approved')
    expect(first.fs.readBytes(join(proposalDir(deck, first.record.id), 'deck.pptx'))).not.toBeNull()
  })

  it('discards a draft without touching out/', () => {
    const { fs, record } = fixture()
    writeProposal(fs, deck, record)
    discardProposal(fs, deck, record.id)
    expect(fs.isDirectory(proposalDir(deck, record.id))).toBe(false)
    expect(fs.listDir(join(deck, 'out'))).toEqual([])
    expect(listProposals(fs, deck)).toEqual([])
  })

  it('refuses to discard the published trunk', () => {
    const { fs, record } = fixture()
    writeProposal(fs, deck, record)
    publishProposal(fs, deck, record.id)
    expect(() => discardProposal(fs, deck, record.id)).toThrow(/published trunk/)
  })

  it('prunes the oldest drafts and keeps the trunk', () => {
    const fs = createFakeFileSystem({ directories: [deck] })
    const ids: string[] = []
    for (let index = 0; index < PROPOSAL_KEEP + 3; index += 1) {
      const id = `p-20260927-0${String(index)}0000-c${String(index)}`
      ids.push(id)
      const { record } = fixture({ id, createdAt: `2026-09-27T0${String(index)}:00:00.000Z`, into: fs })
      writeProposal(fs, deck, record, { keep: PROPOSAL_KEEP + 3 })
    }
    // Approve the oldest, then prune to the keeping limit: the trunk must survive.
    publishProposal(fs, deck, ids[0] ?? '')
    const removed = listProposals(fs, deck)
      .filter((view) => view.id !== ids[0])
      .slice(0, 3)
      .map((view) => view.id)
    for (const id of removed) discardProposal(fs, deck, id)
    const remaining = listProposals(fs, deck).map((view) => view.id)
    expect(remaining).toContain(ids[0])
    expect(readTrunk(fs, deck)?.id).toBe(ids[0])
  })

  it('skips a version whose record is unreadable', () => {
    const { fs, record } = fixture()
    writeProposal(fs, deck, record)
    fs.writeText(join(proposalDir(deck, record.id), 'proposal.json'), '{ not json')
    expect(listProposals(fs, deck)).toEqual([])
    expect(formatProposals([])).toMatch(/no drafts/)
  })

  it('names proposals so they sort chronologically', () => {
    const id = proposalId(new Date('2026-09-27T02:03:04.000Z'), 'abcdef')
    expect(id).toBe('p-20260927-020304-abcdef')
  })
})