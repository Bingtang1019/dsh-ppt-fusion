import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createFakeFileSystem, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { defaultDependencies } from './context.ts'
import { approveProposal, discardProposalById, listVersions, proposeDeck, versionDirectory } from './propose.ts'
import { diffVersions } from './diff.ts'
import { OpcPackage } from '../bridge/opc.ts'
import { PROPOSALS_DIR, proposalDir, publishProposal, readTrunk, sha256Of, writeProposal, type ProposalRecord } from '../bridge/worktree.ts'

const deck = join(process.cwd(), 'tmp', 'propose-deck')

/** A one-slide deck whose slide body is `body`. */
async function deckBytes(body: string): Promise<Buffer> {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  pkg.setPart('ppt/slides/slide1.xml', `<p:sld><p:cSld>${body}</p:cSld></p:sld>`)
  pkg.setRelationships('ppt/slides/slide1.xml', [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' }])
  pkg.setPart('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>')
  pkg.setRelationships('ppt/presentation.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' },
  ])
  pkg.setPart('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>')
  pkg.setRelationships('ppt/slideMasters/slideMaster1.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme1.xml' },
  ])
  pkg.setPart('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout/>')
  pkg.setRelationships('ppt/slideLayouts/slideLayout1.xml', [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: '../slideMasters/slideMaster1.xml' }])
  pkg.setPart('ppt/theme/theme1.xml', '<a:theme/>')
  return pkg.write()
}

/** Register a draft version holding `bytes`, without going through the renderer. */
async function draft(fs: FakeFileSystem, id: string, bytes: Buffer, findings: unknown[] = []): Promise<ProposalRecord> {
  const dir = proposalDir(deck, id)
  fs.mkdirp(dir)
  fs.writeBytes(join(dir, 'demo.pptx'), bytes)
  fs.writeText(join(dir, 'manifest.json'), JSON.stringify({ name: 'demo', file: `.dsh-ppt/versions/${id}/demo.pptx`, sha256: sha256Of(bytes), bytes: bytes.length, slides: 1 }, null, 2))
  fs.writeText(join(dir, 'audit.json'), JSON.stringify({ schemaVersion: 1, findings }))
  const record: ProposalRecord = {
    schemaVersion: 1,
    id,
    createdAt: '2026-09-27T01:00:00.000Z',
    source: { file: join(PROPOSALS_DIR, id, 'demo.pptx'), sha256: sha256Of(bytes), bytes: bytes.length, slides: 1 },
    files: { pptx: join(PROPOSALS_DIR, id, 'demo.pptx'), manifest: join(PROPOSALS_DIR, id, 'manifest.json'), audit: join(PROPOSALS_DIR, id, 'audit.json') },
  }
  writeProposal(fs, deck, record, { keep: 50 })
  return record
}

/** @returns a deck workspace with one approved trunk and one open draft. */
async function worktree(): Promise<{ fs: FakeFileSystem; trunkRecord: ProposalRecord; draftRecord: ProposalRecord; deps: ReturnType<typeof defaultDependencies> }> {
  const fs = createFakeFileSystem({ files: { [join(deck, 'deck.json')]: JSON.stringify({ name: 'demo', routes: { standard: 'pptwise' } }) }, directories: [deck, join(deck, 'out')] })
  const deps = defaultDependencies({ fs, cwd: process.cwd() })
  const base = await deckBytes('<p:sp name="one"/>')
  const changed = await deckBytes('<p:sp name="one"/><p:sp name="two"/>')
  const trunkRecord = await draft(fs, 'p-20260927-010000-aaaaaa', base, [{ level: 'warning', source: 'pptx', rule: 'render-overflow', message: 'old finding', page: 1 }])
  publishProposal(fs, deck, trunkRecord.id)
  const draftRecord = await draft(fs, 'p-20260927-020000-bbbbbb', changed, [
    { level: 'warning', source: 'pptx', rule: 'render-overflow', message: 'old finding', page: 1 },
    { level: 'error', source: 'pptx', rule: 'render-off-page', message: 'new finding', page: 1 },
  ])
  return { fs, trunkRecord, draftRecord, deps }
}

describe('worktree commands', () => {
  it('refuses a malformed or duplicate proposal id before rendering', async () => {
    const { fs, trunkRecord, deps } = await worktree()
    await expect(proposeDeck({ dir: deck, id: 'bad id!', engine: 'both', scale: 1, maxPages: 30, maxPixels: 1, deps })).rejects.toThrow(/may only contain/)
    await expect(proposeDeck({ dir: deck, id: trunkRecord.id, engine: 'both', scale: 1, maxPages: 30, maxPixels: 1, deps })).rejects.toThrow(/already exists/)
    expect(fs.isDirectory(proposalDir(deck, 'bad id!'))).toBe(false)
  })

  it('publishes a draft and marks it approved', async () => {
    const { fs, draftRecord, deps } = await worktree()
    const { trunk, view } = approveProposal({ dir: deck, id: draftRecord.id, deps })
    expect(trunk.id).toBe(draftRecord.id)
    expect(view.status.status).toBe('approved')
    expect(fs.readBytes(join(deck, 'out', 'demo.pptx'))?.length).toBe(draftRecord.source.bytes)
    expect(JSON.parse(fs.readText(join(deck, 'out', 'manifest.json')) ?? '{}').file).toBe('out/demo.pptx')
    expect(readTrunk(fs, deck)?.file).toBe('out/demo.pptx')
  })

  it('discards a draft and leaves the trunk alone', async () => {
    const { fs, trunkRecord, draftRecord, deps } = await worktree()
    const before = fs.readBytes(join(deck, 'out', 'demo.pptx'))
    const { trunk } = discardProposalById({ dir: deck, id: draftRecord.id, deps })
    expect(trunk?.id).toBe(trunkRecord.id)
    expect(fs.isDirectory(proposalDir(deck, draftRecord.id))).toBe(false)
    expect(fs.readBytes(join(deck, 'out', 'demo.pptx'))?.equals(before ?? Buffer.alloc(0))).toBe(true)
  })

  it('lists versions with the trunk marked', async () => {
    const { trunkRecord, draftRecord, deps } = await worktree()
    const listed = listVersions({ dir: deck, deps })
    expect(listed.views.map((view) => view.id).sort()).toEqual([trunkRecord.id, draftRecord.id].sort())
    expect(listed.trunk?.id).toBe(trunkRecord.id)
    expect(listed.formatted).toMatch(/status/)
  })

  it('diffs a draft against the trunk: page change, audit delta and render skip', async () => {
    const { draftRecord, deps } = await worktree()
    const result = await diffVersions({ dir: deck, left: 'trunk', right: draftRecord.id, semantic: true, audit: true, render: true, deps })
    expect(result.semantic?.pages[0]?.status).toBe('modified')
    expect(result.semantic?.pages[0]?.changedParts).toContain('ppt/slides/slide1.xml')
    expect(result.audit?.added.map((finding) => finding.rule)).toEqual(['render-off-page'])
    expect(result.skipped.some((entry) => entry.startsWith('render:'))).toBe(true)
    expect(result.summary).toMatch(/diff trunk -> p-20260927-020000-bbbbbb/)
  })

  it('reports an unknown reference instead of guessing', async () => {
    const { deps } = await worktree()
    await expect(diffVersions({ dir: deck, left: 'trunk', right: 'p-nope', semantic: true, audit: false, render: false, deps })).rejects.toThrow(/no proposal/)
    expect(() => versionDirectory(createFakeFileSystem(), deck, 'p-nope')).toThrow(/no proposal/)
  })

  it('fails the semantic mode when a side has no package', async () => {
    const fs = createFakeFileSystem({ directories: [deck, join(deck, 'out')] })
    const deps = defaultDependencies({ fs, cwd: process.cwd() })
    const result = await diffVersions({ dir: deck, left: 'trunk', right: 'trunk', semantic: true, audit: false, render: false, deps })
    expect(result.skipped.some((entry) => entry.startsWith('semantic:'))).toBe(true)
  })
})