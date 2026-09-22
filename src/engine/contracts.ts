import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DshPptFailure } from './errors.ts'

/**
 * Slide canvases the engine registers. Measured from `svg-to-pptx --help`.
 */
export const SLIDE_FORMATS = ['ppt169', 'ppt43', 'wechat', 'xiaohongshu', 'moments', 'story', 'banner', 'a4'] as const
export type SlideFormat = (typeof SLIDE_FORMATS)[number]

/** Deck structure modes the exporter accepts. `flat` is what deep pages need. */
export const PPTX_STRUCTURES = ['structured', 'flat', 'baseline', 'template', 'preserve', 'generated'] as const
export type PptxStructure = (typeof PPTX_STRUCTURES)[number]

/** Quality-gate stages. `page` additionally requires a page selector. */
export const QUALITY_STAGES = ['early', 'first-page', 'page', 'final'] as const
export type QualityStage = (typeof QUALITY_STAGES)[number]

/**
 * Wall-clock budget per command class. Export and quality runs are dominated by
 * `skia-pathops` shaping over the whole roster, so they get tens of minutes;
 * nothing here waits on the network.
 */
export const ENGINE_TIMEOUTS = {
  projectInit: 120_000,
  svgToPptx: 900_000,
  qualityCheck: 600_000,
  deliveryCheck: 300_000,
  stampFallbacks: 300_000,
} as const

/** One fully validated engine invocation: argv to run, budget, files it must produce. */
export interface EngineInvocation {
  /** Registry id, used in logs and error detail. */
  readonly id: string
  /** argv handed to the engine executable, without the executable itself. */
  readonly argv: readonly string[]
  /** Wall-clock budget for this invocation. */
  readonly timeoutMs: number
  /** Workspace-relative files that must exist and be non-empty after a zero exit. */
  readonly outputFiles: readonly string[]
}

/** Parameters for `ppt-master project init`. */
export interface ProjectInitParams {
  /** Project directory name; a slug, never a path. */
  readonly name: string
  /** Directory that will contain the created project; must be inside the workspace. */
  readonly baseDir: string
  readonly format: SlideFormat
}

/** Parameters for `ppt-master svg-to-pptx`. */
export interface SvgToPptxParams {
  /** Project directory, workspace-relative. */
  readonly projectDir: string
  /** Output pptx path, workspace-relative. */
  readonly outputFile: string
  readonly format?: SlideFormat
  readonly structure?: PptxStructure
  /** Quick Generate roster: infer the canvas and skip `spec_lock.md`. */
  readonly quickGenerate?: boolean
  /** Replace `data-pptx-replace-with` markers with native Chart/Table objects. */
  readonly nativeObjects?: boolean
  readonly withNotes?: boolean
  readonly sourceDir?: string
  /** Directory of per-slide narration audio to embed (`--recorded-narration`). */
  readonly recordedNarration?: string
  /** Let the embedded audio drive slide auto-advance timings. */
  readonly useNarrationTimings?: boolean
}

/** Parameters for `ppt-master svg-quality-check`. */
export interface QualityCheckParams {
  /** Project directory, or a directory of SVGs, workspace-relative. */
  readonly target: string
  readonly stage?: QualityStage
  readonly page?: string
  readonly quickGenerate?: boolean
  readonly canonicalAuthoring?: boolean
  readonly roundtrip?: boolean
}

/** Parameters for `ppt-master pptx-delivery-check`. */
export interface DeliveryCheckParams {
  /** pptx to inspect, workspace-relative. */
  readonly file: string
}

/** Parameters for `ppt-master stamp-native-fallbacks`. */
export interface StampFallbacksParams {
  /** SVG file or directory, workspace-relative. */
  readonly target: string
  /** Persist the computed hashes; omit for a read-only preview. */
  readonly write?: boolean
}

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * @param label - argument name used in the failure message.
 * @param value - candidate value.
 * @param allowed - the closed set of accepted values.
 * @returns the value, narrowed.
 * @throws DshPptFailure `ContractViolation` when the value is outside the set.
 */
export function assertEnum<T extends string>(label: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new DshPptFailure('ContractViolation', `${label} must be one of ${allowed.join(', ')}; received ${JSON.stringify(value)}`, {
    detail: { label, value, allowed },
  })
}

/**
 * Resolve a path argument and prove it stays inside the workspace.
 *
 * The engine is allowed to write anywhere inside the deck workspace and nowhere
 * else, so every path handed to it passes through here.
 *
 * @param workspace - absolute workspace root.
 * @param target - absolute or workspace-relative path.
 * @param label - argument name used in the failure message.
 * @returns the absolute path.
 * @throws DshPptFailure `PathOutsideWorkspace` when the path escapes the root.
 */
export function assertInsideWorkspace(workspace: string, target: string, label: string): string {
  const root = resolve(workspace)
  const candidate = isAbsolute(target) ? resolve(target) : resolve(root, target)
  const rel = relative(root, candidate)
  if (rel === '') return candidate
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DshPptFailure('PathOutsideWorkspace', `${label} points outside the deck workspace: ${candidate}`, {
      detail: { label, workspace: root, target: candidate },
    })
  }
  return candidate
}

/**
 * @param workspace - absolute workspace root.
 * @param target - path to convert.
 * @returns the path relative to the workspace with forward slashes, which is the
 *   form the Python engine expects on every platform.
 */
export function toWorkspaceRelative(workspace: string, target: string): string {
  return relative(resolve(workspace), assertInsideWorkspace(workspace, target, 'path')).split(sep).join('/')
}

/**
 * Build the argv for `ppt-master project init`.
 *
 * @param params - project name, base directory, canvas format.
 * @returns the validated invocation; the created project directory is derived
 *   from stdout, because `project init` appends the format and date itself.
 */
export function projectInit(params: ProjectInitParams): EngineInvocation {
  if (!PROJECT_NAME_PATTERN.test(params.name)) {
    throw new DshPptFailure('ContractViolation', `project name must match ${PROJECT_NAME_PATTERN}; received ${JSON.stringify(params.name)}`, {
      detail: { name: params.name },
    })
  }
  const format = assertEnum('format', params.format, SLIDE_FORMATS)
  return {
    id: 'project-init',
    argv: ['project', 'init', params.name, '--format', format, '--dir', params.baseDir],
    timeoutMs: ENGINE_TIMEOUTS.projectInit,
    outputFiles: [],
  }
}

/**
 * Build the argv for `ppt-master svg-to-pptx`.
 *
 * The deep-page contract measured in M0 requires Quick Generate plus native
 * objects, so those default to true; a caller that wants neither passes false
 * explicitly.
 *
 * @param params - project, output, canvas, structure and post-processing flags.
 * @returns the validated invocation including the files the export must produce.
 */
export function svgToPptx(params: SvgToPptxParams): EngineInvocation {
  const argv = ['svg-to-pptx', params.projectDir, '-o', params.outputFile]
  if (params.format !== undefined) argv.push('-f', assertEnum('format', params.format, SLIDE_FORMATS))
  if (params.structure !== undefined) argv.push('--pptx-structure', assertEnum('structure', params.structure, PPTX_STRUCTURES))
  if (params.sourceDir !== undefined) argv.push('-s', params.sourceDir)
  if (params.quickGenerate !== false) argv.push('--quick-generate')
  if (params.nativeObjects !== false) argv.push('--native-charts-and-tables')
  if (params.withNotes !== false) argv.push('--with-notes')
  if (params.recordedNarration !== undefined) argv.push('--recorded-narration', params.recordedNarration)
  if (params.useNarrationTimings === true) argv.push('--use-narration-timings')
  const stem = params.outputFile.replace(/^.*\//, '').replace(/\.pptx$/i, '')
  const projectRoot = params.projectDir.replace(/[\\/]+$/, '')
  return {
    id: 'svg-to-pptx',
    argv,
    timeoutMs: ENGINE_TIMEOUTS.svgToPptx,
    // The exporter writes its own report inside the project it exported, named
    // after the output stem (measured in M0).
    outputFiles: [params.outputFile, `${projectRoot}/validation/${stem}.report.json`],
  }
}

/**
 * Build the argv for `ppt-master svg-quality-check`.
 *
 * `--stage page` requires `--page`, which the CLI enforces too; this reports it
 * as a contract violation before a process is started.
 *
 * @param params - target, stage, page selector and gate flags.
 * @returns the validated invocation including the recorded report file.
 */
export function qualityCheck(params: QualityCheckParams): EngineInvocation {
  const argv = ['svg-quality-check', params.target]
  const stage = params.stage === undefined ? undefined : assertEnum('stage', params.stage, QUALITY_STAGES)
  if (stage !== undefined) argv.push('--stage', stage)
  if (stage === 'page' && (params.page === undefined || params.page === '')) {
    throw new DshPptFailure('ContractViolation', '--stage page requires --page <basename>', { detail: { stage } })
  }
  if (params.page !== undefined) argv.push('--page', params.page)
  if (params.quickGenerate === true) argv.push('--quick-generate')
  if (params.canonicalAuthoring === true) argv.push('--canonical-authoring')
  if (params.roundtrip === true) argv.push('--roundtrip')
  argv.push('--json')
  const targetRoot = params.target.replace(/[\\/]+$/, '')
  return {
    id: 'svg-quality-check',
    argv,
    timeoutMs: ENGINE_TIMEOUTS.qualityCheck,
    // The recorded report lives inside the checked project, not in the deck root.
    outputFiles: [`${targetRoot}/validation/svg_quality_report.json`],
  }
}

/**
 * Build the argv for `ppt-master pptx-delivery-check`.
 *
 * @param params - the pptx to inspect.
 * @returns the validated invocation; the command reports through stdout only.
 */
export function deliveryCheck(params: DeliveryCheckParams): EngineInvocation {
  return {
    id: 'pptx-delivery-check',
    argv: ['pptx-delivery-check', params.file],
    timeoutMs: ENGINE_TIMEOUTS.deliveryCheck,
    outputFiles: [],
  }
}

/**
 * Build the argv for `ppt-master stamp-native-fallbacks`.
 *
 * @param params - SVG file or directory holding native-object markers.
 * @returns the validated invocation; the command edits the SVGs in place.
 */
export function stampFallbacks(params: StampFallbacksParams): EngineInvocation {
  const argv = ['stamp-native-fallbacks', params.target]
  if (params.write === true) argv.push('--write')
  return {
    id: 'stamp-native-fallbacks',
    argv,
    timeoutMs: ENGINE_TIMEOUTS.stampFallbacks,
    outputFiles: [],
  }
}

/**
 * Registry ids the engine layer will run. Anything absent is unreachable by
 * design: the v1 non-goals (`image-gen`, the `video-*` commands, the Gemini
 * watermark helper) are not here, so no code path can invoke them.
 */
export const REGISTERED_ENGINE_COMMANDS: readonly string[] = [
  'project-init',
  'svg-to-pptx',
  'svg-quality-check',
  'pptx-delivery-check',
  'stamp-native-fallbacks',
  'notes-to-audio',
  'narration-sync',
  'image-search',
  'pdf-to-md',
  'doc-to-md',
  'excel-to-md',
  'ppt-to-md',
  'web-to-md',
  'mirror-template-materialize',
  'pptx-template-import',
  'apply-template',
  'register-template',
  'source-to-md',
  'pptx-to-svg',
]

/**
 * Parse the project directory out of `project init` output.
 *
 * @param stdout - captured stdout of `ppt-master project init`.
 * @returns the created directory as printed by the engine, or null when the
 *   line is absent (the caller then reports OutputMissing).
 */
export function parseCreatedProjectDir(stdout: string): string | null {
  const match = /Project created:\s*(.+)/.exec(stdout)
  return match?.[1]?.trim() ?? null
}

/** Narration providers the engine registers; `edge` needs no key. */
export const NARRATION_PROVIDERS = ['edge', 'elevenlabs', 'minimax', 'qwen', 'cosyvoice'] as const
export type NarrationProvider = (typeof NARRATION_PROVIDERS)[number]

/** `narration-sync` modes. Each takes a project path; `subtitles` also needs a pptx. */
export const NARRATION_SYNC_MODES = ['fingerprint', 'animations', 'subtitles'] as const
export type NarrationSyncMode = (typeof NARRATION_SYNC_MODES)[number]

/** Openly licensed image sources. Only the first two work without a key. */
export const IMAGE_PROVIDERS = ['openverse', 'wikimedia', 'pexels', 'pixabay'] as const
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number]

/** Image orientation filter. */
export const IMAGE_ORIENTATIONS = ['any', 'landscape', 'portrait', 'square'] as const
export type ImageOrientation = (typeof IMAGE_ORIENTATIONS)[number]

/** How `pdf-to-md` treats embedded images. */
export const PDF_IMAGE_MODES = ['all', 'filtered', 'none'] as const
export type PdfImageMode = (typeof PDF_IMAGE_MODES)[number]

/** Source-to-markdown converters, all registered under the engine dispatch. */
export const SOURCE_CONVERTERS = ['pdf-to-md', 'doc-to-md', 'excel-to-md', 'ppt-to-md', 'web-to-md'] as const
export type SourceConverter = (typeof SOURCE_CONVERTERS)[number]

/** Template materialisation kinds. */
export const TEMPLATE_KINDS = ['deck', 'layout'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

/** Layout inheritance modes `pptx-to-svg` accepts. */
export const INHERITANCE_MODES = ['both', 'layered', 'flat'] as const
export type InheritanceMode = (typeof INHERITANCE_MODES)[number]

/** Template kinds the registry indexes; `mirror-template-materialize` writes two of them. */
export const TEMPLATE_REGISTRY_KINDS = ['brand', 'style', 'layout', 'deck'] as const
export type TemplateRegistryKind = (typeof TEMPLATE_REGISTRY_KINDS)[number]

/** Timeouts for the post-processing and material commands. */
export const POST_TIMEOUTS = {
  narration: 1_800_000,
  images: 300_000,
  source: 300_000,
  template: 600_000,
  roundtrip: 600_000,
} as const

/** Parameters for `ppt-master notes-to-audio`. */
export interface NotesToAudioParams {
  /** Project directory the notes live in, workspace-relative. */
  readonly projectDir: string
  readonly provider?: NarrationProvider
  /** Provider voice name; edge uses ShortNames such as `zh-CN-YunxiNeural`. */
  readonly voice?: string
  /** edge-tts speaking rate, for example `+10%`. */
  readonly rate?: string
  readonly volume?: string
  /** Audio output directory, workspace-relative. */
  readonly output?: string
  /** Print the curated edge-tts voice list and exit; needs no network. */
  readonly listCommonVoices?: boolean
}

/**
 * Build the argv for `ppt-master notes-to-audio`.
 *
 * @param params - project, provider and voice selection.
 * @returns the validated invocation.
 */
export function notesToAudio(params: NotesToAudioParams): EngineInvocation {
  const argv = ['notes-to-audio', params.projectDir]
  if (params.provider !== undefined) argv.push('--provider', assertEnum('provider', params.provider, NARRATION_PROVIDERS))
  if (params.voice !== undefined) argv.push('--voice', params.voice)
  if (params.rate !== undefined) argv.push('--rate', params.rate)
  if (params.volume !== undefined) argv.push('--volume', params.volume)
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.listCommonVoices === true) argv.push('--list-common-voices')
  return { id: 'notes-to-audio', argv, timeoutMs: POST_TIMEOUTS.narration, outputFiles: [] }
}

/** Parameters for `ppt-master narration-sync`. */
export interface NarrationSyncParams {
  readonly mode: NarrationSyncMode
  /** Project directory, workspace-relative; positional for every mode. */
  readonly projectDir: string
  /** Required by `subtitles`: the narrated pptx. */
  readonly pptx?: string
  readonly subtitleDir?: string
  readonly audioDir?: string
  readonly animationConfig?: string
  readonly plan?: string
  /** Output path for `animations` and `subtitles`. */
  readonly output?: string
  readonly force?: boolean
}

/**
 * Build the argv for `ppt-master narration-sync`.
 *
 * @param params - mode plus the paths that mode needs.
 * @returns the validated invocation.
 * @throws DshPptFailure `ContractViolation` when `subtitles` is asked for without a pptx.
 */
export function narrationSync(params: NarrationSyncParams): EngineInvocation {
  const mode = assertEnum('mode', params.mode, NARRATION_SYNC_MODES)
  const argv = ['narration-sync', mode]
  if (mode === 'subtitles') {
    if (params.pptx === undefined) {
      throw new DshPptFailure('ContractViolation', 'narration-sync subtitles requires --pptx', { detail: { mode } })
    }
    argv.push('--pptx', params.pptx)
  }
  if (params.subtitleDir !== undefined) argv.push('--subtitle-dir', params.subtitleDir)
  if (params.audioDir !== undefined) argv.push('--audio-dir', params.audioDir)
  if (params.animationConfig !== undefined) argv.push('--animation-config', params.animationConfig)
  if (params.plan !== undefined) argv.push('--plan', params.plan)
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.force === true) argv.push('--force')
  argv.push(params.projectDir)
  return { id: 'narration-sync', argv, timeoutMs: POST_TIMEOUTS.narration, outputFiles: params.output === undefined ? [] : [params.output] }
}

/** Parameters for `ppt-master image-search`. */
export interface ImageSearchParams {
  /** Search terms; passed as a single argument, never a path. */
  readonly query: string
  readonly provider?: ImageProvider
  readonly orientation?: ImageOrientation
  readonly filename?: string
  /** Refuse results that require attribution (CC BY / CC BY-SA). */
  readonly strictNoAttribution?: boolean
  readonly minWidth?: number
  readonly minHeight?: number
  /** Directory the download lands in, workspace-relative. */
  readonly output?: string
  /** Attribution manifest the engine appends to, workspace-relative. */
  readonly manifest?: string
  /** Thumbnail-selection mode; no original is downloaded. */
  readonly saveCandidates?: boolean
  readonly maxCandidates?: number
  /** Download one directly selected URL and record it as `manual`. */
  readonly fromUrl?: string
  /** Free-text purpose and slide number recorded in the manifest. */
  readonly purpose?: string
  readonly slide?: number
}

/**
 * Build the argv for `ppt-master image-search`.
 *
 * The command downloads into the project it runs in, so the caller sets the
 * engine working directory to the deck workspace and records the attribution
 * file afterwards.
 *
 * @param params - query and filters.
 * @returns the validated invocation.
 */
export function imageSearch(params: ImageSearchParams): EngineInvocation {
  const argv = ['image-search', params.query]
  if (params.provider !== undefined) argv.push('--provider', assertEnum('provider', params.provider, IMAGE_PROVIDERS))
  if (params.orientation !== undefined) argv.push('--orientation', assertEnum('orientation', params.orientation, IMAGE_ORIENTATIONS))
  if (params.filename !== undefined) argv.push('--filename', params.filename)
  if (params.strictNoAttribution === true) argv.push('--strict-no-attribution')
  if (params.minWidth !== undefined) argv.push('--min-width', String(params.minWidth))
  if (params.minHeight !== undefined) argv.push('--min-height', String(params.minHeight))
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.manifest !== undefined) argv.push('--manifest', params.manifest)
  if (params.saveCandidates === true) argv.push('--save-candidates')
  if (params.maxCandidates !== undefined) argv.push('--max-candidates', String(params.maxCandidates))
  if (params.fromUrl !== undefined) argv.push('--from-url', params.fromUrl)
  if (params.purpose !== undefined) argv.push('--purpose', params.purpose)
  if (params.slide !== undefined) argv.push('--slide', String(params.slide))
  return { id: 'image-search', argv, timeoutMs: POST_TIMEOUTS.images, outputFiles: params.manifest === undefined ? [] : [params.manifest] }
}

/** Types the unified `source-to-md` dispatcher accepts via `-t`. */
export const SOURCE_DISPATCH_TYPES = ['auto', 'pdf', 'doc', 'excel', 'pptx', 'web', 'markdown', 'text'] as const
export type SourceDispatchType = (typeof SOURCE_DISPATCH_TYPES)[number]

/** Parameters for the unified `source-to-md` dispatcher. */
export interface SourceDispatchParams {
  /** One or more files, directories or http(s) URLs. */
  readonly inputs: readonly string[]
  readonly type?: SourceDispatchType
  readonly output?: string
  readonly images?: PdfImageMode
  readonly noImages?: boolean
}

/**
 * Build the argv for the unified `ppt-master source-to-md` dispatcher.
 *
 * The per-converter builders below stay for callers that know their backend; this one
 * lets a mixed list be converted in one process, which is what `dsh-ppt source` uses.
 *
 * @param params - inputs, forced type and output options.
 * @returns the validated invocation.
 * @throws DshPptFailure `ContractViolation` when no input is given.
 */
export function sourceToMarkdown(params: SourceDispatchParams): EngineInvocation {
  if (params.inputs.length === 0) {
    throw new DshPptFailure('ContractViolation', 'source-to-md needs at least one input', { detail: {} })
  }
  const argv = ['source-to-md', ...params.inputs]
  if (params.type !== undefined) argv.push('-t', assertEnum('type', params.type, SOURCE_DISPATCH_TYPES))
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.images !== undefined) argv.push('--images', assertEnum('images', params.images, PDF_IMAGE_MODES))
  if (params.noImages === true) argv.push('--no-images')
  return { id: 'source-to-md', argv, timeoutMs: POST_TIMEOUTS.source, outputFiles: params.output === undefined ? [] : [params.output] }
}

/** Parameters for the `source-to-md` family. */
export interface SourceToMdParams {
  readonly converter: SourceConverter
  /** Input files or one http(s) URL for `web-to-md`; workspace-relative. */
  readonly inputs: readonly string[]
  /** Output markdown path, workspace-relative. */
  readonly output?: string
  readonly images?: PdfImageMode
  readonly maxRows?: number
}

/**
 * Build the argv for a source-to-markdown converter.
 *
 * @param params - converter, inputs and options.
 * @returns the validated invocation.
 * @throws DshPptFailure `ContractViolation` when no input is given.
 */
export function sourceToMd(params: SourceToMdParams): EngineInvocation {
  const converter = assertEnum('converter', params.converter, SOURCE_CONVERTERS)
  if (params.inputs.length === 0) {
    throw new DshPptFailure('ContractViolation', `${converter} needs at least one input`, { detail: { converter } })
  }
  const argv = [converter, ...params.inputs]
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.images !== undefined) argv.push('--images', assertEnum('images', params.images, PDF_IMAGE_MODES))
  if (params.maxRows !== undefined) argv.push('--max-rows', String(params.maxRows))
  return { id: converter, argv, timeoutMs: POST_TIMEOUTS.source, outputFiles: params.output === undefined ? [] : [params.output] }
}

/** Parameters for `ppt-master mirror-template-materialize`. */
export interface MirrorTemplateParams {
  readonly importWorkspace: string
  readonly templateWorkspace: string
  readonly kind?: TemplateKind
}

/**
 * Build the argv for `ppt-master mirror-template-materialize`.
 *
 * @param params - the import workspace and the template workspace to write.
 * @returns the validated invocation.
 */
export function mirrorTemplateMaterialize(params: MirrorTemplateParams): EngineInvocation {
  const argv = ['mirror-template-materialize', params.importWorkspace, params.templateWorkspace]
  if (params.kind !== undefined) argv.push('--kind', assertEnum('kind', params.kind, TEMPLATE_KINDS))
  return { id: 'mirror-template-materialize', argv, timeoutMs: POST_TIMEOUTS.template, outputFiles: [] }
}

/** Parameters for `ppt-master pptx-to-svg` (the native roundtrip path). */
export interface PptxToSvgParams {
  readonly file: string
  readonly output?: string
  readonly inheritanceMode?: InheritanceMode
  readonly imagesSubdir?: string
  readonly keepHidden?: boolean
  /** Write the source-preserving round-trip workspace; requires `both`. */
  readonly roundtrip?: boolean
  /** Stop on the first unsupported construct instead of converting tolerantly. */
  readonly strict?: boolean
}

/**
 * Build the argv for `ppt-master pptx-to-svg`.
 *
 * @param params - the pptx to convert and where to write the SVGs.
 * @returns the validated invocation.
 */
export function pptxToSvg(params: PptxToSvgParams): EngineInvocation {
  const argv = ['pptx-to-svg', params.file]
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.inheritanceMode !== undefined) argv.push('--inheritance-mode', assertEnum('inheritanceMode', params.inheritanceMode, INHERITANCE_MODES))
  if (params.imagesSubdir !== undefined) argv.push('--images-subdir', params.imagesSubdir)
  if (params.keepHidden === true) argv.push('--keep-hidden')
  if (params.strict === true) argv.push('--strict')
  if (params.roundtrip === true) {
    // The engine's own help states the pairing; failing here names the missing flag
    // before a process is started.
    if (params.inheritanceMode !== 'both') {
      throw new DshPptFailure('ContractViolation', 'pptx-to-svg --roundtrip requires --inheritance-mode both', { detail: { inheritanceMode: params.inheritanceMode } })
    }
    argv.push('--roundtrip')
  }
  return { id: 'pptx-to-svg', argv, timeoutMs: POST_TIMEOUTS.roundtrip, outputFiles: [] }
}

/** Parameters for `ppt-master pptx-template-import`. */
export interface PptxTemplateImportParams {
  /** Source pptx, workspace-relative. */
  readonly file: string
  readonly output?: string
  readonly inheritanceMode?: InheritanceMode
  readonly embedImages?: boolean
  readonly skipManifest?: boolean
  readonly manifestOnly?: boolean
}

/**
 * Build the argv for `ppt-master pptx-template-import`.
 *
 * This is the reference workspace `mirror-template-materialize` publishes from; the
 * SVG round-trip output is consumed directly by `apply-template` instead (ADR-038).
 *
 * @param params - source pptx, output directory and import options.
 * @returns the validated invocation.
 */
export function pptxTemplateImport(params: PptxTemplateImportParams): EngineInvocation {
  const argv = ['pptx-template-import', params.file]
  if (params.output !== undefined) argv.push('-o', params.output)
  if (params.inheritanceMode !== undefined) argv.push('--inheritance-mode', assertEnum('inheritanceMode', params.inheritanceMode, INHERITANCE_MODES))
  if (params.embedImages === true) argv.push('--embed-images')
  if (params.skipManifest === true) argv.push('--skip-manifest')
  if (params.manifestOnly === true) argv.push('--manifest-only')
  return { id: 'pptx-template-import', argv, timeoutMs: POST_TIMEOUTS.template, outputFiles: [] }
}

/** Parameters for `ppt-master apply-template`. */
export interface ApplyTemplateParams {
  /** Initialized project root, workspace-relative. */
  readonly projectDir: string
  /** Template workspace roots to install; one root per kind, repeatable. */
  readonly roots: readonly string[]
  readonly dryRun?: boolean
  readonly skipValidation?: boolean
}

/**
 * Build the argv for `ppt-master apply-template`.
 *
 * @param params - project plus the template root(s) to install.
 * @returns the validated invocation.
 * @throws DshPptFailure `ContractViolation` when no root is given.
 */
export function applyTemplate(params: ApplyTemplateParams): EngineInvocation {
  if (params.roots.length === 0) {
    throw new DshPptFailure('ContractViolation', 'apply-template needs at least one --root', { detail: { projectDir: params.projectDir } })
  }
  const argv = ['apply-template', params.projectDir]
  for (const root of params.roots) argv.push('--root', root)
  if (params.dryRun === true) argv.push('--dry-run')
  if (params.skipValidation === true) argv.push('--skip-validation')
  return { id: 'apply-template', argv, timeoutMs: POST_TIMEOUTS.template, outputFiles: [] }
}

/** Parameters for `ppt-master register-template`. */
export interface RegisterTemplateParams {
  /** Template directory id under `templates/<kind>/`; omitted with `rebuildAll`. */
  readonly templateId?: string
  readonly kind?: TemplateRegistryKind
  readonly rebuildAll?: boolean
  readonly dryRun?: boolean
}

/**
 * Build the argv for `ppt-master register-template`.
 *
 * @param params - template id or a full rebuild, plus kind and dry-run.
 * @returns the validated invocation.
 */
export function registerTemplate(params: RegisterTemplateParams): EngineInvocation {
  const argv = ['register-template']
  if (params.templateId !== undefined) argv.push(params.templateId)
  if (params.kind !== undefined) argv.push('--kind', assertEnum('kind', params.kind, TEMPLATE_REGISTRY_KINDS))
  if (params.rebuildAll === true) argv.push('--rebuild-all')
  if (params.dryRun === true) argv.push('--dry-run')
  return { id: 'register-template', argv, timeoutMs: POST_TIMEOUTS.template, outputFiles: [] }
}