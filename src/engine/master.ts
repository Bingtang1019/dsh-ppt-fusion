import { isAbsolute } from 'node:path'
import {
  applyTemplate,
  deliveryCheck,
  imageSearch,
  mirrorTemplateMaterialize,
  registerTemplate,
  pptxTemplateImport,
  sourceToMarkdown,
  narrationSync,
  notesToAudio,
  pptxToSvg,
  sourceToMd,
  parseCreatedProjectDir,
  projectInit,
  qualityCheck,
  stampFallbacks,
  svgToPptx,
  assertInsideWorkspace,
  toWorkspaceRelative,
  type ApplyTemplateParams,
  type RegisterTemplateParams,
  type DeliveryCheckParams,
  type ImageSearchParams,
  type MirrorTemplateParams,
  type PptxTemplateImportParams,
  type SourceDispatchParams,
  type NarrationSyncParams,
  type NotesToAudioParams,
  type PptxToSvgParams,
  type SourceToMdParams,
  type ProjectInitParams,
  type QualityCheckParams,
  type StampFallbacksParams,
  type SvgToPptxParams,
  type EngineInvocation,
} from './contracts.ts'
import { DshPptFailure } from './errors.ts'
import type { RunResult } from './runner.ts'
import type { createVenvManager } from './venv.ts'
import { formatCommandLog, type CommandLogSink } from '../logging.ts'

/** Options shared by every master-engine call. */
export interface MasterEngineOptions {
  /** Absolute deck workspace: the child's cwd and the only writable root. */
  readonly workspace: string
  /** Venv manager that owns the interpreter and dispatcher. */
  readonly venv: ReturnType<typeof createVenvManager>
  /** Diagnostics sink; omitted in unit tests. */
  readonly log?: CommandLogSink
  /** Clock, injected for deterministic timing in tests. */
  readonly now?: () => number
}

/** One completed engine call. */
export interface MasterCall {
  readonly invocation: EngineInvocation
  readonly result: RunResult
  /** Absolute paths of contracted outputs that were verified present. */
  readonly outputFiles: readonly string[]
}

/**
 * Create the ppt-master process layer: the single place in this package that
 * starts the Python engine.
 *
 * Every path argument is proven to live inside the workspace before it reaches
 * argv, and every run is timed and logged, so a failure can be reproduced from
 * `<workspace>/.dsh-ppt/logs/` alone.
 *
 * @param options - workspace, venv manager, optional log sink and clock.
 * @returns the typed command surface used by `render`, `audit` and `doctor`.
 */
export function createMasterEngine(options: MasterEngineOptions) {
  const now = options.now ?? (() => Date.now())

  const execute = (invocation: EngineInvocation, allowCredentials?: readonly string[]): MasterCall => {
    const started = now()
    try {
      const { result, outputFiles } = options.venv.run(invocation, {
        workspace: options.workspace,
        ...(allowCredentials === undefined ? {} : { allowCredentials }),
      })
      options.log?.write(
        invocation.id,
        formatCommandLog({
          command: invocation.id,
          argv: invocation.argv,
          cwd: options.workspace,
          status: result.status,
          durationMs: now() - started,
          outcome: 'ok',
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      )
      return { invocation, result, outputFiles }
    } catch (error) {
      const failure = error instanceof DshPptFailure ? error : undefined
      options.log?.write(
        invocation.id,
        formatCommandLog({
          command: invocation.id,
          argv: invocation.argv,
          cwd: options.workspace,
          status: null,
          durationMs: now() - started,
          outcome: failure === undefined ? String(error) : `${failure.code} ${failure.message}`,
          stderr: typeof failure?.detail.stderr === 'string' ? failure.detail.stderr : undefined,
        }),
      )
      throw error
    }
  }

  const relative = (target: string, label: string): string => {
    assertInsideWorkspace(options.workspace, target, label)
    return isAbsolute(target) ? toWorkspaceRelative(options.workspace, target) : target.replace(/\\/g, '/')
  }

  return {
    /** Absolute deck workspace: the child''s cwd and the only writable root. */
    workspace: options.workspace,

    /** @see projectInit */
    projectInit(params: ProjectInitParams): MasterCall & { projectDir: string } {
      const invocation = projectInit({
        name: params.name,
        format: params.format,
        baseDir: relative(params.baseDir, 'baseDir'),
      })
      const call = execute(invocation)
      const created = parseCreatedProjectDir(call.result.stdout)
      if (created === null) {
        throw new DshPptFailure('OutputMissing', `project init did not report a created project directory: ${call.result.stdout.trim()}`, {
          detail: { stdout: call.result.stdout },
        })
      }
      return { ...call, projectDir: assertInsideWorkspace(options.workspace, created, 'created project') }
    },

    /** @see svgToPptx */
    renderDeep(params: SvgToPptxParams): MasterCall {
      const invocation = svgToPptx({
        ...params,
        projectDir: relative(params.projectDir, 'projectDir'),
        outputFile: relative(params.outputFile, 'outputFile'),
        ...(params.sourceDir === undefined ? {} : { sourceDir: relative(params.sourceDir, 'sourceDir') }),
        ...(params.recordedNarration === undefined ? {} : { recordedNarration: relative(params.recordedNarration, 'recordedNarration') }),
      })
      return execute(invocation)
    },

    /** @see qualityCheck */
    qualityCheck(params: QualityCheckParams): MasterCall {
      const invocation = qualityCheck({ ...params, target: relative(params.target, 'target') })
      return execute(invocation)
    },

    /** @see deliveryCheck */
    deliveryCheck(params: DeliveryCheckParams): MasterCall {
      const invocation = deliveryCheck({ file: relative(params.file, 'file') })
      return execute(invocation)
    },

    /** @see stampFallbacks */
    stampFallbacks(params: StampFallbacksParams): MasterCall {
      const invocation = stampFallbacks({ ...params, target: relative(params.target, 'target') })
      return execute(invocation)
    },

    /** @see notesToAudio */
    notesToAudio(params: NotesToAudioParams): MasterCall {
      const invocation = notesToAudio({
        ...params,
        projectDir: relative(params.projectDir, 'projectDir'),
        ...(params.output === undefined ? {} : { output: relative(params.output, 'output') }),
      })
      return execute(invocation)
    },

    /** @see narrationSync */
    narrationSync(params: NarrationSyncParams): MasterCall {
      const invocation = narrationSync({
        ...params,
        projectDir: relative(params.projectDir, 'projectDir'),
        ...(params.pptx === undefined ? {} : { pptx: relative(params.pptx, 'pptx') }),
        ...(params.subtitleDir === undefined ? {} : { subtitleDir: relative(params.subtitleDir, 'subtitleDir') }),
        ...(params.audioDir === undefined ? {} : { audioDir: relative(params.audioDir, 'audioDir') }),
        ...(params.animationConfig === undefined ? {} : { animationConfig: relative(params.animationConfig, 'animationConfig') }),
        ...(params.plan === undefined ? {} : { plan: relative(params.plan, 'plan') }),
        ...(params.output === undefined ? {} : { output: relative(params.output, 'output') }),
      })
      return execute(invocation)
    },

    /**
     * @see imageSearch
     * @param params.query - search terms.
     * @param options.credentials - parent environment variables this provider may
     *   read; only names listed here reach the child, so a stock-photo key never
     *   leaks into an unrelated call.
     */
    imageSearch(params: ImageSearchParams, options: { credentials?: readonly string[] } = {}): MasterCall {
      return execute(imageSearch(params), options.credentials)
    },

    /** @see sourceToMarkdown */
    sourceToMarkdown(params: SourceDispatchParams): MasterCall {
      return execute(sourceToMarkdown(params))
    },

    /** @see sourceToMd */
    sourceToMd(params: SourceToMdParams): MasterCall {
      const invocation = sourceToMd({
        ...params,
        inputs: params.inputs.map((input) => (/^https?:\/\//.test(input) ? input : relative(input, 'input'))),
        ...(params.output === undefined ? {} : { output: relative(params.output, 'output') }),
      })
      return execute(invocation)
    },

    /** @see mirrorTemplateMaterialize */
    mirrorTemplateMaterialize(params: MirrorTemplateParams): MasterCall {
      const invocation = mirrorTemplateMaterialize({
        ...params,
        importWorkspace: relative(params.importWorkspace, 'importWorkspace'),
        templateWorkspace: relative(params.templateWorkspace, 'templateWorkspace'),
      })
      return execute(invocation)
    },

    /** @see pptxTemplateImport */
    templateImport(params: PptxTemplateImportParams): MasterCall {
      const invocation = pptxTemplateImport({
        ...params,
        file: relative(params.file, 'file'),
        ...(params.output === undefined ? {} : { output: relative(params.output, 'output') }),
      })
      return execute(invocation)
    },

    /** @see applyTemplate */
    applyTemplate(params: ApplyTemplateParams): MasterCall {
      const invocation = applyTemplate({
        ...params,
        projectDir: relative(params.projectDir, 'projectDir'),
        roots: params.roots.map((root) => relative(root, 'root')),
      })
      return execute(invocation)
    },

    /** @see registerTemplate */
    registerTemplate(params: RegisterTemplateParams): MasterCall {
      return execute(registerTemplate(params))
    },

    /** @see pptxToSvg */
    pptxToSvg(params: PptxToSvgParams): MasterCall {
      const invocation = pptxToSvg({
        ...params,
        file: relative(params.file, 'file'),
        ...(params.output === undefined ? {} : { output: relative(params.output, 'output') }),
      })
      return execute(invocation)
    },

    /** Run an already-built invocation; used by tests and by callers that need a custom order. */
    execute,
  }
}

/** The master engine surface, as returned by `createMasterEngine`. */
export type MasterEngine = ReturnType<typeof createMasterEngine>
