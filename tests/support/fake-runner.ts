import { dirname, join, sep } from 'node:path'
import type { FileSystemPort } from '../../src/engine/venv.ts'
import type { RunOptions, RunResult, Runner } from '../../src/engine/runner.ts'

/** One recorded child-process invocation. */
export interface FakeCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunOptions
}

/** A runner that records calls and answers them from a handler. */
export interface FakeRunner extends Runner {
  readonly calls: FakeCall[]
  /** Every recorded call whose argv contains `needle`. */
  callsWith(needle: string): FakeCall[]
}

/**
 * Build a scriptable runner.
 *
 * @param handler - maps a recorded call to the result fields to override.
 * @returns a `Runner` that records every call; unhandled fields default to a
 *   successful, empty run.
 */
export function createFakeRunner(handler: (call: FakeCall) => Partial<RunResult> = () => ({})): FakeRunner {
  const calls: FakeCall[] = []
  const runner = ((command, args, options) => {
    const call: FakeCall = { command, args: [...args], options }
    calls.push(call)
    return {
      status: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: null,
      spawnErrorMessage: '',
      ...handler(call),
    }
  }) as FakeRunner & { calls: FakeCall[] }
  Object.defineProperty(runner, 'calls', { value: calls })
  runner.callsWith = (needle) => calls.filter((call) => call.args.some((argument) => argument.includes(needle)))
  return runner
}

/** @returns result fields for a successful run. */
export function ok(stdout = '', stderr = ''): Partial<RunResult> {
  return { status: 0, stdout, stderr }
}

/** @returns result fields for a failed run. */
export function fail(status: number, stderr = '', stdout = ''): Partial<RunResult> {
  return { status, stdout, stderr }
}

/** @returns result fields for a killed run. */
export function timedOut(stdout = ''): Partial<RunResult> {
  return { status: null, stdout, stderr: '', timedOut: true }
}

/** @returns result fields for a spawn failure. */
export function spawnFailed(code = 'ENOENT', message = 'spawn ENOENT'): Partial<RunResult> {
  return { status: null, spawnError: code, spawnErrorMessage: message }
}

/** An in-memory filesystem for tests; paths are compared as written. */
export interface FakeFileSystem extends FileSystemPort {
  readonly files: Map<string, string>
  readonly directories: Set<string>
}

/** Normalize a test path to the platform separator so `join` and literals agree. */
const normalize = (path: string): string => path.split('/').join(sep)

/**
 * Build an in-memory filesystem.
 *
 * @param options.files - file contents keyed by path; parent directories are created implicitly.
 * @param options.directories - extra directories to create.
 * @returns a `FileSystemPort` over the in-memory state.
 */
export function createFakeFileSystem(options: { files?: Record<string, string>; directories?: readonly string[] } = {}): FakeFileSystem {
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const addParents = (path: string): void => {
    let current = dirname(path)
    while (current !== '' && current !== dirname(current)) {
      directories.add(current)
      current = dirname(current)
    }
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const key = normalize(path)
    files.set(key, content)
    addParents(key)
  }
  for (const path of options.directories ?? []) directories.add(normalize(path))
  return {
    files,
    directories,
    exists: (path) => files.has(normalize(path)) || directories.has(normalize(path)),
    isDirectory: (path) => directories.has(normalize(path)),
    listDir: (path) => {
      const prefix = `${normalize(path)}${sep}`
      const names = new Set<string>()
      for (const key of [...files.keys(), ...directories]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest === '' || rest.includes(sep)) continue
        names.add(rest)
      }
      return [...names]
    },
    readText: (path) => files.get(normalize(path)) ?? null,
    writeText: (path, text) => {
      const key = normalize(path)
      files.set(key, text)
      addParents(key)
    },
    removeTree: (path) => {
      const prefix = `${normalize(path)}${sep}`
      for (const key of [...files.keys()]) if (key === normalize(path) || key.startsWith(prefix)) files.delete(key)
      for (const key of [...directories]) if (key === normalize(path) || key.startsWith(prefix)) directories.delete(key)
    },
    mkdirp: (path) => {
      const key = normalize(path)
      directories.add(key)
      addParents(key)
    },
  }
}

/** Convenience: a workspace path that matches what production code would compute. */
export function workspacePath(...segments: string[]): string {
  return join(...segments)
}
