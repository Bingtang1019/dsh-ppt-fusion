import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFrontend, resolvePptwiseCli, type Frontend } from '../../src/frontend.ts'
import { exportTokens, masterDesign, parseThemeFile, type MasterDesign, type TokensFile } from '../../src/schema/tokens.ts'
import { spawnRunner } from '../../src/engine/runner.ts'
import { PINNED } from '../../src/commands/doctor.ts'

/** Directory holding the recorded per-theme token snapshots. */
export const SNAPSHOT_DIR = fileURLToPath(new URL('../../fixtures/themes/', import.meta.url))

/** One theme's recorded palette contract. */
export interface ThemeSnapshot {
  readonly tokens: TokensFile
  readonly master: MasterDesign
}

const nodeRequire = createRequire(import.meta.url)

/**
 * Node's own resolver, used instead of `import.meta.resolve` because these
 * fixtures must find the real upstream package even when the test runs under a
 * bundler that rewrites `import.meta`.
 *
 * @param specifier - module specifier to resolve.
 * @returns the resolved file URL.
 */
export function nodeResolveModule(specifier: string): string {
  return pathToFileURL(nodeRequire.resolve(specifier)).href
}

/** @returns the real pptwise CLI resolution options. */
function realResolution(): { resolve: typeof nodeResolveModule; readText: (path: string) => string } {
  return { resolve: nodeResolveModule, readText: (path: string) => readFileSync(path, 'utf8') }
}

/**
 * @returns the resolved pptwise CLI, or null when the package is not installed.
 */
export function tryResolvePptwise(): ReturnType<typeof resolvePptwiseCli> | null {
  try {
    return resolvePptwiseCli(realResolution())
  } catch {
    return null
  }
}

/**
 * @param cli - resolved pptwise CLI.
 * @returns a front end rooted in a fresh temporary workspace.
 */
export function tempFrontend(cli: ReturnType<typeof resolvePptwiseCli>): { frontend: Frontend; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ppt-theme-'))
  return { frontend: createFrontend({ cli, workspace: dir, runner: spawnRunner, env: process.env }), dir }
}

/**
 * Materialise every requested preset through the real upstream CLI and export
 * its tokens, which is exactly what `theme ensure` does for one deck.
 *
 * @param ids - preset ids to capture.
 * @returns the exported token and master documents keyed by preset id.
 */
export function captureThemes(ids: readonly string[]): Record<string, ThemeSnapshot> {
  const cli = resolvePptwiseCli(realResolution())
  const captured: Record<string, ThemeSnapshot> = {}
  for (const id of ids) {
    const { frontend } = tempFrontend(cli)
    const written = frontend.themeNew({ from: id, output: 'theme.json', id })
    const theme = parseThemeFile(JSON.parse(readFileSync(written.outputFile, 'utf8')))
    const tokens = exportTokens(theme, { kind: 'preset', preset: id, upstream: PINNED.pptwise })
    captured[id] = { tokens, master: masterDesign(tokens) }
  }
  return captured
}

/**
 * @param cli - resolved pptwise CLI.
 * @returns the factory preset ids, sorted, straight from the upstream catalog.
 */
export function catalogIds(cli: ReturnType<typeof resolvePptwiseCli>): string[] {
  const { frontend } = tempFrontend(cli)
  return frontend
    .themes()
    .map((entry) => entry.id)
    .sort()
}

/**
 * @param id - preset id.
 * @returns absolute path of that preset's snapshot file.
 */
export function snapshotPath(id: string): string {
  return join(SNAPSHOT_DIR, `${id}.tokens.json`)
}

/**
 * Read a recorded snapshot.
 *
 * @param id - preset id.
 * @returns the snapshot, or null when nothing was recorded yet.
 */
export function readSnapshot(id: string): ThemeSnapshot | null {
  const path = snapshotPath(id)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as ThemeSnapshot
}

/**
 * Write a snapshot for one preset.
 *
 * @param id - preset id.
 * @param snapshot - captured documents.
 */
export function writeSnapshot(id: string, snapshot: ThemeSnapshot): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  writeFileSync(snapshotPath(id), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}
