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
  const stem = params.outputFile.replace(/^.*\//, '').replace(/\.pptx$/i, '')
  return {
    id: 'svg-to-pptx',
    argv,
    timeoutMs: ENGINE_TIMEOUTS.svgToPptx,
    outputFiles: [params.outputFile, `validation/${stem}.report.json`],
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
  return {
    id: 'svg-quality-check',
    argv,
    timeoutMs: ENGINE_TIMEOUTS.qualityCheck,
    outputFiles: ['validation/svg_quality_report.json'],
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
