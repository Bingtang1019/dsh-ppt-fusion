// DeepSeek Harness (DSH) plugin: the `dsh_ppt_review` tool.
//
// The render gate (`dsh-ppt audit --rendered`) judges page images with pixels; it
// cannot judge composition, information density or narrative. This tool closes
// that gap the way the V10 plan's Part B asks: it renders the deck through the
// same cached `renderpages` snapshots, then hands the page images to the model as
// attachment blocks so the model can look at its own output and answer with
// findings.
//
// Three rules shape the code:
//
//  - The tool never fakes sight. Image input is a deployment fact: without the
//    `attachments` service, an image-capable route, and images within the
//    deployment's limits, `execute` fails with `image-input-unavailable` and says
//    so, instead of returning an inspection the model cannot actually perform.
//  - Rendering stays in the CLI. This module shells out to `renderpages` and reads
//    the pages.json index; it draws nothing and caches nothing of its own.
//  - Findings are recorded, not invented. `mode: 'record'` validates the model's
//    findings and writes `.dsh-ppt/review/review.json` under the deck, the same
//    file `dsh-ppt review` tooling reads.
//
// Plain dependency-free JS by design (node builtins only): no build step, no dsh
// type imports, resilient to rc surface drift.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runChild } from './spawnHidden.js'

/** Tool name the harness registers. */
export const REVIEW_TOOL_NAME = 'dsh_ppt_review'

/** Deck-relative directory the review record lives in. */
export const REVIEW_DIR = join('.dsh-ppt', 'review')

/** Deck-relative review record path. */
export const REVIEW_FILE = join(REVIEW_DIR, 'review.json')

/** Schema version of the review record. */
export const REVIEW_SCHEMA_VERSION = 1

/** Page images one inspection may attach unless the caller narrows it further. */
export const REVIEW_MAX_PAGES = 12

/** Severity vocabulary a finding may use. */
const SEVERITIES = ['error', 'warning', 'info']

/**
 * The rubric the model applies to every attached page. Kept here rather than only
 * in the skill so the tool call itself carries the checklist it is answerable to.
 */
export const REVIEW_RUBRIC = [
  'Off-page / clipped: content that leaves the canvas or sits under a shape that hides it.',
  'Overflow / overlap: text or charts that run past their box, or two elements sharing space they should not.',
  'Contrast: body text below 4.5:1 against its own background (3:1 is allowed from 18 pt up).',
  'Density and hierarchy: one message per page, a readable title, no wall of text.',
  'Narrative: the page sequence tells the story the brief asked for; charts carry labelled axes and units.',
  'Consistency: type scale, palette and margins match the deck profile on every page.',
].join('\n')

/** @param {string} path - candidate path. @returns true when it is absolute. */
function isAbsolutePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/** @param {string} value - raw value. @returns the value with forward slashes. */
function slashes(value) {
  return value.replace(/\\/g, '/')
}

/**
 * @param {string} cliPath - absolute path of the packaged CLI.
 * @param {() => string} resolveNode - returns the Node executable to run the CLI with.
 * @returns a runner that resolves with the CLI's stdout and rejects with its stderr.
 */
function createCliRunner(cliPath, resolveNode) {
  return (args, signal) =>
    runChild(resolveNode(), [cliPath, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal }).then(({ code, stdout, stderr }) => {
      if (code === 0) return { stdout, stderr }
      throw new Error(stderr.trim() || stdout.trim() || `dsh-ppt exited with code ${code}`)
    })
}

/** @param value - unknown value. @returns the value when it is a plain object. */
function objectOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

/**
 * @param findings - the model's findings.
 * @param pageCount - pages the inspection attached.
 * @returns the normalized findings.
 * @throws Error when a finding is unusable, so a bad record cannot be written.
 */
function normalizeFindings(findings, pageCount) {
  if (!Array.isArray(findings) || findings.length === 0) return []
  const normalized = []
  for (const [offset, entry] of findings.entries()) {
    const record = objectOf(entry)
    if (record === null) throw new Error(`findings[${offset}] must be an object`)
    const page = Number(record.page)
    if (!Number.isInteger(page) || page < 1 || (pageCount > 0 && page > pageCount)) throw new Error(`findings[${offset}].page must be a page number between 1 and ${pageCount || 'the attached pages'}`)
    const severity = String(record.severity ?? '')
    if (!SEVERITIES.includes(severity)) throw new Error(`findings[${offset}].severity must be one of ${SEVERITIES.join(', ')}`)
    const rule = String(record.rule ?? '').trim()
    const message = String(record.message ?? '').trim()
    if (rule === '' || message === '') throw new Error(`findings[${offset}] needs a non-empty rule and message`)
    const fix = record.fix === undefined ? undefined : String(record.fix).trim()
    normalized.push({ page, severity, rule, message, ...(fix === undefined || fix === '' ? {} : { fix }) })
  }
  return normalized
}

/**
 * Build the review service for one plugin instance.
 *
 * @param cliPath - absolute path of the packaged CLI (`dsh-ppt`).
 * @param options - optional overrides for tests.
 * @param options.ctx - the plugin scope carrying the `attachments` and `llm` services.
 * @param options.resolveNode - returns the Node executable used for the CLI child.
 * @returns the `dsh_ppt_review` tool plus its pure helpers.
 */
export function createReviewService(cliPath, options = {}) {
  const resolveNode = options.resolveNode ?? (() => process.env.npm_node_execpath || process.execPath)
  const scope = options.ctx ?? {}
  const runCli = createCliRunner(cliPath, resolveNode)

  /**
   * Establish that this deployment can actually show images to the model.
   *
   * @param exec - the tool execution context (carries the calling agent).
   * @returns the attachment service every image is saved through.
   * @throws Error naming `image-input-unavailable` for every unmet precondition.
   */
  async function assertImageInput(exec) {
    const attachments = typeof scope.get === 'function' ? scope.get('attachments') : undefined
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      throw new Error('image-input-unavailable: no attachment service is mounted in this deployment, so the model cannot see page images; run `dsh-ppt audit --rendered` and report that the visual review was skipped')
    }
    const llm = typeof scope.get === 'function' ? scope.get('llm') : undefined
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
      throw new Error('image-input-unavailable: the model route cannot be inspected, so image support is unknown; switch to an image-capable route or report that the visual review was skipped')
    }
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (provider === undefined || model === undefined) {
      throw new Error('image-input-unavailable: the current model route could not be resolved; report that the visual review was skipped')
    }
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) {
      throw new Error(`image-input-unavailable: model "${model}" does not declare image input; switch to an image-capable model or report that the visual review was skipped`)
    }
    return attachments
  }

  /** @param deckDir - absolute deck directory. @returns the parsed pages.json index. */
  async function readIndex(deckDir) {
    const path = join(deckDir, '.dsh-ppt', 'render', 'pages.json')
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw new Error(`no render snapshots under ${slashes(path)}; run \`dsh-ppt renderpages ${slashes(deckDir)}\` first`)
    }
    const index = JSON.parse(text)
    if (!Array.isArray(index.engines) || typeof index.sourceSha256 !== 'string') throw new Error(`the render index at ${slashes(path)} is not usable`)
    return index
  }

  const tool = {
    name: REVIEW_TOOL_NAME,
    description:
      'Show this deck\'s rendered pages to yourself (image attachments) so you can review composition, density and narrative, then record the findings. ' +
      'Renders through the cached `renderpages` snapshots. Requires an image-capable model and the attachment service; without them it fails with image-input-unavailable instead of pretending to look. ' +
      'Call it without `findings` to inspect, then again with `findings` to write review.json.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Deck project directory (the same target the CLI takes).' },
        engine: { type: 'string', enum: ['powerpoint', 'libreoffice', 'both'], description: 'Renderer to review; defaults to the first engine with cached pages.' },
        pages: { type: 'array', items: { type: 'number' }, description: `1-based pages to attach (default all, at most ${REVIEW_MAX_PAGES}).` },
        findings: {
          type: 'array',
          description: 'Review findings to record. Omit to inspect.',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number' },
              severity: { type: 'string', enum: SEVERITIES },
              rule: { type: 'string' },
              message: { type: 'string' },
              fix: { type: 'string' },
            },
            required: ['page', 'severity', 'rule', 'message'],
            additionalProperties: false,
          },
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          deck: { type: 'string' },
          sourceSha256: { type: 'string' },
          engine: { type: 'string' },
          pageCount: { type: 'number' },
          pages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          reviewFile: { type: 'string' },
          findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          counts: { type: 'object', additionalProperties: true },
        },
        required: ['mode', 'deck', 'reviewFile'],
        additionalProperties: true,
      },
      render(_args, value) {
        if (value.mode === 'record') {
          const counts = value.counts ?? {}
          return [{ type: 'text', text: `recorded ${String(counts.error ?? 0)} error / ${String(counts.warning ?? 0)} warning / ${String(counts.info ?? 0)} info finding(s) in ${value.reviewFile}` }]
        }
        const header = `deck ${value.deck} (${value.engine}, source ${String(value.sourceSha256).slice(0, 12)}…), ${String(value.pageCount)} page(s) attached`
        const lines = (value.pages ?? []).map((page) => `  page ${String(page.index)}: ${page.path}`)
        const text = [
          header,
          ...lines,
          '',
          'Review every attached page against this rubric:',
          REVIEW_RUBRIC,
          '',
          `Record what you find by calling ${REVIEW_TOOL_NAME} again with the same target plus \`findings\` (page, severity error|warning|info, rule, message, optional fix); that writes ${value.reviewFile}.`,
          'Fix what the findings name, re-render, and inspect again — at most two rounds; report anything still open to the user instead of approving it yourself.',
        ].join('\n')
        return [{ type: 'text', text }, ...(value.images ?? []).map((image) => ({ type: 'image', attachment: image }))]
      },
    },
    timeoutMs: 900_000,
    async execute(args, exec) {
      const target = String(args.target ?? '').trim()
      if (target === '') throw new Error('target must be a non-empty deck directory')
      const deckDir = resolve(target)
      const findings = args.findings === undefined ? null : normalizeFindings(args.findings, 0)
      if (findings !== null) {
        const index = await readIndex(deckDir)
        const pageCount = Number(index.engines?.[0]?.pages?.length ?? 0)
        const normalized = normalizeFindings(args.findings, pageCount)
        const record = {
          schemaVersion: REVIEW_SCHEMA_VERSION,
          deck: slashes(deckDir),
          source: index.source ?? null,
          sourceSha256: index.sourceSha256,
          engine: String(args.engine ?? index.engines?.[0]?.engine ?? ''),
          reviewedAt: new Date().toISOString(),
          findings: normalized,
          counts: { error: normalized.filter((f) => f.severity === 'error').length, warning: normalized.filter((f) => f.severity === 'warning').length, info: normalized.filter((f) => f.severity === 'info').length },
        }
        const reviewFile = join(deckDir, REVIEW_FILE)
        await mkdir(dirname(reviewFile), { recursive: true })
        await writeFile(reviewFile, `${JSON.stringify(record, null, 2)}\n`)
        return { mode: 'record', deck: slashes(deckDir), reviewFile: slashes(reviewFile), findings: normalized, counts: record.counts }
      }
      const attachments = await assertImageInput(exec)
      // The CLI run is the render step: it reuses cached snapshots unless the source
      // changed, so a review round costs one process even when nothing moved.
      const engineFlag = args.engine === undefined ? 'both' : String(args.engine)
      await runCli(['renderpages', deckDir, '--engine', engineFlag], exec?.signal)
      const index = await readIndex(deckDir)
      const wanted = String(args.engine ?? '')
      const engine = index.engines.find((entry) => entry.status !== 'skipped' && (wanted === '' || entry.engine === wanted)) ?? index.engines[0]
      if (engine === undefined || engine.status === 'skipped') throw new Error(`no engine rendered ${slashes(deckDir)}; run \`dsh-ppt renderpages\` on a host with PowerPoint or the LibreOffice Kit`)
      const manifest = JSON.parse(await readFile(join(deckDir, '.dsh-ppt', 'render', engine.engine, 'manifest.json'), 'utf8'))
      const requested = Array.isArray(args.pages) ? args.pages.map(Number).filter((page) => Number.isInteger(page) && page >= 1) : []
      const all = manifest.pages.filter((page) => requested.length === 0 || requested.includes(page.index))
      const chosen = all.slice(0, REVIEW_MAX_PAGES)
      if (chosen.length === 0) throw new Error(`the render of ${slashes(deckDir)} holds no page matching ${JSON.stringify(requested)}`)
      const images = []
      const pages = []
      for (const page of chosen) {
        const file = join(deckDir, '.dsh-ppt', 'render', engine.engine, page.file)
        const data = await readFile(file)
        const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: `${basename(deckDir)}-${engine.engine}-${page.file}` })
        images.push({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name === undefined ? {} : { name: ref.name }) })
        pages.push({ index: page.index, path: slashes(file), width: page.width, height: page.height })
      }
      return {
        mode: 'inspect',
        deck: slashes(deckDir),
        sourceSha256: index.sourceSha256,
        engine: engine.engine,
        pageCount: pages.length,
        pages,
        images,
        reviewFile: slashes(join(deckDir, REVIEW_FILE)),
        ...(all.length > chosen.length ? { truncatedFrom: all.length } : {}),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Review ${String(args.target)}`, kind: 'read', locations: [{ path: String(args.target) }] }
    },
  }

  return { tool, REVIEW_RUBRIC, normalizeFindings }
}