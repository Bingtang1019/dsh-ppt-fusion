import { isAbsolute, join, resolve } from 'node:path'
import { DshPptFailure, isDshPptFailure } from '../engine/errors.ts'
import { irRoleAt, loadDeck } from '../deck.ts'
import { validateDeck } from './validate.ts'
import { engineFor, frontendFor, resolveArtifact, resolveDeckDir, type CommandDependencies, designRoleMap } from './context.ts'
import { resolveCompatLevel } from './render.ts'
import { OpcPackage, auditPackage, listSlides } from '../bridge/opc.ts'
import { auditChrome, chromePagesFrom, slideSize } from '../bridge/chrome.ts'
import { designRoleFor } from '../bridge/background.ts'
import { auditDesignBackgrounds, auditDesignPackage } from '../bridge/design-audit.ts'
import { officeRecordPath } from './assets.ts'
import { DESIGN_ROLES, parseDesignProfile, type DesignProfile, type DesignRole } from '../schema/design-profile.ts'
import { USER_ASSET_MANIFEST, parseOfficeAssetRecord, parseUserAssetManifest } from '../schema/assets.ts'
import { inspectCompat } from '../bridge/compat.ts'
import { collectPixelFindings } from '../bridge/pixels.ts'
import { shapeGeometry, shapeRuns, simpleLuminance, topLevelShapes } from '../bridge/slide-text.ts'
import { auditRenderedPages, offPageFindings, overlapFindings, type RenderChromeDeclaration, type RenderSlideGeometry } from '../bridge/render-audit.ts'
import { runSkillAudit } from './skill.ts'
import type { FusionPage } from '../schema/fusion.ts'
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
  /** Design profile JSON to check the package against (V7.2 B4). */
  readonly profile?: string
  /** 1-based role overrides for a package without a storyboard, e.g. `cover=1;content=2,3`. */
  readonly roles?: string
  /** Also run the render-level rules over the stored snapshots (V10 Part A). */
  readonly rendered?: boolean
  /** Fail when no snapshots exist instead of recording the render source as skipped. */
  readonly requireRendered?: boolean
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
  'design',
  'render',
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

  // The design profile loads before the workspace checks: a profile audit may target
  // a package outside a deck workspace (S26 audits the reference deck itself), and an
  // unreadable profile is this audit's finding rather than a thrown command failure.
  let profile: DesignProfile | null = null
  let roleOverrides: Map<number, DesignRole> | undefined
  if (options.profile !== undefined) {
    try {
      profile = readDesignProfile(dir, options.profile, fs)
    } catch (error) {
      findings.push(failureFinding('design', 'design-profile-invalid', error))
      skipped.push('design: the profile could not be loaded')
    }
    if (profile !== null && options.roles !== undefined) {
      try {
        roleOverrides = parseDesignRoles(options.roles)
      } catch (error) {
        findings.push(failureFinding('design', 'design-roles-invalid', error))
        skipped.push('design: the --roles spec could not be parsed')
      }
    }
  }
  const artifact = resolveArtifact({ dir, file: options.file, fs, allowOutside: profile !== null })
  const packageOnly = artifact !== null && profile !== null && !isInside(dir, artifact.path)
  if (packageOnly && artifact !== null) skipped.push(`workspace: ${artifact.relative} is outside ${dir}; audited the package only`)

  let context: ReturnType<typeof loadDeck> | null = null
  let deepPages: Extract<FusionPage, { route: 'ppt-master' }>[] = []
  if (!packageOnly) {
    const validation = validateDeck({ dir, deps: options.deps })
    for (const source of validation.sources) ran.add(source)
    findings.push(...validation.findings)

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

    deepPages = context?.deck.pages.filter((page) => page.route === 'ppt-master') ?? []
    findings.push(...deepQualityFindings(dir, options.deps, deepPages.length > 0, ran, skipped))
  }
  let compatLevel: string | null = null
  let auditedPackage: OpcPackage | null = null
  if (artifact === null) {
    findings.push({
      level: 'error',
      source: 'pptx',
      rule: 'artifact-missing',
      message:
        options.file === undefined
          ? `no published package under ${join(dir, 'out')}; run \`dsh-ppt render\` first or pass --file`
          : `${options.file} is not a readable package${profile === null ? ' inside the deck' : ''}`,
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
      auditedPackage = pkg
      ran.add('pptx')
      for (const finding of auditPackage(pkg, { requireSingleMaster: true })) {
        findings.push({ level: finding.level, source: 'pptx', rule: finding.rule, message: finding.message })
      }
      if (!packageOnly && context !== null && context.deck.chrome !== undefined) {
        ran.add('chrome')
        const pages = chromePagesFrom(context.deck.pages, (index) => irRoleAt(context.ir, index))
        findings.push(...auditChrome(pkg, { chrome: context.deck.chrome, pages }))
      }
      if (profile !== null) {
        ran.add('design')
        const workspaceRoles =
          context === null
            ? undefined
            : designRoleMap(dir, options.deps) ?? new Map(chromePagesFrom(context.deck.pages, (index) => irRoleAt(context.ir, index)).map((page) => [page.index, designRoleFor(page.role)] as const))
        const roles = roleOverrides ?? workspaceRoles
        findings.push(...auditDesignPackage(pkg, { profile, ...(roles === undefined ? {} : { roles }) }))
        const provenance = designProvenance(dir, options.deps)
        findings.push(...(await auditDesignBackgrounds(pkg, { profile, ...(roles === undefined ? {} : { roles }), ...provenance })))
      }
      if (packageOnly) {
        skipped.push('compat-lint, pptx-delivery-check: package-only profile audit')
      } else {
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
  }

  if (options.pixels && !packageOnly && context !== null && context.tokens !== null && deepPages.length > 0) {
    ran.add('palette')
    const pages = deepPages.map((page) => ({
      page: page.index,
      path: relative(dir, join(dir, page.deep.dir, 'page.svg')),
      svg: fs.readText(join(dir, page.deep.dir, 'page.svg')) ?? '',
    }))
    findings.push(...(await collectPixelFindings(context.tokens, pages)))
  } else if (options.pixels) {
    skipped.push(packageOnly ? 'pixels: package-only profile audit' : 'pixels: no deep page with an in-sync tokens file to sample')
  }

  if (options.rendered === true) {
    if (auditedPackage === null || packageOnly) {
      skipped.push('render: no package to compare the snapshots against')
      if (options.requireRendered === true) {
        findings.push({ level: 'error', source: 'render', rule: 'render-snapshot-missing', message: '--require-rendered was set but no package is available to compare against' })
      }
    } else {
      const slides = renderGeometry(auditedPackage, context)
      const summary = await auditRenderedPages({
        renderRoot: join(dir, '.dsh-ppt', 'render'),
        renderRelative: '.dsh-ppt/render',
        slideCount: slides.length,
        slides,
        chrome: renderChromeDeclaration(context),
        fs,
      })
      findings.push(...summary.findings, ...overlapFindings(slides), ...offPageFindings(slides))
      if (summary.engines.length === 0) {
        skipped.push(summary.skipped ?? 'render: no snapshots to inspect')
        if (options.requireRendered === true) {
          findings.push({ level: 'error', source: 'render', rule: 'render-snapshot-missing', message: 'no render snapshots exist; run `dsh-ppt renderpages` first' })
        }
      } else {
        ran.add('render')
      }
    }
  }

  if (packageOnly) {
    skipped.push('prompt-audit: package-only profile audit')
  } else {
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

/** @param root - workspace root. @param path - candidate path. @returns true when the candidate stays inside the root. */
function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * @param dir - base directory for a relative profile path.
 * @param file - profile path as given on the command line.
 * @param fs - filesystem port.
 * @returns the parsed design profile.
 * @throws DshPptFailure `OutputMissing` when the file is absent, `ContractViolation`
 *   for an invalid document.
 */
function readDesignProfile(dir: string, file: string, fs: CommandDependencies['fs']): DesignProfile {
  const path = isAbsolute(file) ? resolve(file) : resolve(dir, file)
  const text = fs.readText(path)
  if (text === null) throw new DshPptFailure('OutputMissing', `the design profile is absent: ${path}`, { detail: { profile: path } })
  return parseDesignProfile(JSON.parse(text) as unknown)
}

/**
 * @param spec - `role=1,2;role=3` or a JSON object mapping slide index to role.
 * @returns the 1-based role overrides.
 * @throws DshPptFailure `ContractViolation` for an unknown role or index.
 */
function parseDesignRoles(spec: string): Map<number, DesignRole> {
  const roles = new Map<number, DesignRole>()
  const known = (value: string): value is DesignRole => (DESIGN_ROLES as readonly string[]).includes(value)
  const text = spec.trim()
  if (text === '') return roles
  const set = (index: number, role: DesignRole): void => {
    if (!Number.isInteger(index) || index < 1) throw new DshPptFailure('ContractViolation', `--roles has a non-positive slide index: ${String(index)}`, { detail: { roles: spec } })
    roles.set(index, role)
  }
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text) as Record<string, unknown>
    for (const [index, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || !known(value)) throw new DshPptFailure('ContractViolation', `--roles has an unknown role: ${String(value)}`, { detail: { roles: spec } })
      set(Number(index), value)
    }
    return roles
  }
  for (const chunk of text.split(';')) {
    const separator = chunk.indexOf('=')
    const role = separator === -1 ? chunk : chunk.slice(0, separator)
    const indices = separator === -1 ? '' : chunk.slice(separator + 1)
    if (!known(role) || indices === '') {
      throw new DshPptFailure('ContractViolation', `--roles chunk "${chunk}" must be role=1,2;role=3 with a known role`, { detail: { roles: spec } })
    }
    for (const index of indices.split(',')) set(Number(index.trim()), role)
  }
  return roles
}

/**
 * @param dir - deck workspace.
 * @param deps - command dependencies.
 * @returns the office/user media ids a picture-mode background may reference. A record
 *   that cannot be read is left absent: `assets` owns its diagnostics, and the
 *   background rule then reports that the mode cannot be verified.
 */
function designProvenance(dir: string, deps: CommandDependencies): { officeIds?: ReadonlySet<string>; userIds?: ReadonlySet<string> } {
  const provenance: { officeIds?: Set<string>; userIds?: Set<string> } = {}
  const recordText = deps.fs.readText(officeRecordPath(deps))
  if (recordText !== null) {
    try {
      provenance.officeIds = new Set(parseOfficeAssetRecord(JSON.parse(recordText) as unknown).assets.map((asset) => asset.id))
    } catch {
      // An invalid record is reported by `assets`; here it only removes the ids.
    }
  }
  const manifestText = deps.fs.readText(join(dir, 'assets', USER_ASSET_MANIFEST))
  if (manifestText !== null) {
    try {
      provenance.userIds = new Set(parseUserAssetManifest(JSON.parse(manifestText) as unknown).assets.map((asset) => asset.id))
    } catch {
      // An invalid manifest is reported by `assets`; here it only removes the ids.
    }
  }
  return provenance
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
/**
 * Build the slide geometry the render rules scale their samples against: every
 * top-level shape with text, its EMU box and the storyboard role.
 *
 * @param pkg - the published package.
 * @param context - the loaded deck, when it is available.
 * @returns one entry per slide, in deck order.
 */
function renderGeometry(pkg: OpcPackage, context: ReturnType<typeof loadDeck> | null): RenderSlideGeometry[] {
  const size = slideSize(pkg)
  const canvas = { width: size.cx, height: size.cy }
  const roleByIndex = new Map<number, string>()
  if (context !== null) {
    for (const page of chromePagesFrom(context.deck.pages, (index) => irRoleAt(context.ir, index))) roleByIndex.set(page.index, page.role)
  }
  return listSlides(pkg).map((part, offset) => {
    const index = offset + 1
    const boxes = topLevelShapes(pkg.text(part)).flatMap((shape) => {
      const geometry = shapeGeometry(shape)
      const runs = shapeRuns(shape)
      const text = runs
        .map((run) => run.text)
        .join(' ')
        .trim()
      if (geometry === null || text === '') return []
      const sizePt = runs.reduce((largest, run) => Math.max(largest, run.sizePt), 0)
      // The theme's section watermark is decorative text that intentionally sits
      // over other boxes, so the tofu/overflow/overlap rules skip it.
      const watermark = sizePt >= 60 && runs.every((run) => simpleLuminance(run.color) > 0.85)
      return [{ x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h, text, sizePt, watermark }]
    })
    const role = roleByIndex.get(index)
    return { index, canvas, boxes, ...(role === undefined ? {} : { role }) }
  })
}

/**
 * @param context - the loaded deck, when it is available.
 * @returns the chrome declaration the render rules check, or null when the deck has none.
 */
function renderChromeDeclaration(context: ReturnType<typeof loadDeck> | null): RenderChromeDeclaration | null {
  const chrome = context?.deck.chrome
  if (chrome === undefined) return null
  return {
    pageNumber: chrome.pageNumber?.show !== false,
    metaFooter: chrome.footer !== undefined,
    sectionMarker: chrome.section !== undefined,
  }
}
