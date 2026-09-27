// Asset cache: the manifest, the payloads, and the validation that keeps a stale
// entry from becoming a wrong slide (ADR-088, plan Part E).
//
// `assets copy` reads from a library root or from the engine's discovery record;
// `images search` downloads through the engine. Both hand a deck the same kind of
// thing — a file plus an attribution record — and both were re-read on every copy.
// This module owns the one place a copied asset is remembered:
//
//   <cacheDir>/manifest.json   the index: one entry per asset key
//   <cacheDir>/blobs/<…>.ext   the bytes the entry describes
//
// The manifest is validated on every read: a malformed file is refused with the
// path in the message rather than silently rebuilt, because a cache whose index
// disagrees with its payloads is how a deck ends up with an image nobody chose.
// A payload that fails its own digest is treated as a miss and rewritten on the
// next copy; the entry stays until then, so a read-only cache directory degrades to
// "no cache" instead of a failed command.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FileSystemPort } from '../engine/venv.ts'
import { DshPptFailure } from '../engine/errors.ts'

/** Cache index file name. */
export const ASSET_CACHE_FILE = 'manifest.json'

/** Schema version of the cache index. */
export const ASSET_CACHE_SCHEMA_VERSION = 1

/** Directory inside the cache root holding payload bytes. */
export const ASSET_CACHE_BLOBS = 'blobs'

/** One remembered asset. */
export interface AssetCacheEntry {
  /** `source:id:format`, the identity a copy is requested by. */
  readonly key: string
  readonly source: 'office' | 'user'
  readonly id: string
  readonly format: string
  /** Payload path relative to the cache root. */
  readonly file: string
  /** sha256 of the payload. */
  readonly sha256: string
  /** Payload size in bytes. */
  readonly bytes: number
  /** Size of the library file this entry was copied from. */
  readonly sourceBytes: number
  /** Copied from the file's store, kept so a repeated call skips the write. */
  readonly fetchedAt: string
}

/** The cache index. */
export interface AssetCacheManifest {
  readonly schemaVersion: number
  readonly updatedAt: string
  readonly entries: readonly AssetCacheEntry[]
}

/** What a cache lookup found. */
export interface AssetCacheHit {
  readonly entry: AssetCacheEntry
  /** Absolute payload path. */
  readonly path: string
  readonly bytes: Buffer
}

/** @param source - library the asset came from. @param id - asset id. @param format - file suffix. @returns the cache key. */
export function assetCacheKey(source: string, id: string, format: string): string {
  return `${source}:${id}:${format}`
}

/** @param bytes - payload bytes. @returns the lowercase hex sha256. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @param key - cache key. @returns a payload file name safe on every platform. */
function payloadName(key: string, format: string): string {
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return `${slug === '' ? 'asset' : slug}.${format}`
}

/** @param fs - filesystem port. @param cacheDir - absolute cache root. @returns the absolute index path. */
export function assetCacheIndex(cacheDir: string): string {
  return join(cacheDir, ASSET_CACHE_FILE)
}

/** @returns an empty index. */
function emptyManifest(now: () => Date): AssetCacheManifest {
  return { schemaVersion: ASSET_CACHE_SCHEMA_VERSION, updatedAt: now().toISOString(), entries: [] }
}

/** @param value - parsed index. @returns true when every field this module reads is present. */
function isEntry(value: unknown): value is AssetCacheEntry {
  const entry = value as AssetCacheEntry | null
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.key === 'string' &&
    (entry.source === 'office' || entry.source === 'user') &&
    typeof entry.id === 'string' &&
    typeof entry.format === 'string' &&
    typeof entry.file === 'string' &&
    typeof entry.sha256 === 'string' &&
    entry.sha256.length === 64 &&
    Number.isInteger(entry.bytes) &&
    Number.isInteger(entry.sourceBytes)
  )
}

/**
 * Read the cache index.
 *
 * @param fs - filesystem port.
 * @param cacheDir - absolute cache root.
 * @param options.now - clock, for the empty case.
 * @returns the index; an absent cache is an empty index, never an error.
 * @throws DshPptFailure `ContractViolation` when the file exists but is not a valid index.
 */
export function readAssetCache(fs: FileSystemPort, cacheDir: string, options: { now?: () => Date } = {}): AssetCacheManifest {
  const path = assetCacheIndex(cacheDir)
  const text = fs.readText(path)
  if (text === null) return emptyManifest(options.now ?? (() => new Date()))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `the asset cache index is not JSON: ${path} (${error instanceof Error ? error.message : String(error)})`, { detail: { path } })
  }
  const manifest = parsed as AssetCacheManifest | null
  if (manifest === null || typeof manifest !== 'object' || manifest.schemaVersion !== ASSET_CACHE_SCHEMA_VERSION || !Array.isArray(manifest.entries)) {
    throw new DshPptFailure('ContractViolation', `the asset cache index has an unexpected shape: ${path}`, { detail: { path } })
  }
  const broken = manifest.entries.filter((entry) => !isEntry(entry))
  if (broken.length > 0) {
    throw new DshPptFailure('ContractViolation', `the asset cache index has ${String(broken.length)} unusable entr(ies): ${path}`, { detail: { path } })
  }
  return manifest
}

/**
 * Write the index through a temporary sibling.
 *
 * @param fs - filesystem port.
 * @param cacheDir - absolute cache root.
 * @param manifest - index to write.
 */
export function writeAssetCache(fs: FileSystemPort, cacheDir: string, manifest: AssetCacheManifest): void {
  fs.mkdirp(cacheDir)
  const path = assetCacheIndex(cacheDir)
  fs.writeText(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.rename(`${path}.tmp`, path)
}

/**
 * Look one asset up.
 *
 * @param fs - filesystem port.
 * @param cacheDir - absolute cache root.
 * @param key - cache key.
 * @param options.verify - recompute the payload digest (default true for the entry being read).
 * @param options.sourceBytes - current library size; an entry recorded from a different size is stale.
 * @returns the hit, or null when the entry is absent, stale, or its payload does not match.
 * @throws DshPptFailure `ContractViolation` when the index itself is unusable.
 */
export function findAssetCacheEntry(
  fs: FileSystemPort,
  cacheDir: string,
  key: string,
  options: { verify?: boolean; sourceBytes?: number } = {},
): AssetCacheHit | null {
  const manifest = readAssetCache(fs, cacheDir)
  const entry = manifest.entries.find((candidate) => candidate.key === key)
  if (entry === undefined) return null
  if (options.sourceBytes !== undefined && options.sourceBytes !== entry.sourceBytes) return null
  const path = join(cacheDir, entry.file)
  const bytes = fs.readBytes(path)
  if (bytes === null || bytes.length !== entry.bytes) return null
  if (options.verify !== false && sha256(bytes) !== entry.sha256) return null
  return { entry, path, bytes }
}

/**
 * Remember one asset, replacing any earlier entry for the key.
 *
 * @param fs - filesystem port.
 * @param cacheDir - absolute cache root.
 * @param input - key, source, id, format, payload and the library size it came from.
 * @param options.now - clock, for the entry stamp.
 * @returns the entry as written.
 */
export function putAssetCacheEntry(
  fs: FileSystemPort,
  cacheDir: string,
  input: { key: string; source: 'office' | 'user'; id: string; format: string; bytes: Buffer; sourceBytes: number },
  options: { now?: () => Date } = {},
): AssetCacheEntry {
  const now = options.now ?? (() => new Date())
  const manifest = readAssetCache(fs, cacheDir, { now })
  const file = join(ASSET_CACHE_BLOBS, payloadName(input.key, input.format))
  const entry: AssetCacheEntry = {
    key: input.key,
    source: input.source,
    id: input.id,
    format: input.format,
    file,
    sha256: sha256(input.bytes),
    bytes: input.bytes.length,
    sourceBytes: input.sourceBytes,
    fetchedAt: now().toISOString(),
  }
  fs.mkdirp(join(cacheDir, ASSET_CACHE_BLOBS))
  const payload = join(cacheDir, file)
  fs.writeBytes(`${payload}.tmp`, input.bytes)
  fs.rename(`${payload}.tmp`, payload)
  writeAssetCache(fs, cacheDir, {
    schemaVersion: ASSET_CACHE_SCHEMA_VERSION,
    updatedAt: entry.fetchedAt,
    entries: [...manifest.entries.filter((candidate) => candidate.key !== input.key), entry],
  })
  return entry
}

/**
 * Check every payload against its entry.
 *
 * @param fs - filesystem port.
 * @param cacheDir - absolute cache root.
 * @returns how many entries were checked, which payloads are missing, and which disagree with their digest.
 */
export function verifyAssetCache(fs: FileSystemPort, cacheDir: string): { checked: number; missing: string[]; mismatched: string[] } {
  const manifest = readAssetCache(fs, cacheDir)
  const missing: string[] = []
  const mismatched: string[] = []
  for (const entry of manifest.entries) {
    const bytes = fs.readBytes(join(cacheDir, entry.file))
    if (bytes === null) {
      missing.push(entry.key)
      continue
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) mismatched.push(entry.key)
  }
  return { checked: manifest.entries.length, missing, mismatched }
}