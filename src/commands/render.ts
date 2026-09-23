import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { irRoleAt, loadDeck } from '../deck.ts'
import { validateDeck } from './validate.ts'
import { engineFor, frontendFor, resolveDeckDir, type CommandDependencies } from './context.ts'
import { createDeepRenderer, type DeepPage } from '../engine/deep-render.ts'
import { OpcPackage, auditPackage } from '../bridge/opc.ts'
import { mergeDeep, type MergeReport, type SlideRoute } from '../bridge/merge.ts'
import { applyPost, ensureShowTimings, readPostConfig, type PostReport } from '../bridge/post.ts'
import { applyChrome, chromePagesFrom, type ChromeOptions, type ChromeReport } from '../bridge/chrome.ts'
import { applyCompatPass, compatReportHash, serializeCompatReport, type CompatReport } from '../bridge/compat.ts'
import type { CompatLevel } from '../compat/registry.ts'
import { formatFindings, type FusionFinding } from '../audit.ts'
import { toJsonDocument } from '../bridge/theme.ts'
import type { PostflightReceipt } from '../engine/deep-render.ts'

/** Parameters for `dsh-ppt render`. */
export interface RenderOptions {
  /** Deck directory as given on the command line. */
  readonly dir: string
  /** Output pptx; resolved against the deck. Defaults to `<deck>/out/<name>.pptx`. */
  readonly output?: string
  /** `--compat` level; overrides the manifest's field, which overrides `standard`. */
  readonly compat?: CompatLevel
  /**
   * Require the deck's `deck.storyboard.json` (the default). `false` drops the
   * storyboard findings and exists for debugging only (plan §4.1).
   */
  readonly storyboard?: boolean
  readonly deps: CommandDependencies
}

/** Everything one render produced, for the receipt and `out/manifest.json`. */
export interface RenderResult {
  readonly outputFile: string
  readonly sha256: string
  readonly bytes: number
  readonly slides: number
  /** True when the render set `p:showPr useTimings="1"` for narration auto-advance. */
  readonly showTimings: boolean
  /** The exporter receipts, one per engine that contributed pages. */
  readonly postflight: { deep?: PostflightReceipt }
  readonly merge: MergeReport
  /** What the post pass applied, when the manifest declared motion. */
  readonly post?: PostReport
  /** What the chrome pass applied, when the manifest declared a chrome contract. */
  readonly chrome?: ChromeReport
  /** The compat pass result, the file it was serialised to, and that file's hash. */
  readonly compat: { readonly report: CompatReport; readonly reportFile: string; readonly reportSha256: string }
  /** Absolute paths of the intermediate artifacts, all under `<deck>/.dsh-ppt/render/`. */
  readonly staged: readonly string[]
}

/** Where the compat level came from, so the manifest can record it. */
export interface CompatChoice {
  readonly level: CompatLevel
  readonly source: 'flag' | 'manifest' | 'default'
}

/**
 * @param flag - `--compat` value, when given.
 * @param manifest - the manifest's `compat` field, when given.
 * @returns the level and where it came from.
 */
export function resolveCompatLevel(flag: CompatLevel | undefined, manifest: CompatLevel | undefined): CompatChoice {
  if (flag !== undefined) return { level: flag, source: 'flag' }
  if (manifest !== undefined) return { level: manifest, source: 'manifest' }
  return { level: 'standard', source: 'default' }
}

/** 1-based page positions of the deep pages, in deck order. */
export function deepPageIndices(pages: readonly { index: number; route: string }[]): number[] {
  return pages.filter((page) => page.route === 'ppt-master').map((page) => page.index)
}

/**
 * Render a whole deck: standard pages through pptwise, deep pages through
 * ppt-master, then merge and publish.
 *
 * Order is plan §2.3: `pptwise render --draft` (deep pages are placeholders in the
 * IR), deep render, slide-level merge with layout remap, the post pass (the single
 * owner of motion), the compat pass, then the hard gates before anything reaches
 * `out/`. Every intermediate artifact is staged under `<deck>/.dsh-ppt/render/`, so a
 * failure leaves the workspace diagnosable and `out/` untouched (plan §3.12).
 *
 * @param options - deck directory, optional output path and compat level, dependencies.
 * @returns the published file and the evidence the gates produced.
 * @throws DshPptFailure when the deck is invalid or a gate fails.
 */
export async function renderDeck(options: RenderOptions): Promise<RenderResult> {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const context = loadDeck(dir, fs)

  const validation = validateDeck({ dir, deps: options.deps })
  // The storyboard is mandatory from v0.2 on; `--no-storyboard` (debug only) drops
  // those findings instead of pretending the plan exists.
  const errors = validation.findings.filter(
    (finding) => finding.level === 'error' && (options.storyboard !== false || finding.source !== 'storyboard'),
  )
  if (errors.length > 0) {
    throw new DshPptFailure('ContractViolation', `deck workspace is not valid: ${errors.map((finding) => finding.message).join('; ')}`, {
      detail: { findings: errors },
    })
  }
  if (context.tokens === null) {
    throw new DshPptFailure('OutputMissing', 'tokens.json is absent or stale; run `dsh-ppt theme ensure` before rendering', { detail: { dir } })
  }
  // The post configuration is read up front so a malformed one fails before any
  // engine runs; it is applied after the merge, which is the single application
  // point for a deck's motion (plan 3.6, ADR-032).
  const postConfig =
    context.deck.post?.animations === undefined || context.deck.post.animations === null
      ? null
      : readPostConfig(fs, join(dir, context.deck.post.animations))
  const compat = resolveCompatLevel(options.compat, context.deck.compat)

  const stagedRoot = join(dir, '.dsh-ppt', 'render')
  fs.mkdirp(stagedRoot)
  const staged: string[] = []

  // 1. Base deck: standard pages rendered, deep pages left as placeholders.
  const frontend = frontendFor(dir, options.deps)
  const basePath = join(stagedRoot, 'base.pptx')
  frontend.render(context.deck.pptwiseIr, { output: stagedRelative('base.pptx'), draft: true })
  if (!fs.exists(basePath)) {
    throw new DshPptFailure('OutputMissing', `pptwise reported success but did not write ${basePath}`, { detail: { basePath } })
  }
  staged.push(basePath)

  const deepIndices = deepPageIndices(context.deck.pages)
  let pkg = await OpcPackage.read(readBytes(fs, basePath))
  let merge = emptyMergeReport()
  let postflight: { deep?: PostflightReceipt } = {}

  if (deepIndices.length > 0) {
    // 2. Deep pages through the engine.
    const deepPages: DeepPage[] = []
    for (const page of context.deck.pages) {
      if (page.route !== 'ppt-master') continue
      deepPages.push({ index: page.index, spec: page.deep, svgPath: join(dir, page.deep.dir, 'page.svg') })
    }
    const formats = new Set(deepPages.map((page) => page.spec.format))
    if (formats.size > 1) {
      throw new DshPptFailure('ContractViolation', `deep pages in one render must share a canvas format; found ${[...formats].join(', ')}`)
    }
    const deepRenderer = createDeepRenderer({
      master: engineFor(dir, options.deps),
      fs,
      tokens: context.tokens,
      format: [...formats][0] ?? 'ppt169',
    })
    const deepPath = join(stagedRoot, 'deep.pptx')
    const deepResult = deepRenderer.render({ pages: deepPages, outputFile: deepPath })
    staged.push(deepResult.pptxPath, deepResult.reportPath, deepResult.projectDir)

    // 3. Slide-level merge with layout remap (P1: one master).
    const deep = await OpcPackage.read(readBytes(fs, deepResult.pptxPath))
    const routes: SlideRoute[] = deepPages.map((page, offset) => ({ index: page.index, deepSlide: offset + 1 }))
    const merged = await mergeDeep({ base: pkg, deep, routes })
    pkg = merged.merged
    merge = merged.report
    postflight = { deep: deepResult.postflight }
  }

  // The chrome contract, like motion, is applied after the merge: the engines
  // render content, this layer owns deck-level chrome (plan V6 WP1, ADR-058).
  const chrome: ChromeOptions | null =
    context.deck.chrome === undefined
      ? null
      : {
          chrome: context.deck.chrome,
          tokens: context.tokens,
          pages: chromePagesFrom(context.deck.pages, (index) => irRoleAt(context.ir, index)),
        }

  return finalize({ pkg, dir, stagedRoot, staged, postConfig, chrome, compat, output: options.output, name: context.deck.name, merge, postflight, runDelivery: deepIndices.length > 0, deps: options.deps })
}

/** Publish path, staged artifacts and the shared gate tail. */
async function finalize(input: {
  pkg: OpcPackage
  dir: string
  stagedRoot: string
  staged: readonly string[]
  postConfig: ReturnType<typeof readPostConfig> | null
  chrome: ChromeOptions | null
  compat: CompatChoice
  output: string | undefined
  name: string
  merge: MergeReport
  postflight: { deep?: PostflightReceipt }
  runDelivery: boolean
  deps: CommandDependencies
}): Promise<RenderResult> {
  const fs = input.deps.fs
  const { dir, pkg } = input

  // 4. Motion: the single post-merge application point (plan 3.6, ADR-032).
  const postApplied = input.postConfig === null ? null : applyPost(pkg, input.postConfig)
  // Recorded narration needs the package-level show-timings flag; the merge rebuilds
  // `presProps.xml` from the base deck, which drops it (V6 Q5, ADR-060).
  const showTimings = ensureShowTimings(pkg)
  if (postApplied !== null && postApplied.unmatched.length > 0) {
    throw new DshPptFailure(
      'ContractViolation',
      `post/animations.json selected shapes that do not exist on slide ${postApplied.unmatched.join(', ')}; check the target names against the authored pages`,
      { detail: { unmatched: postApplied.unmatched } },
    )
  }

  // 5. Chrome: the deck-level contract — page numbers (native field), footer and
  //    section — written after motion and before the compat scan, so the scan sees
  //    the shapes the deck actually ships (plan V6 WP1, ADR-058).
  const chromeApplied = input.chrome === null ? null : applyChrome(pkg, input.chrome)

  // 6. Compatibility pass: registered downgrades and fallback stamps, after motion
  //    (a downgrade must see the transitions it judges) and before the gates.
  const compatReport = await applyCompatPass(pkg, { level: input.compat.level })
  const compatErrors = compatReport.findings.filter((finding) => finding.level === 'error')
  if (compatErrors.length > 0) {
    throw new DshPptFailure(
      'ContractViolation',
      `compat pass (${input.compat.level}, from ${input.compat.source}) rejected ${String(compatErrors.length)} marker(s): ${compatErrors.map((finding) => finding.message).join('; ')}`,
      { detail: { findings: compatErrors, level: input.compat.level, source: input.compat.source } },
    )
  }

  const mergedPath = join(input.stagedRoot, 'merged.pptx')
  fs.writeBytes(mergedPath, await pkg.write())
  const staged = [...input.staged, mergedPath]

  // 7. Hard gates: OPC structure and the single-master invariant, then the engine's
  //    own delivery check when a deep page participated.
  const opcFindings = auditPackage(pkg, { requireSingleMaster: true })
  assertNoErrors(opcFindings)
  const delivery = input.runDelivery ? engineFor(dir, input.deps).deliveryCheck({ file: mergedPath }) : null

  // 8. Publish atomically, then record what was published.
  const outputFile = publishPath(dir, input.output, input.name)
  const bytes = await pkg.write()
  return publish({
    fs,
    dir,
    outputFile,
    bytes,
    slides: countSlides(pkg),
    merge: input.merge,
    postflight: input.postflight,
    staged,
    deps: input.deps,
    compat: { report: compatReport, source: input.compat.source },
    showTimings,
    ...(delivery === null ? {} : { delivery: { stdout: delivery.result.stdout, status: delivery.result.status } }),
    ...(postApplied === null ? {} : { post: postApplied }),
      ...(chromeApplied === null ? {} : { chrome: chromeApplied }),
  })
}

/** @returns the absolute publish path for a render. */
function publishPath(dir: string, requested: string | undefined, name: string): string {
  return requested === undefined ? join(dir, 'out', `${name}.pptx`) : resolve(dir, requested)
}

/** @returns the staged path relative to the deck, which is what the front end receives. */
function stagedRelative(file: string): string {
  return `.dsh-ppt/render/${file}`
}

/** Read an artifact as bytes; the text reader would corrupt a package. */
function readBytes(fs: CommandDependencies['fs'], path: string): Buffer {
  const bytes = fs.readBytes(path)
  if (bytes === null) throw new DshPptFailure('OutputMissing', `staged artifact is not readable: ${path}`, { detail: { path } })
  return bytes
}

/** Slide count via `p:sldIdLst`, which is the order the merge preserves. */
function countSlides(pkg: OpcPackage): number {
  return [...pkg.text('ppt/presentation.xml').matchAll(/<p:sldId\b/g)].length
}

/** @throws DshPptFailure when the package audit found errors. */
function assertNoErrors(findings: ReturnType<typeof auditPackage>): void {
  const errors = findings.filter((finding) => finding.level === 'error')
  if (errors.length === 0) return
  const asFusion: FusionFinding[] = errors.map((finding) => ({
    level: 'error',
    source: 'pptx',
    rule: finding.rule,
    message: finding.message,
  }))
  throw new DshPptFailure('EngineExit', `package failed its structural gates:\n${formatFindings(asFusion)}`, {
    detail: { findings: asFusion },
  })
}

/** @returns an empty merge report for decks with no deep page. */
function emptyMergeReport(): MergeReport {
  return { replaced: [], imported: {}, reused: {}, layoutRemap: {}, multiMaster: false, dropped: [], renumberedCreationIds: 0 }
}

/** Publish the artifact and write `out/manifest.json` plus `out/compat-report.json`. */
function publish(input: {
  fs: CommandDependencies['fs']
  dir: string
  outputFile: string
  bytes: Buffer
  slides: number
  merge: MergeReport
  postflight: { deep?: PostflightReceipt }
  staged: readonly string[]
  deps: CommandDependencies
  delivery?: { stdout: string; status: number | null }
  post?: PostReport
  /** Whether narration auto-advance needed the package show-timings flag. */
  showTimings: boolean
  compat: { report: CompatReport; source: CompatChoice['source'] }
}): RenderResult {
  const { fs, dir, outputFile, bytes } = input
  fs.mkdirp(join(dir, 'out'))
  const temporary = `${outputFile}.tmp`
  fs.writeBytes(temporary, bytes)
  fs.rename(temporary, outputFile)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const reportFile = join(dir, 'out', 'compat-report.json')
  fs.writeText(reportFile, serializeCompatReport(input.compat.report))
  const reportSha256 = compatReportHash(input.compat.report)
  fs.writeText(
    join(dir, 'out', 'manifest.json'),
    toJsonDocument({
      name: outputFile.replace(/^.*[\\/]/, '').replace(/\.pptx$/, ''),
      file: outputFile.replace(dir, '').replace(/^[\\/]/, '').replace(/\\/g, '/'),
      sha256,
      bytes: bytes.length,
      slides: input.slides,
      postflight: input.postflight,
      merge: input.merge,
      staged: input.staged.map((path) => path.replace(dir, '').replace(/^[\\/]/, '').replace(/\\/g, '/')),
      compat: {
        level: input.compat.report.level,
        levelSource: input.compat.source,
        registryVersion: input.compat.report.registryVersion,
        report: { file: 'compat-report.json', sha256: reportSha256 },
        counts: input.compat.report.counts,
        applied: input.compat.report.applied,
      },
      // True when narration auto-advance required `p:showPr useTimings="1"` (V6 Q5).
      showTimings: input.showTimings,
      ...(input.delivery === undefined ? {} : { delivery: { status: input.delivery.status, receipt: input.delivery.stdout.trim().split(/\r?\n/).slice(-3) } }),
      ...(input.post === undefined ? {} : { post: input.post }),
    }),
  )
  return {
    outputFile,
    sha256,
    bytes: bytes.length,
    slides: input.slides,
    showTimings: input.showTimings,
    postflight: input.postflight,
    merge: input.merge,
    compat: { report: input.compat.report, reportFile, reportSha256 },
    staged: input.staged,
  }
}
