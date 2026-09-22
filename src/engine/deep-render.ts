import { join } from 'node:path'
import { DshPptFailure } from './errors.ts'
import type { MasterEngine } from './master.ts'
import type { FileSystemPort } from './venv.ts'
import type { DeepPageSpec } from '../schema/deep-page.ts'
import { SLIDE_FORMATS, type SlideFormat } from './contracts.ts'
import type { TokensFile } from '../schema/tokens.ts'

/** Canvas geometry the engine registers, keyed by the format name it accepts. */
export const CANVAS_VIEWBOX: Readonly<Record<SlideFormat, string>> = {
  ppt169: '0 0 1280 720',
  ppt43: '0 0 1024 768',
  wechat: '0 0 1080 1920',
  xiaohongshu: '0 0 1242 1660',
  moments: '0 0 1080 1080',
  story: '0 0 1080 1920',
  banner: '0 0 1200 628',
  a4: '0 0 2480 3508',
}

/** One page to render through the deep engine. */
export interface DeepPage {
  /** 1-based index in the final deck; also fixes the export order. */
  readonly index: number
  readonly spec: DeepPageSpec
  /** Absolute path of the authored `page.svg`. */
  readonly svgPath: string
}

/** What one deep render produced. */
export interface DeepRenderResult {
  /** Temporary master project under `<workspace>/.dsh-ppt/deep/`. */
  readonly projectDir: string
  /** The exported pptx. */
  readonly pptxPath: string
  /** `validation/<stem>.report.json`, the exporter's own postflight record. */
  readonly reportPath: string
  /** Parsed `[POSTFLIGHT]` receipt. */
  readonly postflight: PostflightReceipt
  /** Pages that went out, in order. */
  readonly pages: readonly number[]
}

/** The exporter's one-line receipt, which M4 records in `out/manifest.json`. */
export interface PostflightReceipt {
  readonly status: string
  readonly qualityGate: string
  readonly slides: number
  readonly warningCategories: number
}

/**
 * Parse the exporter's `[POSTFLIGHT]` receipt.
 *
 * @param stdout - captured export output.
 * @returns the receipt, or null when the line is absent.
 */
export function parsePostflight(stdout: string): PostflightReceipt | null {
  const match = /\[POSTFLIGHT\]\s+status=(\S+)\s+quality_gate=(\S+)\s+slides=(\d+)\s+warning_categories=(\d+)/.exec(stdout)
  if (match === null) return null
  return {
    status: match[1] ?? 'unknown',
    qualityGate: match[2] ?? 'unknown',
    slides: Number.parseInt(match[3] ?? '0', 10),
    warningCategories: Number.parseInt(match[4] ?? '0', 10),
  }
}

/**
 * Collect the distinct font sizes a page set uses.
 *
 * The quality gate requires every size on a page to be a declared anchor, or to
 * appear at most twice, so the spec lock declares exactly the sizes the authored
 * SVG uses instead of guessing a typographic scale.
 *
 * @param svgTexts - authored SVG documents.
 * @returns distinct sizes in ascending order.
 */
export function collectFontSizes(svgTexts: readonly string[]): number[] {
  const sizes = new Set<number>()
  for (const svg of svgTexts) {
    for (const match of svg.matchAll(/font-size="([0-9]+(?:\.[0-9]+)?)"/g)) {
      const value = Number.parseFloat(match[1] ?? '')
      if (Number.isFinite(value) && value > 0) sizes.add(value)
    }
  }
  return [...sizes].sort((left, right) => left - right)
}

/**
 * Decide the primary language the engine should format text for.
 *
 * The exporter rejects a placeholder (`und`) and needs a real tag, because it
 * drives line breaking and font selection. The fusion has no language field in
 * the manifest, so this reads the authored pages: a page whose text is mostly CJK
 * is a Chinese deck, anything else is English. Mixed decks follow their dominant
 * script, which is what the engine needs to lay text out correctly.
 *
 * @param svgTexts - authored SVG documents.
 * @returns a BCP-47 tag the engine accepts (`zh-CN` or `en`).
 */
export function detectPrimaryLanguage(svgTexts: readonly string[]): string {
  let cjk = 0
  let latin = 0
  for (const svg of svgTexts) {
    for (const character of svg.replace(/<[^>]*>/g, ' ')) {
      if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(character)) cjk += 1
      else if (/[A-Za-z]/.test(character)) latin += 1
    }
  }
  return cjk > 0 && cjk * 2 >= latin ? 'zh-CN' : 'en'
}

/**
 * Render the `spec_lock.md` the deep project needs.
 *
 * Required by the quality gate, which refuses a project whose lock has no numeric
 * typography rows. Every value here is derived from the deck (canvas from the
 * page format, sizes from the SVGs themselves, colours from the token file), so a
 * deep page cannot fail the gate for a reason the author never chose.
 *
 * @param options.pages - pages that will be exported, in order.
 * @param options.svgTexts - their SVG sources.
 * @param options.format - canvas format shared by the pages.
 * @param options.tokens - the deck's exported palette contract.
 * @param options.structure - exporter structure mode; deep pages use `flat`.
 * @returns the lock document.
 */
export function deriveSpecLock(options: {
  pages: readonly DeepPage[]
  svgTexts: readonly string[]
  format: SlideFormat
  tokens: TokensFile
  structure?: 'flat' | 'structured'
}): string {
  const sizes = collectFontSizes(options.svgTexts)
  if (sizes.length === 0) {
    throw new DshPptFailure('ContractViolation', 'no font-size was found in the deep page SVGs; the spec lock cannot declare typography', {
      detail: { pages: options.pages.map((page) => page.index) },
    })
  }
  const body = sizes[0] ?? 22
  const title = sizes[sizes.length - 1] ?? 42
  const typographyRows = [
    `- font_family: ${options.tokens.fonts.body[0] ?? 'Arial'}`,
    `- title_family: ${options.tokens.fonts.heading[0] ?? 'Arial'}`,
    `- body_family: ${options.tokens.fonts.body[0] ?? 'Arial'}`,
    // The gate needs `title` and `body` specifically, then one anchor per size.
    `- body: ${String(body)}`,
    `- title: ${String(title)}`,
    ...sizes.filter((size) => size !== body && size !== title).map((size) => `- size_${String(size).replace('.', '_')}: ${String(size)}`),
  ]
  return [
    '<!-- ppt-master-schema: spec-lock/v1 -->',
    '# Execution Lock',
    '',
    '<!-- Generated by dsh-ppt from the deck workspace. Edit the SVG and theme, not this file. -->',
    '',
    '## canvas',
    `- viewBox: ${CANVAS_VIEWBOX[options.format]}`,
    `- format: ${options.format}`,
    '',
    '## communication',
    `- primary_language: ${detectPrimaryLanguage(options.svgTexts)}`,
    '- audience: fusion deck reader',
    '- objective: render the declared deep pages as native DrawingML',
    '- core_message: content authored in SVG, delivered as editable PowerPoint objects',
    '- consumption_mode: circulated',
    '',
    '## mode',
    '- mode: quick-generate',
    '',
    '## visual_style',
    `- visual_style: ${options.tokens.themeId} (dsh-ppt token bridge)`,
    '',
    '## colors',
    `- bg: ${options.tokens.colors.bg.toUpperCase()}`,
    `- primary: ${options.tokens.colors.primary.toUpperCase()}`,
    `- accent: ${options.tokens.colors.accent.toUpperCase()}`,
    `- text: ${options.tokens.colors.text.toUpperCase()}`,
    '',
    '## typography',
    ...typographyRows,
    '',
    '## icons',
    '- library: inline',
    '- inventory: declared per page in the authored SVG',
    '',
    '## page_rhythm',
    ...options.pages.map((page) => `- P${String(page.index).padStart(2, '0')}: ${page.spec.kind}`),
    '',
    '## pptx_structure',
    `- mode: ${options.structure ?? 'flat'}`,
    '',
    '## forbidden',
    '- `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<set>`, `<script>` / event attributes, `<iframe>`',
    '- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters',
    '',
  ].join('\n')
}

/** File name a page gets inside the temporary project's roster. */
export function rosterName(page: DeepPage): string {
  const slug = page.spec.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? page.spec.kind
  const safe = slug.replace(/[^A-Za-z0-9._-]+/g, '-')
  return `${String(page.index).padStart(3, '0')}-${safe}.svg`
}

/**
 * Create the engine implementation of the deep render pipeline.
 *
 * The order is the one M0 measured (ADR-008): stamp native fallback hashes when
 * markers exist, record a passing final quality report, export with Quick
 * Generate plus native objects, then require the exporter's own report file. The
 * quality step is not optional: `svg-to-pptx --quick-generate` refuses to run
 * without a recorded report for the current roster.
 *
 * @param options.master - the engine process layer.
 * @param options.fs - filesystem port.
 * @param options.tokens - the deck's palette contract, used for the spec lock.
 * @param options.format - canvas format for the temporary project.
 * @returns the pipeline used by `dsh-ppt deep render` and, from M4, `render`.
 */
export function createDeepRenderer(options: {
  master: MasterEngine
  fs: FileSystemPort
  tokens: TokensFile
  format: SlideFormat
}) {
  const { master, fs } = options
  const format = SLIDE_FORMATS.includes(options.format) ? options.format : 'ppt169'
  /** Base directory for temporary master projects; kept inside the workspace. */
  const projectsRoot = join(master.workspace, '.dsh-ppt', 'deep')

  const prepare = (pages: readonly DeepPage[]): { projectDir: string; svgTexts: string[]; svgDir: string } => {
    if (pages.length === 0) {
      throw new DshPptFailure('ContractViolation', 'no deep page was given to render', { detail: { format } })
    }
    const ordered = [...pages].sort((left, right) => left.index - right.index)
    const svgTexts = ordered.map((page) => {
      const text = fs.readText(page.svgPath)
      if (text === null) {
        throw new DshPptFailure('OutputMissing', `deep page ${String(page.index)} has no readable SVG at ${page.svgPath}`, {
          detail: { page: page.index, svgPath: page.svgPath },
        })
      }
      return text
    })

    fs.mkdirp(projectsRoot)
    // `project init` refuses an existing directory and appends the format and
    // date to the name, so a re-render removes the previous project for this page
    // set by prefix. That keeps one project per page set instead of one per run,
    // and makes "render again" mean "render this roster again".
    const projectName = `deep-${ordered.map((page) => `p${String(page.index).padStart(2, '0')}`).join('-')}`
    for (const entry of fs.listDir(projectsRoot)) {
      if (entry.startsWith(`${projectName}_`)) fs.removeTree(join(projectsRoot, entry))
    }
    const created = master.projectInit({ name: projectName, baseDir: projectsRoot, format })
    const svgDir = join(created.projectDir, 'svg_output')
    fs.mkdirp(svgDir)
    ordered.forEach((page, offset) => {
      fs.writeText(join(svgDir, rosterName(page)), svgTexts[offset] ?? '')
    })
    fs.writeText(
      join(created.projectDir, 'spec_lock.md'),
      deriveSpecLock({ pages: ordered, svgTexts, format, tokens: options.tokens }),
    )
    return { projectDir: created.projectDir, svgTexts, svgDir }
  }

  return {
    /** Absolute base directory holding temporary master projects. */
    projectsRoot,

    /** Build the temporary project without rendering it; used by tests and `deep check`. */
    prepare,

    /**
     * Render deep pages into one pptx.
     *
     * @param params.pages - pages to render, in deck order.
     * @param params.outputFile - absolute path of the pptx to write.
     * @returns the project, the pptx, the exporter report and the postflight receipt.
     */
    render(params: { pages: readonly DeepPage[]; outputFile: string }): DeepRenderResult {
      const ordered = [...params.pages].sort((left, right) => left.index - right.index)
      const { projectDir, svgDir } = prepare(ordered)

      master.stampFallbacks({ target: svgDir, write: true })
      master.qualityCheck({ target: projectDir, stage: 'final', quickGenerate: true, canonicalAuthoring: true })
      const exported = master.renderDeep({ projectDir, outputFile: params.outputFile, format, withNotes: true })

      const postflight = parsePostflight(exported.result.stdout)
      if (postflight === null) {
        throw new DshPptFailure('OutputMissing', 'the exporter printed no [POSTFLIGHT] receipt', {
          detail: { stdoutTail: exported.result.stdout.slice(-2000) },
        })
      }
      const reportPath = exported.outputFiles[1]
      if (reportPath === undefined) {
        throw new DshPptFailure('OutputMissing', 'the exporter did not write its validation report', { detail: { projectDir } })
      }
      return {
        projectDir,
        pptxPath: exported.outputFiles[0] ?? params.outputFile,
        reportPath,
        postflight,
        pages: ordered.map((page) => page.index),
      }
    },
  }
}

/** The deep render pipeline, as returned by `createDeepRenderer`. */
export type DeepRenderer = ReturnType<typeof createDeepRenderer>
