// Record or verify the theme matrix: six representative presets taken from
// `init` through `render` and `audit`. Run with `pnpm matrix:record` /
// `pnpm matrix:verify` (a CI gate).
//
// Each theme owns a page menu (measured: all 24 presets differ), and pptwise
// refuses to rebind a deck between menus, so the matrix builds a fresh minimal
// deck per preset rather than re-theming fixtures/hello. The deep-page,
// narration and pixel (delta E) paths stay covered by `fixtures:verify`, which
// now includes a pixel pass.
//
// The snapshot is semantic (tier T1): validate report, render receipt, canonical
// fingerprints of the three staged packages, and the audit report. Byte hashes
// are absent by design: the engines stamp their own times (ADR-014).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditDeck } from '../src/commands/audit.ts'
import { defaultDependencies } from '../src/commands/context.ts'
import { PINNED } from '../src/commands/doctor.ts'
import { initDeck } from '../src/commands/init.ts'
import { renderDeck } from '../src/commands/render.ts'
import { validateDeck } from '../src/commands/validate.ts'
import { canonicalize } from './support/canonicalize.ts'
import { canonicalFingerprint } from './support/golden.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const WORK = join(ROOT, 'tmp', 'theme-matrix')
const GOLDEN = join(ROOT, 'fixtures', 'golden', 'theme-matrix.json')
const SCHEMA_VERSION = 1

/** The representative presets: light business, academic, dark mono, bold fashion, classic, editorial. */
export const MATRIX_THEMES = ['brief', 'thesis', 'terminal', 'runway', 'heritage', 'ledger'] as const

/** One theme's recorded facts. */
export interface ThemeSnapshot {
  readonly validate: { readonly ok: boolean; readonly sources: readonly string[]; readonly findings: readonly string[] }
  readonly render: {
    readonly slides: number
    readonly merge: { readonly replaced: number; readonly imported: number; readonly multiMaster: boolean }
    readonly compat: { readonly level: string; readonly counts: Readonly<Record<string, number>> }
    readonly postflight: { readonly status: string; readonly qualityGate: string; readonly slides: number }
    readonly artifacts: { readonly base: string; readonly deep: string | null; readonly merged: string }
  }
  readonly audit: { readonly ok: boolean; readonly sources: readonly string[]; readonly findings: readonly string[]; readonly skipped: readonly string[] }
  readonly paletteFindings: number
  readonly fingerprint: string
}

/** The recorded matrix document. */
export interface ThemeMatrix {
  readonly schemaVersion: number
  readonly fixtureVersion: number
  readonly upstream: { readonly pptwise: string; readonly 'ppt-master': string }
  readonly themes: Readonly<Record<string, ThemeSnapshot>>
}

/** @returns the sorted finding fingerprints of a validate or audit report. */
function findingIds(findings: readonly { level: string; source: string; rule: string }[]): string[] {
  return findings.map((finding) => `${finding.level}|${finding.source}|${finding.rule}`).sort()
}

/**
 * Create the minimal deck for one preset and collect its semantic snapshot.
 *
 * @param theme - factory preset id.
 * @returns the snapshot, with a fingerprint over everything but the fingerprint itself.
 */
export async function captureTheme(theme: string): Promise<ThemeSnapshot> {
  const workspace = join(WORK, theme)
  rmSync(workspace, { recursive: true, force: true })
  const deps = defaultDependencies()
  const created = initDeck({ dir: workspace, theme, deps })
  if (!created.created.some((path) => path.endsWith('deck.fusion.json'))) {
    throw new Error(`${theme}: init did not write a manifest`)
  }

  const validation = validateDeck({ dir: workspace, deps })
  const rendered = await renderDeck({ dir: workspace, deps })
  const staged = join(workspace, '.dsh-ppt', 'render')
  // A standard-only deck stages base + merged; `deep.pptx` appears only when the
  // deck has deep pages (the matrix decks do not, the golden one does).
  const fingerprintOf = async (name: string): Promise<string | null> => {
    const file = join(staged, `${name}.pptx`)
    if (!existsSync(file)) return null
    return canonicalFingerprint(await canonicalize(readFileSync(file)))
  }
  const requiredFingerprint = async (name: string): Promise<string> => {
    const value = await fingerprintOf(name)
    if (value === null) throw new Error(`${theme}: ${name}.pptx was not staged`)
    return value
  }
  const audit = await auditDeck({ dir: workspace, strict: false, pixels: true, deps })

  const snapshot: Omit<ThemeSnapshot, 'fingerprint'> = {
    validate: { ok: validation.ok, sources: [...validation.sources].sort(), findings: findingIds(validation.findings) },
    render: {
      slides: rendered.slides,
      merge: { replaced: rendered.merge.replaced.length, imported: Object.keys(rendered.merge.imported).length, multiMaster: rendered.merge.multiMaster === true },
      compat: { level: rendered.compat.report.level, counts: { ...rendered.compat.report.counts } },
      postflight: {
        status: rendered.postflight.deep?.status ?? 'none',
        qualityGate: rendered.postflight.deep?.qualityGate ?? 'none',
        slides: rendered.postflight.deep?.slides ?? 0,
      },
      artifacts: { base: await requiredFingerprint('base'), deep: await fingerprintOf('deep'), merged: await requiredFingerprint('merged') },
    },
    audit: {
      ok: audit.ok,
      sources: [...audit.sources].sort(),
      findings: findingIds(audit.findings),
      skipped: [...audit.skipped].sort(),
    },
    paletteFindings: audit.findings.filter((finding) => finding.source === 'palette' || finding.rule.startsWith('palette-')).length,
  }
  return { ...snapshot, fingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') }
}

/** @returns the recorded matrix, or null when nothing was recorded yet. */
function readGolden(): ThemeMatrix | null {
  if (!existsSync(GOLDEN)) return null
  return JSON.parse(readFileSync(GOLDEN, 'utf8')) as ThemeMatrix
}

/** @returns the freshly captured matrix. */
export async function captureMatrix(): Promise<ThemeMatrix> {
  const themes: Record<string, ThemeSnapshot> = {}
  for (const theme of MATRIX_THEMES) {
    themes[theme] = await captureTheme(theme)
    process.stdout.write(`matrix ${theme}: ${themes[theme].fingerprint.slice(0, 12)} (merged ${themes[theme].render.artifacts.merged.slice(0, 12)})\n`)
  }
  return { schemaVersion: SCHEMA_VERSION, fixtureVersion: 1, upstream: { pptwise: PINNED.pptwise, 'ppt-master': PINNED.pptMaster }, themes }
}

/** Run the record/verify driver when this file is the process entry. */
async function main(): Promise<number> {
  const record = process.argv.includes('--record')
  const verify = process.argv.includes('--verify')
  const fresh = await captureMatrix()
  if (record) {
    writeFileSync(GOLDEN, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8')
    console.log(`matrix:record: wrote ${GOLDEN}`)
    return 0
  }
  if (!verify) {
    console.log(`matrix: captured ${String(MATRIX_THEMES.length)} themes; pass --record or --verify`)
    return 0
  }
  const recorded = readGolden()
  if (recorded === null) {
    console.error(`matrix:verify: no ${GOLDEN}; run pnpm matrix:record first`)
    return 1
  }
  const problems: string[] = []
  if (recorded.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion ${String(recorded.schemaVersion)} != ${String(SCHEMA_VERSION)}`)
  if (recorded.upstream.pptwise !== PINNED.pptwise) problems.push(`pptwise ${recorded.upstream.pptwise} -> ${PINNED.pptwise}`)
  if (recorded.upstream['ppt-master'] !== PINNED.pptMaster) problems.push(`ppt-master ${recorded.upstream['ppt-master']} -> ${PINNED.pptMaster}`)
  for (const theme of MATRIX_THEMES) {
    const expected = recorded.themes[theme]
    const actual = fresh.themes[theme]
    if (expected === undefined) {
      problems.push(`${theme}: not in the recorded matrix`)
      continue
    }
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      problems.push(`${theme}: snapshot changed\n  recorded: ${JSON.stringify(expected)}\n  fresh:    ${JSON.stringify(actual)}`)
    } else {
      console.log(`matrix ${theme}: equal`)
    }
  }
  if (problems.length > 0) {
    console.error('matrix:verify: the theme matrix no longer matches:')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('if the change is intended, run pnpm matrix:record and explain it in docs/decisions.md')
    return 1
  }
  console.log(`matrix:verify: all ${String(MATRIX_THEMES.length)} themes equal`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}