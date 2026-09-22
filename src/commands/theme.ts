import { join, resolve } from 'node:path'
import type { BridgeResult } from '../bridge/theme.ts'
import { readManifest } from '../deck.ts'
import { frontendFor, themeBridgeFor, type CommandDependencies } from './context.ts'

/** One entry of the factory theme catalog. */
export interface ThemeSummary {
  readonly id: string
  readonly label?: string
  readonly occasions?: readonly string[]
  readonly identity?: string
}

/**
 * Bring a deck's theme files in line with its manifest.
 *
 * Idempotent: a second run over an unchanged deck writes nothing, because the
 * bridge compares the derived documents before writing them.
 *
 * @param options.dir - deck workspace.
 * @param options.deps - command dependencies.
 * @returns the paths, what changed and the derived documents.
 */
export function themeEnsure(options: { dir: string; deps: CommandDependencies }): BridgeResult {
  const { deck } = readManifest(options.dir, options.deps.fs)
  return themeBridgeFor(options.dir, options.deps).ensure(deck)
}

/**
 * @param options.deps - command dependencies.
 * @returns the factory preset catalog as reported by the upstream CLI.
 */
export function themeList(options: { deps: CommandDependencies }): readonly ThemeSummary[] {
  return frontendFor(options.deps.cwd, options.deps).themes()
}

/**
 * Materialise a preset (or a copy under a new id) as a complete theme file.
 *
 * @param options.dir - workspace the CLI runs in; also the base for a relative `-o`.
 * @param options.from - source preset id.
 * @param options.output - output path, absolute or workspace-relative.
 * @param options.id - id to write into the copy; defaults to the source id.
 * @param options.deps - command dependencies.
 * @returns the absolute path that was written.
 */
export function themeNew(options: {
  dir: string
  from: string
  output: string
  id?: string
  deps: CommandDependencies
}): { outputFile: string } {
  return frontendFor(options.dir, options.deps).themeNew({
    from: options.from,
    output: options.output,
    ...(options.id === undefined ? {} : { id: options.id }),
  })
}

/**
 * Re-derive a theme's palette from one new primary colour, keeping its page menu.
 *
 * @param options.id - existing theme id or file.
 * @param options.primary - new primary colour.
 * @param options.newId - id for the fork.
 * @param options.output - target directory or file.
 */
export function themeFork(options: {
  dir: string
  id: string
  primary: string
  newId?: string
  output?: string
  deps: CommandDependencies
}): { stdout: string } {
  return frontendFor(options.dir, options.deps).themeFork({
    id: options.id,
    primary: options.primary,
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    ...(options.output === undefined ? {} : { output: options.output }),
  })
}

/**
 * Render the fitting-room sample under 2–4 candidate themes so a human or model
 * can compare them from images instead of names (plan §3.2 step 2).
 */
export function themeTry(options: { dir: string; ids: string; output?: string; deps: CommandDependencies }): { stdout: string } {
  return frontendFor(options.dir, options.deps).themeTry({
    ids: options.ids,
    ...(options.output === undefined ? {} : { output: options.output }),
  })
}

/**
 * @param dir - deck workspace.
 * @param deps - command dependencies.
 * @returns the absolute path of the file `theme try` writes its contact sheet to.
 */
export function themeTrySheet(dir: string, output?: string): string {
  return resolve(dir, output ?? join('.pptwise', 'theme-try'))
}
