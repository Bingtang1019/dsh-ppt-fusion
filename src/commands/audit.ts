import { join, resolve } from 'node:path'
import { isDshPptFailure } from '../engine/errors.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { irRoleAt, loadDeck } from '../deck.ts'
import { validateDeck } from './validate.ts'
import { engineFor, frontendFor, resolveDeckDir, type CommandDependencies } from './context.ts'
import { resolveCompatLevel } from './render.ts'
import { OpcPackage, auditPackage } from '../bridge/opc.ts'
import { auditChrome, chromePagesFrom } from '../bridge/chrome.ts'
import { inspectCompat } from '../bridge/compat.ts'
import { collectPixelFindings } from '../bridge/pixels.ts'
import { runSkillAudit } from './skill.ts'
import type { FusionAuditReport, FusionFinding } from '../audit.ts'
import type { CompatLevel } from '../compat/registry.ts'

/** Parameters for `dsh-ppt audit` (plan §3.8). */
export interface AuditOptions {
  readonly dir: string
  /** Fail on warnings as well as errors. */
  readonly strict: boolean
  /** Also sample the deep SVGs and compare their colours with the palette. */
  readonly pixels: boolean
  /** Explicit package to audit; defaults to the deck's last published render. */
  readonly file?: string
  /** Compat level override; defaults to the manifest's field, then `standard`. */
  readonly compat?: CompatLevel
  readonly deps: CommandDependencies
}

/** The order sources appear in the report, independent of the order they ran. */
const SOURCE_ORDER = [
  'manifest',
  'ir',
  'storyboard',
  'deep',
  'theme',
  'palette',
  'pptwise-validate',
  'pptwise-audit',
  'pptx',
  'chrome',
  'svg-quality-check',
  'pptx-delivery-check',
  'prompt-audit',
  'compat-lint',
] as const

/**
 * Run the unified audit gate over one deck workspace: the pre-render checks
 * (`validate`), pptwise's own IR validation and geometry audit, the deep pages' SVG
 * quality gate, the published package's OPC/P1/compat/delivery checks, and optionally
 * the pixel-level colour difference — the eight sources plan §3.8 names. Sources that
 * cannot run are reported in `skipped` instead of silently passing.
 *
 * @param options - deck directory, strictness, pixel opt-in, artifact and level overrides.
 * @returns the aggregate report; `ok` follows the requested strictness.
 */
export async function auditDeck(options: AuditOptions): Promise<FusionAuditReport> {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const findings: FusionFinding[] = []
  const ran = new Set<string>()
  const skipped: string[] = []

  const validation = validateDeck({ dir, deps: options.deps })
  for (const source of validation.sources) ran.add(source)
  findings.push(...validation.findings)

  let context: ReturnType<typeof loadDeck> | null = null
  try {
    context = loadDeck(dir, fs)
  } catch {
    // `validate` already reported the unreadable manifest or IR; the sources that
    // depend on it are named as skipped rather than reported twice.
    skipped.push('pptwise-validate, pptwise-audit: the deck does not load')
  }

  if (context !== null) {
    findings.push(...pptwiseFindings(dir, context.deck.pptwiseIr, options, ran))
  }

  const deepPages = context?.deck.pages.filter((page) => page.route === 'ppt-master') ?? []
  findings.push(...deepQualityFindings(dir, options.deps, deepPages.length > 0, ran, skipped))

  const artifact = resolveArtifact({ dir, file: options.file, fs })
  let compatLevel: string | null = null
  if (artifact === null) {
    findings.push({
      level: 'error',
      source: 'pptx',
      rule: 'artifact-missing',
      message:
        options.file === undefined
          ? `no published package under ${join(dir, 'out')}; run \`dsh-ppt render\` first or pass --file`
          : `${options.file} is not a readable package inside the deck`,
    })
    skipped.push('opc, pptx-delivery-check, compat-lint: no package to audit')
    if (context !== null && context.deck.chrome !== undefined) skipped.push('chrome: no package to audit')
  } else {
    const bytes = fs.readBytes(artifact.path)
    if (bytes === null || bytes.length === 0) {
      findings.push({ level: 'error', source: 'pptx', rule: 'artifact-unreadable', message: `${artifact.relative} is empty or unreadable` })
      skipped.push('opc, pptx-delivery-check, compat-lint: the package is unreadable')
    } else {
      const pkg = await OpcPackage.read(bytes)
      ran.add('pptx')
      for (const finding of auditPackage(pkg, { requireSingleMaster: true })) {
        findings.push({ level: finding.level, source: 'pptx', rule: finding.rule, message: finding.message })
      }
      if (context !== null && context.deck.chrome !== undefined) {
        ran.add('chrome')
        const pages = chromePagesFrom(context.deck.pages, (index) => irRoleAt(context.ir, index))
        findings.push(...auditChrome(pkg, { chrome: context.deck.chrome, pages }))
      }
      const level = resolveCompatLevel(options.compat, context?.deck.compat).level
      compatLevel = level
      ran.add('compat-lint')
      const inspection = inspectCompat(pkg, { level })
      for (const finding of inspection.findings) {
        findings.push({ level: finding.level, source: 'compat-lint', rule: finding.rule, message: finding.message })
      }
      ran.add('pptx-delivery-check')
      try {
        engineFor(dir, options.deps).deliveryCheck({ file: artifact.relative })
      } catch (error) {
        findings.push(failureFinding('pptx-delivery-check', 'delivery-check-failed', error))
      }
    }
  }

  if (options.pixels && context !== null && context.tokens !== null && deepPages.length > 0) {
    ran.add('palette')
    const pages = deepPages.map((page) => ({
      page: page.index,
      path: relative(dir, join(dir, page.deep.dir, 'page.svg')),
      svg: fs.readText(join(dir, page.deep.dir, 'page.svg')) ?? '',
    }))
    findings.push(...(await collectPixelFindings(context.tokens, pages)))
  } else if (options.pixels) {
    skipped.push('pixels: no deep page with an in-sync tokens file to sample')
  }

  try {
    const prompt = runSkillAudit({ strict: false, deps: options.deps })
    ran.add('prompt-audit')
    for (const finding of prompt.findings) {
      const where = finding.path === '' ? '' : `${finding.path}${finding.line > 0 ? `:${String(finding.line)}` : ''}: `
      findings.push({ level: finding.level, source: 'prompt-audit', rule: finding.code, message: `${where}${finding.message}` })
    }
  } catch (error) {
    // A consumer machine without the engine venv can still audit a pure pptwise
    // deck; the budget gate is a development-time source, so it is named as
    // skipped instead of failing a deck the engine never touched.
    skipped.push(`prompt-audit: ${isDshPptFailure(error) ? `${error.code} ${error.message}` : String(error)}`)
  }

  const errors = findings.filter((finding) => finding.level === 'error').length
  const warnings = findings.length - errors
  return {
    schemaVersion: 1,
    ok: errors === 0 && (!options.strict || warnings === 0),
    strict: options.strict,
    findings: sortFindings(findings),
    sources: SOURCE_ORDER.filter((source) => ran.has(source)),
    artifact: artifact === null ? null : artifact.relative,
    compatLevel,
    pixels: options.pixels,
    skipped,
  }
}

/** pptwise's own IR validation and geometry audit for the standard pages. */
function pptwiseFindings(dir: string, ir: string, options: AuditOptions, ran: Set<string>): FusionFinding[] {
  const findings: FusionFinding[] = []
  const frontend = frontendFor(dir, options.deps)
  ran.add('pptwise-validate')
  try {
    const result = frontend.validate(ir)
    if (!result.ok) {
      findings.push({ level: 'error', source: 'pptwise-validate', rule: 'pptwise-ir-invalid', message: result.data.message.trim() || 'pptwise validate failed' })
    }
  } catch (error) {
    findings.push(failureFinding('pptwise-validate', 'pptwise-validate-failed', error))
  }
  ran.add('pptwise-audit')
  try {
    const result = frontend.audit(ir, { pixels: options.pixels })
    for (const entry of result.data.findings ?? []) {
      const page = entry.page ?? entry.slide
      findings.push({
        level: entry.severity === 'error' ? 'error' : 'warning',
        source: 'pptwise-audit',
        ...(page === undefined ? {} : { page }),
        rule: entry.code ?? 'pptwise-audit',
        message: entry.message ?? 'pptwise audit finding',
      })
    }
    if (!result.ok && (result.data.findings ?? []).length === 0) {
      findings.push({
        level: 'error',
        source: 'pptwise-audit',
        rule: 'pptwise-audit-failed',
        message: result.stdout.trim() || result.stderr.trim() || 'pptwise audit exited non-zero without findings',
      })
    }
  } catch (error) {
    findings.push(failureFinding('pptwise-audit', 'pptwise-audit-failed', error))
  }
  return findings
}

/**
 * Re-run the deep pages' SVG quality gate on every recorded project and translate the
 * report's blocking/introduced/inherited/source-import categories into findings.
 */
function deepQualityFindings(
  dir: string,
  deps: CommandDependencies,
  wantsDeep: boolean,
  ran: Set<string>,
  skipped: string[],
): FusionFinding[] {
  const findings: FusionFinding[] = []
  const root = join(dir, '.dsh-ppt', 'deep')
  const projects = deps.fs.isDirectory(root) ? deps.fs.listDir(root).filter((name) => deps.fs.isDirectory(join(root, name))).sort() : []
  if (projects.length === 0) {
    if (wantsDeep) skipped.push('svg-quality-check: no recorded deep project; run `dsh-ppt render` or `dsh-ppt deep render` first')
    return findings
  }
  ran.add('svg-quality-check')
  for (const name of projects) {
    const target = `.dsh-ppt/deep/${name}`
    try {
      engineFor(dir, deps).qualityCheck({ target, stage: 'final', quickGenerate: true, canonicalAuthoring: true })
    } catch (error) {
      findings.push(failureFinding('svg-quality-check', 'svg-quality-failed', error))
    }
    const text = deps.fs.readText(join(dir, target, 'validation', 'svg_quality_report.json'))
    if (text === null) {
      findings.push({ level: 'error', source: 'svg-quality-check', rule: 'svg-quality-report-missing', message: `${target}/validation/svg_quality_report.json was not written` })
      continue
    }
    let report: { categories?: Record<string, { issues?: readonly { file?: string; message?: string }[] }> }
    try {
      report = JSON.parse(text) as typeof report
    } catch (error) {
      findings.push({ level: 'error', source: 'svg-quality-check', rule: 'svg-quality-report-unreadable', message: `${target} report is not JSON: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const mapping = [
      ['blocking', 'error'],
      ['introduced', 'warning'],
      ['inherited', 'warning'],
      ['source-import', 'warning'],
    ] as const
    for (const [category, level] of mapping) {
      for (const issue of report.categories?.[category]?.issues ?? []) {
        findings.push({
          level,
          source: 'svg-quality-check',
          rule: `svg-quality-${category}`,
          message: `${issue.file ?? name}: ${issue.message ?? category}`,
        })
      }
    }
  }
  return findings
}

/** The package to audit: `--file`, else the last render's manifest entry, else one pptx. */
function resolveArtifact(input: { dir: string; file: string | undefined; fs: CommandDependencies['fs'] }): { path: string; relative: string } | null {
  if (input.file !== undefined) {
    const path = assertInsideWorkspace(input.dir, input.file, 'file')
    if (!input.fs.exists(path)) return null
    return { path, relative: relative(input.dir, path) }
  }
  const manifestText = input.fs.readText(join(input.dir, 'out', 'manifest.json'))
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText) as { file?: unknown }
      if (typeof manifest.file === 'string' && manifest.file.length > 0) {
        const path = resolve(input.dir, manifest.file)
        if (input.fs.exists(path)) return { path, relative: manifest.file }
      }
    } catch {
      // A corrupt manifest is not this command's finding; the single-pptx fallback
      // below still lets the audit run.
    }
  }
  const outDir = join(input.dir, 'out')
  if (!input.fs.isDirectory(outDir)) return null
  const candidates = input.fs.listDir(outDir).filter((name) => name.toLowerCase().endsWith('.pptx')).sort()
  if (candidates.length !== 1) return null
  const name = candidates[0] ?? ''
  return { path: join(outDir, name), relative: `out/${name}` }
}

/** @returns an error finding from an arbitrary thrown value. */
function failureFinding(source: string, rule: string, error: unknown): FusionFinding {
  const failure = isDshPptFailure(error) ? error : undefined
  return { level: 'error', source, rule, message: failure === undefined ? String(error) : `${failure.code}: ${failure.message}` }
}

/** @returns findings ordered errors first, then by source, page, rule and message. */
function sortFindings(findings: readonly FusionFinding[]): FusionFinding[] {
  const key = (finding: FusionFinding): string =>
    `${finding.level === 'error' ? '0' : '1'}\u0000${finding.source}\u0000${String(finding.page ?? 0).padStart(4, '0')}\u0000${finding.rule}\u0000${finding.message}`
  return [...findings].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0))
}

/** @param root - deck directory. @param path - absolute path. @returns the workspace-relative path. */
function relative(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : path
}
