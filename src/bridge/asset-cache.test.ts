import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createFakeFileSystem } from '../../tests/support/fake-runner.ts'
import { assetCacheKey, findAssetCacheEntry, putAssetCacheEntry, readAssetCache, verifyAssetCache, writeAssetCache } from './asset-cache.ts'

const cache = join(process.cwd(), 'tmp', 'asset-cache')

/** @returns a filesystem and one stored payload. */
function stored(): { fs: ReturnType<typeof createFakeFileSystem>; key: string } {
  const fs = createFakeFileSystem({ directories: [cache] })
  const key = assetCacheKey('user', 'logo', 'svg')
  putAssetCacheEntry(fs, cache, { key, source: 'user', id: 'logo', format: 'svg', bytes: Buffer.from('svg-bytes-12'), sourceBytes: 12 }, { now: () => new Date('2026-09-27T00:00:00.000Z') })
  return { fs, key }
}

describe('asset cache', () => {
  it('stores a payload with its digest and finds it back', () => {
    const { fs, key } = stored()
    const hit = findAssetCacheEntry(fs, cache, key)
    expect(hit?.bytes.toString()).toBe('svg-bytes-12')
    expect(hit?.entry.sha256).toHaveLength(64)
    expect(hit?.entry.fetchedAt).toBe('2026-09-27T00:00:00.000Z')
    expect(readAssetCache(fs, cache).entries).toHaveLength(1)
  })

  it('misses when the library size changed, and when the payload was damaged', () => {
    const { fs, key } = stored()
    expect(findAssetCacheEntry(fs, cache, key, { sourceBytes: 99 })).toBeNull()
    const hit = findAssetCacheEntry(fs, cache, key)
    fs.writeBytes(join(cache, hit?.entry.file ?? ''), Buffer.from('tampered'))
    expect(findAssetCacheEntry(fs, cache, key)).toBeNull()
    expect(verifyAssetCache(fs, cache).mismatched).toEqual([key])
  })

  it('reports missing payloads without pretending they are valid', () => {
    const { fs, key } = stored()
    const hit = findAssetCacheEntry(fs, cache, key)
    fs.removeTree(join(cache, hit?.entry.file ?? ''))
    expect(verifyAssetCache(fs, cache).missing).toEqual([key])
    expect(findAssetCacheEntry(fs, cache, key)).toBeNull()
  })

  it('refuses an index that is not an index', () => {
    const fs = createFakeFileSystem({ files: { [join(cache, 'manifest.json')]: '{ not json' } })
    expect(() => readAssetCache(fs, cache)).toThrow(/not JSON/)
    const wrongSchema = createFakeFileSystem({ files: { [join(cache, 'manifest.json')]: JSON.stringify({ schemaVersion: 99, entries: [] }) } })
    expect(() => readAssetCache(wrongSchema, cache)).toThrow(/unexpected shape/)
    const badEntry = createFakeFileSystem({ files: { [join(cache, 'manifest.json')]: JSON.stringify({ schemaVersion: 1, updatedAt: 'x', entries: [{ key: 'k' }] }) } })
    expect(() => readAssetCache(badEntry, cache)).toThrow(/unusable entr/)
  })

  it('replaces the entry for a key and keeps the others', () => {
    const { fs, key } = stored()
    const other = assetCacheKey('office', 'clip', 'png')
    putAssetCacheEntry(fs, cache, { key: other, source: 'office', id: 'clip', format: 'png', bytes: Buffer.from('png-bytes'), sourceBytes: 9 })
    putAssetCacheEntry(fs, cache, { key, source: 'user', id: 'logo', format: 'svg', bytes: Buffer.from('svg-bytes-13'), sourceBytes: 13 })
    const manifest = readAssetCache(fs, cache)
    expect(manifest.entries.map((entry) => entry.key).sort()).toEqual([key, other].sort())
    expect(findAssetCacheEntry(fs, cache, key, { sourceBytes: 13 })?.bytes.toString()).toBe('svg-bytes-13')
  })

  it('writes the index through a temporary file', () => {
    const { fs, key } = stored()
    writeAssetCache(fs, cache, { schemaVersion: 1, updatedAt: 'now', entries: [] })
    expect(readAssetCache(fs, cache).entries).toEqual([])
    expect(fs.exists(join(cache, 'manifest.json.tmp'))).toBe(false)
    expect(key).toContain('user:logo:svg')
  })
})