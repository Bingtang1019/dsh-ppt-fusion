import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyAsset, discoverOfficeAssets, formatAssetCopy, formatAssetsList, formatOfficeDiscovery, listAssets, officeRootCandidates, officeRecordPath, userAssetRoots } from './assets.ts'
import { defaultDependencies, type CommandDependencies } from './context.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { parseOfficeAssetRecord } from '../schema/assets.ts'
import { createFakeFileSystem, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'assets')
const dshHome = join(process.cwd(), 'tmp', 'assets-dsh')
const clipRoot = join(workspace, 'office', 'CLIPART')
const themeRoot = join(workspace, 'office', 'LiveContent')
const missingRoot = join(workspace, 'office', 'Icons')
const deck = join(workspace, 'deck')

/** Build a fake filesystem and dependencies bound to it. */
function build(files: Record<string, string> = {}): { fs: FakeFileSystem; deps: CommandDependencies } {
  const fs = createFakeFileSystem({ files })
  const deps = defaultDependencies({ fs, cwd: workspace, env: { ...process.env, DSH_HOME: dshHome } })
  return { fs, deps }
}

/** Write an office installation into the fake filesystem. */
function buildOffice(fs: FakeFileSystem): void {
  fs.writeBytes(join(clipRoot, 'PUB60COR', 'AG00004_.GIF'), Buffer.from('gif-bytes'))
  fs.writeBytes(join(clipRoot, 'PUB60COR', 'J0400001.PNG'), Buffer.from('png-bytes'))
  fs.writeText(join(clipRoot, 'PUB60COR', 'SOUND.WAV'), 'wav')
  fs.writeBytes(join(themeRoot, '16', 'Office Theme.thmx'), Buffer.from('theme-bytes'))
}

/** The three probe roots the discovery tests use. */
const roots = [
  { path: clipRoot, category: 'clip-art' as const },
  { path: themeRoot, category: 'theme' as const },
  { path: missingRoot, category: 'icon' as const },
]

describe('discoverOfficeAssets', () => {
  it('records probed roots, counts and deterministic ids', () => {
    const { fs, deps } = build()
    buildOffice(fs)
    const result = discoverOfficeAssets({ roots, now: () => new Date('2026-09-24T00:00:00.000Z'), deps })
    expect(result.recordFile).toBe(join(dshHome, 'ppt-fusion', 'assets', 'office-assets.json'))
    expect(result.record.roots).toEqual([
      { path: clipRoot, category: 'clip-art', counts: { gif: 1, png: 1 } },
      { path: themeRoot, category: 'theme', counts: { thmx: 1 } },
      { path: missingRoot, category: 'icon', counts: {} },
    ])
    expect(result.record.assets.map((asset) => asset.id)).toEqual(['clip-art-pub60cor-ag00004', 'clip-art-pub60cor-j0400001', 'theme-16-office-theme'])
    expect(result.record.assets.map((asset) => asset.format)).toEqual(['gif', 'png', 'thmx'])
    expect(result.record.discoveredAt).toBe('2026-09-24T00:00:00.000Z')
    expect(parseOfficeAssetRecord(JSON.parse(fs.readText(result.recordFile) ?? '') as unknown)).toEqual(result.record)
  })

  it('writes the same bytes again for the same roots and clock', () => {
    const { fs, deps } = build()
    buildOffice(fs)
    const now = (): Date => new Date('2026-09-24T00:00:00.000Z')
    const first = discoverOfficeAssets({ roots, now, deps })
    const before = fs.readText(first.recordFile)
    const second = discoverOfficeAssets({ roots, now, deps })
    expect(fs.readText(second.recordFile)).toBe(before)
  })

  it('fails loudly with a fallback when no root holds an asset', () => {
    const { fs, deps } = build()
    const error = capture(() => discoverOfficeAssets({ roots: [{ path: missingRoot, category: 'icon' }], deps }))
    expect(error).toBeInstanceOf(DshPptFailure)
    expect((error as DshPptFailure).code).toBe('OutputMissing')
    expect((error as DshPptFailure).message).toContain('svg')
    expect(fs.exists(officeRecordPath(deps))).toBe(false)
  })

  it('reports the summary and accepts an explicit record path', () => {
    const { fs, deps } = build()
    buildOffice(fs)
    const output = join(workspace, 'records', 'office.json')
    const result = discoverOfficeAssets({ roots, output, deps })
    expect(result.recordFile).toBe(output)
    const text = formatOfficeDiscovery(result)
    expect(text).toContain('clip-art')
    expect(text).toContain('3 asset(s) in 2 root(s)')
  })
})

describe('officeRootCandidates', () => {
  it('puts DSH_PPT_OFFICE_ROOTS entries first and then the Office defaults', () => {
    const env = { ProgramFiles: 'C:\\PF', APPDATA: 'C:\\AD', DSH_PPT_OFFICE_ROOTS: `icon=C:\\Icons${delimiter}D:\\Extra` }
    const candidates = officeRootCandidates(env)
    expect(candidates[0]).toEqual({ path: 'C:\\Icons', category: 'icon' })
    expect(candidates[1]).toEqual({ path: 'D:\\Extra', category: 'clip-art' })
    expect(candidates.some((candidate) => candidate.path === join('C:\\PF', 'Microsoft Office', 'root', 'CLIPART'))).toBe(true)
    expect(candidates.some((candidate) => candidate.path === join('C:\\AD', 'Microsoft', 'Templates', 'LiveContent'))).toBe(true)
  })

  it('rejects a malformed custom entry', () => {
    expect(() => officeRootCandidates({ DSH_PPT_OFFICE_ROOTS: 'shapes=C:\\Icons' })).toThrowError(/category/)
  })
})

describe('listAssets', () => {
  it('lists office items and applies category and format filters', () => {
    const { fs, deps } = build()
    buildOffice(fs)
    discoverOfficeAssets({ roots, deps })
    const all = listAssets({ source: 'office', deps })
    expect(all.items).toHaveLength(3)
    expect(all.roots).toEqual([clipRoot, themeRoot, missingRoot])
    expect(all.recordFile).toBe(officeRecordPath(deps))
    const clip = listAssets({ source: 'office', category: 'clip-art', deps })
    expect(clip.items.map((item) => item.id)).toEqual(['clip-art-pub60cor-ag00004', 'clip-art-pub60cor-j0400001'])
    const png = listAssets({ source: 'office', format: 'png', deps })
    expect(png.items).toHaveLength(1)
    expect(png.items[0]?.licence).toContain('Office')
    const icons = listAssets({ source: 'office', category: 'icon', deps })
    expect(icons.items).toHaveLength(0)
    expect(formatAssetsList(icons)).toContain('cloud-hosted')
  })

  it('fails when the record is absent or a recorded file disappeared', () => {
    const fresh = build()
    expect(failureCode(() => listAssets({ source: 'office', deps: fresh.deps }))).toBe('OutputMissing')
    const { fs, deps } = build()
    buildOffice(fs)
    discoverOfficeAssets({ roots, deps })
    fs.removeTree(join(clipRoot, 'PUB60COR', 'J0400001.PNG'))
    const error = capture(() => listAssets({ source: 'office', deps }))
    expect((error as DshPptFailure).code).toBe('OutputMissing')
    expect((error as DshPptFailure).message).toContain('discover')
  })

  it('merges DSH_PPT_ASSET_DIRS and the deck assets directory', () => {
    const lib = join(workspace, 'libs', 'brand')
    const { fs, deps } = buildLibrary(lib, ['logo', 'photo'])
    fs.writeText(
      join(deck, 'assets', 'asset-manifest.json'),
      JSON.stringify({ version: 1, assets: [{ id: 'deckmark', file: 'deckmark.png', source: 'user', licence: 'CC0-1.0' }] }),
    )
    fs.writeBytes(join(deck, 'assets', 'deckmark.png'), Buffer.from('deck-png'))
    deps.env.DSH_PPT_ASSET_DIRS = lib
    const result = listAssets({ source: 'user', dir: deck, deps })
    expect(result.roots).toEqual([lib, join(deck, 'assets')])
    expect(result.items.map((item) => item.id)).toEqual(['logo', 'photo', 'deckmark'])
    expect(userAssetRoots(deck, deps)).toEqual([lib, join(deck, 'assets')])
    const text = formatAssetsList(result)
    expect(text).toContain('CC0-1.0 / Ada Lovelace')
    expect(text).toContain('3 asset(s)')
    expect(listAssets({ source: 'user', dir: deck, format: 'png', deps }).items).toHaveLength(2)
  })

  it('rejects a manifest without a licence, a bad format, an escaping file, a missing file and duplicate ids', () => {
    const cases: Record<string, string> = {
      licence: manifest([{ id: 'x', file: 'x.png', source: 'user' }]),
      format: manifest([{ id: 'x', file: 'x.tiff', source: 'user', licence: 'CC0-1.0' }]),
      escape: manifest([{ id: 'x', file: '../x.png', source: 'user', licence: 'CC0-1.0' }]),
    }
    for (const [name, text] of Object.entries(cases)) {
      const lib = join(workspace, 'libs', name)
      const { deps } = build({ [join(lib, 'asset-manifest.json')]: text })
      deps.env.DSH_PPT_ASSET_DIRS = lib
      expect(failureCode(() => listAssets({ source: 'user', deps })), name).toBe('ContractViolation')
    }
    const missing = join(workspace, 'libs', 'missing')
    const absent = build({ [join(missing, 'asset-manifest.json')]: manifest([{ id: 'x', file: 'x.png', source: 'user', licence: 'CC0-1.0' }]) })
    absent.deps.env.DSH_PPT_ASSET_DIRS = missing
    expect(failureCode(() => listAssets({ source: 'user', deps: absent.deps }))).toBe('OutputMissing')
    const dup = join(workspace, 'libs', 'dup')
    const duplicated = build({ [join(dup, 'asset-manifest.json')]: manifest([{ id: 'x', file: 'x.png', source: 'user', licence: 'CC0-1.0' }, { id: 'x', file: 'y.png', source: 'user', licence: 'CC0-1.0' }]) })
    duplicated.fs.writeBytes(join(dup, 'x.png'), Buffer.from('x'))
    duplicated.fs.writeBytes(join(dup, 'y.png'), Buffer.from('y'))
    duplicated.deps.env.DSH_PPT_ASSET_DIRS = dup
    expect(failureCode(() => listAssets({ source: 'user', deps: duplicated.deps }))).toBe('ContractViolation')
  })

  it('fails when a named library has no manifest or no library is named', () => {
    const { deps } = build()
    deps.env.DSH_PPT_ASSET_DIRS = join(workspace, 'libs', 'none')
    expect(failureCode(() => listAssets({ source: 'user', deps }))).toBe('ContractViolation')
    const bare = build()
    expect(failureCode(() => listAssets({ source: 'user', deps: bare.deps }))).toBe('OutputMissing')
  })

  it('refuses the office category filter on a user library', () => {
    const lib = join(workspace, 'libs', 'brand2')
    const { deps } = buildLibrary(lib, ['logo'])
    deps.env.DSH_PPT_ASSET_DIRS = lib
    expect(failureCode(() => listAssets({ source: 'user', category: 'icon', deps }))).toBe('UsageError')
  })
})

describe('copyAsset', () => {
  it('copies a user asset into the deck and stays idempotent', () => {
    const lib = join(workspace, 'libs', 'brand3')
    const { fs, deps } = buildLibrary(lib, ['logo', 'photo'])
    deps.env.DSH_PPT_ASSET_DIRS = lib
    const first = copyAsset({ source: 'user', id: 'logo', dir: deck, deps })
    expect(first.outputFile).toBe(join(deck, 'assets', 'logo.svg'))
    expect(first.relative).toBe('assets/logo.svg')
    expect(first.bytes).toBe(12)
    expect(formatAssetCopy(first)).toContain('copied assets/logo.svg')
    const second = copyAsset({ source: 'user', id: 'logo', dir: deck, deps })
    expect(second.unchanged).toBe(true)
    expect(formatAssetCopy(second)).toContain('unchanged')
    fs.writeBytes(join(lib, 'logo.svg'), Buffer.from('new-svg-bytes'))
    expect(failureCode(() => copyAsset({ source: 'user', id: 'logo', dir: deck, deps }))).toBe('ContractViolation')
    const forced = copyAsset({ source: 'user', id: 'logo', dir: deck, deps, force: true })
    expect(forced.replaced).toBe(true)
    expect(fs.readBytes(join(deck, 'assets', 'logo.svg'))?.toString()).toBe('new-svg-bytes')
  })

  it('honours --as and refuses escaping destinations', () => {
    const lib = join(workspace, 'libs', 'brand4')
    const { deps } = buildLibrary(lib, ['logo'])
    deps.env.DSH_PPT_ASSET_DIRS = lib
    const named = copyAsset({ source: 'user', id: 'logo', dir: deck, deps, as: 'brand-mark.svg' })
    expect(named.outputFile).toBe(join(deck, 'assets', 'brand-mark.svg'))
    expect(failureCode(() => copyAsset({ source: 'user', id: 'logo', dir: deck, deps, as: 'bad.png' }))).toBe('ContractViolation')
    expect(failureCode(() => copyAsset({ source: 'user', id: 'logo', dir: deck, deps, as: '../escape.svg' }))).toBe('ContractViolation')
    expect(failureCode(() => copyAsset({ source: 'user', id: 'logo', dir: deck, deps, output: '../outside' }))).toBe('PathOutsideWorkspace')
    expect(failureCode(() => copyAsset({ source: 'user', id: 'nope', dir: deck, deps }))).toBe('UsageError')
  })

  it('copies a discovered office asset', () => {
    const { fs, deps } = build()
    buildOffice(fs)
    discoverOfficeAssets({ roots, deps })
    const result = copyAsset({ source: 'office', id: 'clip-art-pub60cor-j0400001', dir: deck, deps })
    expect(result.outputFile).toBe(join(deck, 'assets', 'clip-art-pub60cor-j0400001.png'))
    expect(fs.readBytes(result.outputFile)?.toString()).toBe('png-bytes')
  })
})

/** Build a deck with a user library and its two reference assets. */
function buildLibrary(root: string, ids: readonly string[]): { fs: FakeFileSystem; deps: CommandDependencies } {
  const assets = ids.map((id, index) => ({
    id,
    file: `${id}.${index === 0 ? 'svg' : 'png'}`,
    source: 'user',
    licence: index === 0 ? 'CC0-1.0' : 'CC-BY-4.0',
    ...(index === 0 ? { author: 'Ada Lovelace', format: 'svg' } : {}),
  }))
  const { fs, deps } = build({ [join(root, 'asset-manifest.json')]: JSON.stringify({ version: 1, assets }) })
  for (const [index, id] of ids.entries()) {
    fs.writeBytes(join(root, `${id}.${index === 0 ? 'svg' : 'png'}`), Buffer.from(index === 0 ? 'svg-bytes-12' : 'png-bytes'))
  }
  return { fs, deps }
}

/** @returns a one-item user manifest document. */
function manifest(assets: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, assets })
}

/** @returns the DshPptFailure code of `run`, or a marker when it did not throw one. */
function failureCode(run: () => unknown): string {
  const error = capture(run)
  return error === null ? 'no-failure' : error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
}

/** @returns the thrown value, or null when `run` completed. */
function capture(run: () => unknown): unknown {
  try {
    run()
    return null
  } catch (error) {
    return error
  }
}
