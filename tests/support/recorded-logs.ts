import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** One recorded engine invocation, as written by `createLoggingRunner`. */
export interface RecordedLog {
  readonly command: string
  readonly cwd: string
  readonly argv: readonly string[]
  readonly status: number | null
  readonly outcome: string
  readonly stdout: string
  readonly stderr: string
}

/** Directory holding the recorded engine transcripts. */
export const ENGINE_FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/engine/', import.meta.url))

/**
 * Parse a recorded log file back into its parts.
 *
 * Contract tests replay these transcripts instead of spawning the engine, so the
 * parsing and classification code is exercised against bytes a real run
 * produced.
 *
 * @param name - fixture file name inside `fixtures/engine/`.
 * @returns the recorded invocation.
 */
export function readRecordedLog(name: string): RecordedLog {
  const text = readFileSync(`${ENGINE_FIXTURE_DIR}${name}`, 'utf8')
  const header = text.split(/\r?\n--- /)[0] ?? ''
  const field = (label: string): string => new RegExp(`^${label}: (.*)$`, 'm').exec(header)?.[1] ?? ''
  const section = (label: string): string => {
    // Deliberately no `m` flag: with it, `$` matches every line end and the lazy
    // group would stop after the first line of the section.
    const pattern = new RegExp(`--- ${label} ---\\r?\\n([\\s\\S]*?)(?=\\r?\\n--- |$)`)
    return pattern.exec(text)?.[1] ?? ''
  }
  const statusText = field('status')
  return {
    command: field('command'),
    cwd: field('cwd'),
    argv: field('argv').split(' ').filter((entry) => entry !== ''),
    status: statusText === 'killed' ? null : Number.parseInt(statusText, 10),
    outcome: field('outcome'),
    stdout: section('stdout'),
    stderr: section('stderr'),
  }
}