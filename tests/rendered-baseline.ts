// Rendered page baselines: record and verify the page images `renderpages` produced.
//
// Rendered bytes depend on the engine build, so a baseline carries the engine
// version next to every page hash (ADR-082). Verification compares the source
// digest first, then the engine version (drift means re-record, not a failure of
// the deck), then each page's dimensions and sha256.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderEngineId, RenderPage } from '../src/bridge/render-pages.ts'

/** Schema version of a rendered baseline file. */
export const RENDERED_BASELINE_VERSION = 1

/** One engine's recorded pages. */
export interface RenderedEngineBaseline {
  readonly version: string
  readonly dpi: number
  readonly pages: readonly RenderPage[]
}

/** One deck's rendered baseline. */
export interface RenderedBaseline {
  readonly schemaVersion: number
  readonly fixtureVersion: number
  readonly name: string
  readonly recordedAt: string
  readonly source: { readonly file: string; readonly sha256: string; readonly slides: number }
  readonly engines: Partial<Record<RenderEngineId, RenderedEngineBaseline>>
}

/** One drift the verifier found. */
export interface RenderedDrift {
  readonly engine: RenderEngineId
  readonly page: number | null
  readonly detail: string
}

/** @param bytes - file bytes. @returns lowercase SHA-256. */
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** @param text - JSON text. @returns the parsed baseline, or null when it is not one. */
export function parseRenderedBaseline(text: string): RenderedBaseline | null {
  try {
    const parsed = JSON.parse(text) as Partial<RenderedBaseline>
    if (parsed.schemaVersion !== RENDERED_BASELINE_VERSION || typeof parsed.name !== 'string' || parsed.source === undefined || parsed.engines === undefined) return null
    return parsed as RenderedBaseline
  } catch {
    return null
  }
}

/**
 * Read the snapshots `renderpages` stored for one deck.
 *
 * @param deckDir - absolute deck workspace.
 * @param name - baseline name, for the file.
 * @param fixtureVersion - the package fixture version to stamp.
 * @param now - clock, injected for deterministic tests.
 * @returns the baseline built from the on-disk `pages.json` and engine manifests.
 * @throws Error when the deck has no snapshots.
 */
export function buildRenderedBaseline(deckDir: string, name: string, fixtureVersion: number, now = (): string => new Date().toISOString().slice(0, 10)): RenderedBaseline {
  const pagesFile = join(deckDir, '.dsh-ppt', 'render', 'pages.json')
  const summary = JSON.parse(readFileSync(pagesFile, 'utf8')) as { source: string; sourceSha256: string; engines: { engine: RenderEngineId; status: string; version: string | null }[]; maxPages: number }
  const engines: Partial<Record<RenderEngineId, RenderedEngineBaseline>> = {}
  for (const engine of summary.engines) {
    if (engine.status === 'skipped' || engine.version === null) continue
    const manifest = JSON.parse(readFileSync(join(deckDir, '.dsh-ppt', 'render', engine.engine, 'manifest.json'), 'utf8')) as { engineVersion: string; dpi: number; pages: RenderPage[] }
    engines[engine.engine] = { version: manifest.engineVersion, dpi: manifest.dpi, pages: manifest.pages }
  }
  return {
    schemaVersion: RENDERED_BASELINE_VERSION,
    fixtureVersion,
    name,
    recordedAt: now(),
    source: { file: summary.source, sha256: summary.sourceSha256, slides: Object.values(engines)[0]?.pages.length ?? 0 },
    engines,
  }
}

/**
 * @param baseline - recorded baseline.
 * @param deckDir - absolute deck workspace.
 * @returns every drift between the recorded baseline and the snapshots on disk.
 */
export function verifyRenderedBaseline(baseline: RenderedBaseline, deckDir: string): RenderedDrift[] {
  const drifts: RenderedDrift[] = []
  const pagesFile = join(deckDir, '.dsh-ppt', 'render', 'pages.json')
  const summary = JSON.parse(readFileSync(pagesFile, 'utf8')) as { sourceSha256: string; engines: { engine: RenderEngineId; status: string; version: string | null }[] }
  if (summary.sourceSha256 !== baseline.source.sha256) {
    drifts.push({ engine: (Object.keys(baseline.engines)[0] as RenderEngineId | undefined) ?? 'libreoffice', page: null, detail: `source sha256 is ${summary.sourceSha256} but the baseline recorded ${baseline.source.sha256}` })
    return drifts
  }
  for (const [engine, recorded] of Object.entries(baseline.engines) as [RenderEngineId, RenderedEngineBaseline][]) {
    const live = summary.engines.find((entry) => entry.engine === engine)
    if (live === undefined || live.status === 'skipped') {
      drifts.push({ engine, page: null, detail: 'the live snapshots have no pass for this engine' })
      continue
    }
    if (live.version !== recorded.version) {
      drifts.push({ engine, page: null, detail: `engine version is ${String(live.version)} but the baseline recorded ${recorded.version}; re-record` })
      continue
    }
    const manifest = JSON.parse(readFileSync(join(deckDir, '.dsh-ppt', 'render', engine, 'manifest.json'), 'utf8')) as { pages: RenderPage[] }
    if (manifest.pages.length !== recorded.pages.length) {
      drifts.push({ engine, page: null, detail: `rendered ${String(manifest.pages.length)} page(s) but the baseline recorded ${String(recorded.pages.length)}` })
      continue
    }
    for (const [offset, page] of manifest.pages.entries()) {
      const expected = recorded.pages[offset]
      if (expected === undefined) continue
      if (page.sha256 !== expected.sha256) {
        drifts.push({ engine, page: page.index, detail: `page ${String(page.index)} hashes to ${page.sha256.slice(0, 12)}… but the baseline recorded ${expected.sha256.slice(0, 12)}…` })
      } else if (page.width !== expected.width || page.height !== expected.height) {
        drifts.push({ engine, page: page.index, detail: `page ${String(page.index)} is ${String(page.width)}x${String(page.height)} but the baseline recorded ${String(expected.width)}x${String(expected.height)}` })
      }
    }
  }
  return drifts
}

/** @param path - baseline file. @param baseline - baseline to write. */
export function writeRenderedBaseline(path: string, baseline: RenderedBaseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

/** @param path - baseline file. @returns the parsed baseline, or null. */
export function readRenderedBaseline(path: string): RenderedBaseline | null {
  try {
    return parseRenderedBaseline(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** @param bytes - page bytes. @returns their digest; exported so a recorder can hash a fresh render. */
export function pageDigest(bytes: Buffer): string {
  return digest(bytes)
}