import { join } from 'node:path'
import type { Runner } from './engine/runner.ts'
import { nodeFileSystem, type FileSystemPort } from './engine/venv.ts'

/**
 * Per-run diagnostics sink.
 *
 * Plan v2 §3.12 makes `<deck>/.dsh-ppt/logs/<timestamp>-<command>.log` the first
 * place to look when a render fails, so every command that reaches an external
 * program writes one file whether it succeeds or throws.
 */
export interface CommandLogSink {
  /** Directory log files are written into. */
  readonly directory: string
  /**
   * @param command - subcommand name, used in the file name.
   * @param text - full log body.
   * @returns the absolute path that was written.
   */
  write(command: string, text: string): string
}

/** Stable, filesystem-safe timestamp: `20260922-133042-512`. */
export function logTimestamp(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

/**
 * @param options.workspace - deck workspace that owns the `.dsh-ppt` tree.
 * @param options.fs - filesystem port.
 * @param options.now - clock, injected for deterministic tests.
 * @returns a sink that creates the log directory lazily on first write.
 */
export function createWorkspaceLogSink(options: {
  workspace: string
  fs?: FileSystemPort
  now?: () => Date
}): CommandLogSink {
  const fs = options.fs ?? nodeFileSystem
  const now = options.now ?? (() => new Date())
  const directory = join(options.workspace, '.dsh-ppt', 'logs')
  return {
    directory,
    write(command, text) {
      fs.mkdirp(directory)
      const safe = command.replace(/[^A-Za-z0-9._-]+/g, '-')
      const path = join(directory, `${logTimestamp(now())}-${safe}.log`)
      fs.writeText(path, text)
      return path
    },
  }
}

/** Render one command's log body: the argv, the outcome, and any captured output. */
export function formatCommandLog(entry: {
  command: string
  argv: readonly string[]
  cwd: string
  status: number | null
  durationMs: number
  outcome: string
  stdout?: string
  stderr?: string
}): string {
  const lines = [
    `command: ${entry.command}`,
    `cwd: ${entry.cwd}`,
    `argv: ${entry.argv.join(' ')}`,
    `status: ${entry.status === null ? 'killed' : String(entry.status)}`,
    `durationMs: ${String(entry.durationMs)}`,
    `outcome: ${entry.outcome}`,
  ]
  if (entry.stderr !== undefined && entry.stderr.trim() !== '') lines.push('', '--- stderr ---', entry.stderr.trimEnd())
  if (entry.stdout !== undefined && entry.stdout.trim() !== '') lines.push('', '--- stdout ---', entry.stdout.trimEnd())
  return `${lines.join('\n')}\n`
}

/**
 * Wrap a runner so every child invocation is logged under the deck workspace.
 *
 * The plan makes `<deck>/.dsh-ppt/logs/<timestamp>-<command>.log` the first place
 * to look when a render fails (§3.12), and this is the one place that guarantee
 * is implemented: both the pptwise front end and the ppt-master engine go through
 * whatever runner their factory received.
 *
 * @param options.runner - the real runner.
 * @param options.sink - destination for the log files.
 * @param options.now - clock, injected for deterministic tests.
 * @returns a runner with the same contract that also writes one log per call.
 */
export function createLoggingRunner(options: { runner: Runner; sink: CommandLogSink; now?: () => number }): Runner {
  const now = options.now ?? (() => Date.now())
  return (command, args, runOptions) => {
    const started = now()
    const result = options.runner(command, args, runOptions)
    // Name the log after the subcommand rather than the executable: one glance at
    // the directory should show which step of the pipeline failed.
    const label =
      args.find((argument) => !argument.startsWith('-') && !argument.includes('/') && !argument.includes('\\')) ??
      command.replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
    options.sink.write(
      label,
      formatCommandLog({
        command: `${command} ${args[0] ?? ''}`.trim(),
        argv: [command, ...args],
        cwd: runOptions.cwd,
        status: result.status,
        durationMs: now() - started,
        outcome: result.timedOut ? 'timeout' : result.spawnError !== null ? `spawn-error ${result.spawnError}` : result.status === 0 ? 'ok' : 'exit-nonzero',
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    )
    return result
  }
}
