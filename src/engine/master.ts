import { isAbsolute } from 'node:path'
import {
  deliveryCheck,
  parseCreatedProjectDir,
  projectInit,
  qualityCheck,
  stampFallbacks,
  svgToPptx,
  assertInsideWorkspace,
  toWorkspaceRelative,
  type DeliveryCheckParams,
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

  const execute = (invocation: EngineInvocation): MasterCall => {
    const started = now()
    try {
      const { result, outputFiles } = options.venv.run(invocation, { workspace: options.workspace })
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

    /** Run a already-built invocation; used by tests and by callers that need a custom order. */
    execute,
  }
}

/** The master engine surface, as returned by `createMasterEngine`. */
export type MasterEngine = ReturnType<typeof createMasterEngine>
