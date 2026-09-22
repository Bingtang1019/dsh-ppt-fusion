import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, compareCanonical, describePartDifference, type CanonicalPackage } from './canonicalize.ts'
import { applyCompatPass, inspectCompat, type CompatChange, type CompatFinding, type CompatOccurrence, type CompatReport } from '../../src/bridge/compat.ts'
import { OpcPackage } from '../../src/bridge/opc.ts'
import { COMPAT_LEVELS, loadCompatRegistry, type CompatLevel } from '../../src/compat/registry.ts'
import { renderDeck } from '../../src/commands/render.ts'
import { themeEnsure } from '../../src/commands/theme.ts'
import { defaultDependencies } from '../../src/commands/context.ts'
import { PINNED } from '../../src/commands/doctor.ts'

/** Repository root, resolved from this file. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The golden deck's inputs (never overwritten by a run). */
export const HELLO_SOURCE = join(REPO_ROOT, 'fixtures', 'hello')

/** Recorded artifacts and the versioned manifest. */
export const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden')

/** Scratch workspace the golden deck is rendered in, so the fixture stays pristine. */
export const GOLDEN_WORKSPACE = join(REPO_ROOT, 'tmp', 'golden-work', 'hello')

/** One recorded artifact. */
export interface GoldenRef {
  readonly file: string
  readonly sha256: string
  /** Hash of the canonical part map; the tier this gate actually enforces. */
  readonly canonical: string
  readonly bytes: number
}

/** `fixtures/golden/golden-manifest.json`, in the shape plan §7.3 specifies. */
export interface GoldenManifest {
  readonly fixtureVersion: number
  readonly upstream: { readonly pptwise: string; readonly 'ppt-master': string }
  readonly baseRef: GoldenRef
  readonly deepRef: GoldenRef
  readonly mergedRef: GoldenRef
  readonly generatedBy: string
  readonly command: string
  readonly createdAt: string
}

/** @returns the SHA-256 of a file's bytes. */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** @returns a stable fingerprint of the canonical form, which is tier T1's key. */
export function canonicalFingerprint(pkg: CanonicalPackage): string {
  const entries = [...pkg.parts.entries()]
    .map(([name, part]) => `${name}=${typeof part === 'string' ? part : JSON.stringify(part)}`)
    .sort()
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

/**
 * Copy the golden fixture into a scratch workspace and derive its theme files.
 *
 * The fixture holds only authored inputs (IR, manifest, deep pages, motion
 * config); `theme.json`, `tokens.json` and `master-design.json` are generated, so
 * the gate exercises `theme ensure` instead of relying on committed derivatives.
 *
 * @returns the scratch deck directory.
 */
export function prepareWorkspace(): string {
  rmSync(GOLDEN_WORKSPACE, { recursive: true, force: true })
  mkdirSync(join(GOLDEN_WORKSPACE, '..'), { recursive: true })
  cpSync(HELLO_SOURCE, GOLDEN_WORKSPACE, { recursive: true })
  const deps = defaultDependencies()
  const changed = themeEnsure({ dir: GOLDEN_WORKSPACE, deps }).changed
  if (changed.length === 0) {
    throw new Error('theme ensure produced no files for the golden fixture; the fixture is not self-contained')
  }
  return GOLDEN_WORKSPACE
}

/**
 * Render the golden deck once and describe the three artifacts the manifest records.
 *
 * The chain already stages `base.pptx`, `deep.pptx` and `merged.pptx` under
 * `<deck>/.dsh-ppt/render/`, so one render yields all three references.
 *
 * @returns paths of the three staged artifacts.
 */
export async function renderGolden(): Promise<{ base: string; deep: string; merged: string; output: string }> {
  const workspace = prepareWorkspace()
  const result = await renderDeck({ dir: workspace, deps: defaultDependencies() })
  const staged = join(workspace, '.dsh-ppt', 'render')
  return {
    base: join(staged, 'base.pptx'),
    deep: join(staged, 'deep.pptx'),
    merged: join(staged, 'merged.pptx'),
    output: result.outputFile,
  }
}

/**
 * @param path - a pptx file.
 * @returns its recorded reference form (bytes hash, canonical hash, size).
 */
export async function describeArtifact(path: string): Promise<GoldenRef> {
  const bytes = readFileSync(path)
  const canonical = await canonicalize(bytes)
  return {
    file: path.slice(path.lastIndexOf('\\') + 1),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    canonical: canonicalFingerprint(canonical),
    bytes: bytes.byteLength,
  }
}

/**
 * Compare a fresh render against the recorded manifest.
 *
 * Byte equality is reported but not required: the engines stamp their own times,
 * so only the base deck is expected to be byte-stable (ADR-014). The enforced
 * comparison is canonical (tier T1).
 *
 * @returns one line per artifact plus a verdict.
 */
export async function verifyGolden(recorded: GoldenManifest): Promise<{ ok: boolean; lines: string[]; staged: { base: string; deep: string; merged: string; output: string } }> {
  const staged = await renderGolden()
  const pairs: [string, GoldenRef, string][] = [
    ['base', recorded.baseRef, staged.base],
    ['deep', recorded.deepRef, staged.deep],
    ['merged', recorded.mergedRef, staged.merged],
  ]
  const lines: string[] = []
  let ok = true
  for (const [label, reference, path] of pairs) {
    const fresh = await describeArtifact(path)
    const freshCanonical = await canonicalize(readFileSync(path))
    const recordedCanonical = await canonicalize(readFileSync(join(GOLDEN_DIR, reference.file)))
    const comparison = compareCanonical(freshCanonical, recordedCanonical)
    const byteStable = fresh.sha256 === reference.sha256
    if (!comparison.equal) {
      ok = false
      for (const difference of comparison.differences.slice(0, 4)) {
        lines.push(`  ${label} ${describePartDifference(freshCanonical, recordedCanonical, difference.slice(difference.indexOf(': ') + 2))}`)
      }
    }
    lines.push(
      `${label}: canonical ${comparison.equal ? 'equal' : `DIFFERENT (${comparison.differences.slice(0, 4).join('; ')})`}, bytes ${byteStable ? 'identical' : 'differ (expected for deep/merged)'} [${String(fresh.bytes)} bytes]`,
    )
  }
  return { ok, lines, staged }
}

/** @returns the recorded manifest, or null when nothing has been recorded yet. */
export function readGoldenManifest(): GoldenManifest | null {
  const path = join(GOLDEN_DIR, 'golden-manifest.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenManifest
}

/**
 * Copy the staged artifacts into `fixtures/golden/` and write the manifest.
 *
 * @param staged - the three artifact paths from a render.
 * @param previousVersion - fixture version to increment.
 * @returns the manifest that was written.
 */
export async function writeGolden(staged: { base: string; deep: string; merged: string }, previousVersion: number): Promise<GoldenManifest> {
  mkdirSync(GOLDEN_DIR, { recursive: true })
  const targets: Record<'baseRef' | 'deepRef' | 'mergedRef', string> = {
    baseRef: join(GOLDEN_DIR, 'hello-base.pptx'),
    deepRef: join(GOLDEN_DIR, 'hello-deep.pptx'),
    mergedRef: join(GOLDEN_DIR, 'hello-merged.pptx'),
  }
  cpSync(staged.base, targets.baseRef)
  cpSync(staged.deep, targets.deepRef)
  cpSync(staged.merged, targets.mergedRef)
  const manifest: GoldenManifest = {
    fixtureVersion: previousVersion + 1,
    upstream: { pptwise: PINNED.pptwise, 'ppt-master': PINNED.pptMaster },
    baseRef: await describeArtifact(targets.baseRef),
    deepRef: await describeArtifact(targets.deepRef),
    mergedRef: await describeArtifact(targets.mergedRef),
    generatedBy: 'pnpm fixtures:record',
    command: 'dsh-ppt render fixtures/hello',
    createdAt: new Date().toISOString(),
  }
  writeFileSync(join(GOLDEN_DIR, 'golden-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/** One compat level's stable report fields; the timestamp is deliberately absent. */
export interface CompatLevelSnapshot {
  readonly counts: CompatReport['counts']
  readonly occurrences: readonly CompatOccurrence[]
  readonly applied: readonly CompatChange[]
  readonly findings: readonly CompatFinding[]
}

/** The three-level compat golden recorded beside the package manifest. */
export interface CompatGolden {
  readonly fixtureVersion: number
  readonly registryVersion: number
  readonly levels: Readonly<Record<CompatLevel, CompatLevelSnapshot>>
}

/** @returns the snapshot fields of one report, dropping the volatile timestamp. */
function snapshotOf(report: CompatReport): CompatLevelSnapshot {
  return { counts: report.counts, occurrences: report.occurrences, applied: report.applied, findings: report.findings }
}

/**
 * Run the compat pass over one package at all three levels, each on its own clone.
 *
 * @param bytes - the merged package bytes.
 * @returns the stable per-level snapshots.
 * @throws DshPptFailure when the package cannot be read.
 */
export async function compatSnapshots(bytes: Buffer): Promise<CompatGolden> {
  const levels = {} as Record<CompatLevel, CompatLevelSnapshot>
  for (const level of COMPAT_LEVELS) {
    const pkg = await OpcPackage.read(bytes)
    const report = await applyCompatPass(pkg, { level })
    levels[level] = snapshotOf(report)
  }
  return { fixtureVersion: 0, registryVersion: 0, levels }
}

/** @returns the recorded compat golden, or null when nothing has been recorded yet. */
export function readCompatGolden(): CompatGolden | null {
  const path = join(GOLDEN_DIR, 'compat-levels.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as CompatGolden
}

/**
 * Write the compat golden beside the package manifest, carrying the same fixture version.
 *
 * @param golden - the snapshots to write.
 * @param fixtureVersion - the version the package manifest recorded.
 * @returns the document that was written.
 */
export function writeCompatGolden(golden: CompatGolden, fixtureVersion: number): CompatGolden {
  const document: CompatGolden = { ...golden, fixtureVersion, registryVersion: loadCompatRegistry().version }
  writeFileSync(join(GOLDEN_DIR, 'compat-levels.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return document
}

/**
 * The markers a level promises not to ship, checked on a package after the pass.
 *
 * @param pkg - the package to census.
 * @param level - the level it was processed at.
 * @returns one message per marker that should not be there.
 */
export function compatForbiddenMarkers(pkg: OpcPackage, level: CompatLevel): string[] {
  const violations: string[] = []
  if (level === 'max') return violations
  const xmlParts = pkg.names().filter((name) => /\.xml$/.test(name)).map((name) => [name, pkg.text(name)] as const)
  for (const [name, xml] of xmlParts) {
    if (/\sp159:morph="/.test(xml)) violations.push(`${name}: a morph transition survived ${level}`)
    const tier = level === 'safe' ? ['treemapChart', 'sunburstChart', 'histogramChart', 'waterfallChart', 'funnelChart', 'mapChart'] : ['mapChart']
    for (const element of tier) {
      if (new RegExp(`<c:${element}\\b`).test(xml)) violations.push(`${name}: ${element} survived ${level}`)
    }
  }
  return violations
}

/**
 * After the pass, every level must be structurally clean: the lint must report no
 * findings, and no level may keep a marker it forbids.
 *
 * @param bytes - the merged package bytes.
 * @param level - the level to check.
 * @returns one message per violation; empty means the level holds.
 */
export async function assertCompatLevel(bytes: Buffer, level: CompatLevel): Promise<string[]> {
  const processed = await OpcPackage.read(bytes)
  await applyCompatPass(processed, { level })
  const findings = inspectCompat(processed, { level }).findings.map((finding) => `${finding.rule}: ${finding.message}`)
  return [...compatForbiddenMarkers(processed, level), ...findings]
}
