import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { loadDeck } from '../deck.ts'
import { validateDeck } from './validate.ts'
import { engineFor, frontendFor, resolveDeckDir, type CommandDependencies } from './context.ts'
import { createDeepRenderer, type DeepPage } from '../engine/deep-render.ts'
import { OpcPackage, auditPackage } from '../bridge/opc.ts'
import { mergeDeep, type MergeReport, type SlideRoute } from '../bridge/merge.ts'
import { formatFindings, type FusionFinding } from '../audit.ts'
import { toJsonDocument } from '../bridge/theme.ts'
import type { PostflightReceipt } from '../engine/deep-render.ts'

/** Parameters for `dsh-ppt render`. */
export interface RenderOptions {
  /** Deck directory as given on the command line. */
  readonly dir: string
  /** Output pptx; resolved against the deck. Defaults to `<deck>/out/<name>.pptx`. */
  readonly output?: string
  readonly deps: CommandDependencies
}

/** Everything one render produced, for the receipt and `out/manifest.json`. */
export interface RenderResult {
  readonly outputFile: string
  readonly sha256: string
  readonly bytes: number
  readonly slides: number
  /** The exporter receipts, one per engine that contributed pages. */
  readonly postflight: { deep?: PostflightReceipt }
  readonly merge: MergeReport
  /** Absolute paths of the intermediate artifacts, all under `<deck>/.dsh-ppt/render/`. */
  readonly staged: readonly string[]
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
 * IR), deep render, slide-level merge with layout remap, then the hard gates before
 * anything reaches `out/`. Every intermediate artifact is staged under
 * `<deck>/.dsh-ppt/render/`, so a failure leaves the workspace diagnosable and
 * `out/` untouched (plan §3.12).
 *
 * @param options - deck directory, optional output path, command dependencies.
 * @returns the published file and the evidence the gates produced.
 * @throws DshPptFailure when the deck is invalid, a gate fails, or the deck asks
 *   for a stage this build does not implement yet.
 */
export async function renderDeck(options: RenderOptions): Promise<RenderResult> {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const context = loadDeck(dir, fs)

  const report = validateDeck({ dir, deps: options.deps })
  const errors = report.findings.filter((finding) => finding.level === 'error')
  if (errors.length > 0) {
    throw new DshPptFailure('ContractViolation', `deck workspace is not valid: ${errors.map((finding) => finding.message).join('; ')}`, {
      detail: { findings: errors },
    })
  }
  if (context.tokens === null) {
    throw new DshPptFailure('OutputMissing', 'tokens.json is absent or stale; run `dsh-ppt theme ensure` before rendering', { detail: { dir } })
  }
  if (context.deck.post?.animations !== undefined && context.deck.post.animations !== null) {
    // The post stage is the remaining half of M4: it must refuse to publish a deck
    // whose manifest asks for animation rather than ignoring the request.
    throw new DshPptFailure('ContractViolation', 'post.animations is configured but the post stage is not implemented yet (M4 remaining work)', {
      detail: { animations: context.deck.post.animations },
    })
  }

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
  const base = await OpcPackage.read(readBytes(fs, basePath))

  if (deepIndices.length === 0) {
    // A pptwise-only deck skips the merge entirely; the file still passes the same
    // OPC and delivery gates.
    const findings = auditPackage(base, { requireSingleMaster: true })
    assertNoErrors(findings)
    const outputFile = publishPath(dir, options.output, context.deck.name)
    const bytes = await base.write()
    return publish({ fs, dir, outputFile, bytes, slides: countSlides(base), merge: emptyMergeReport(), postflight: {}, staged, deps: options.deps })
  }

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
  const { merged, report: mergeReport } = await mergeDeep({ base, deep, routes })
  const mergedPath = join(stagedRoot, 'merged.pptx')
  fs.writeBytes(mergedPath, await merged.write())
  staged.push(mergedPath)

  // 4. Hard gates: OPC structure and the single-master invariant, then the
  //    engine's own delivery check.
  const opcFindings = auditPackage(merged, { requireSingleMaster: true })
  assertNoErrors(opcFindings)
  const delivery = engineFor(dir, options.deps).deliveryCheck({ file: mergedPath })

  // 5. Publish atomically, then record what was published.
  const outputFile = publishPath(dir, options.output, context.deck.name)
  const bytes = await merged.write()
  return publish({
    fs,
    dir,
    outputFile,
    bytes,
    slides: countSlides(merged),
    merge: mergeReport,
    postflight: { deep: deepResult.postflight },
    staged,
    deps: options.deps,
    delivery: { stdout: delivery.result.stdout, status: delivery.result.status },
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
  return { replaced: [], imported: {}, reused: {}, layoutRemap: {}, multiMaster: false, dropped: [] }
}

/** Publish the artifact and write `out/manifest.json`. */
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
}): RenderResult {
  const { fs, dir, outputFile, bytes } = input
  fs.mkdirp(join(dir, 'out'))
  const temporary = `${outputFile}.tmp`
  fs.writeBytes(temporary, bytes)
  fs.rename(temporary, outputFile)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
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
      ...(input.delivery === undefined ? {} : { delivery: { status: input.delivery.status, receipt: input.delivery.stdout.trim().split(/\r?\n/).slice(-3) } }),
    }),
  )
  return {
    outputFile,
    sha256,
    bytes: bytes.length,
    slides: input.slides,
    postflight: input.postflight,
    merge: input.merge,
    staged: input.staged,
  }
}
