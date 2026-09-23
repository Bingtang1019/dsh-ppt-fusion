import { join, resolve } from 'node:path'
import type { BridgeResult } from '../bridge/theme.ts'
import { toJsonDocument } from '../bridge/theme.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { themeFromProfile } from '../bridge/profile-theme.ts'
import { parseDesignProfile } from '../schema/design-profile.ts'
import { parseThemeFile, type ThemeFile } from '../schema/tokens.ts'
import { readManifest } from '../deck.ts'
import { frontendFor, resolveDeckDir, themeBridgeFor, type CommandDependencies } from './context.ts'

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

/** Options for `dsh-ppt theme apply-profile` (V7.2 B2). */
export interface ThemeApplyProfileOptions {
  /** Deck workspace the profile and the output resolve against. */
  readonly dir: string
  /** Design profile JSON, workspace-relative or absolute. */
  readonly profile: string
  /** Preset whose menu, shape and story the generated theme keeps. */
  readonly from: string
  /** Theme file to write, resolved against the workspace; defaults to `theme.json`. */
  readonly output?: string
  readonly deps: CommandDependencies
}

/** What `theme apply-profile` produced. */
export interface ThemeApplyProfileResult {
  readonly outputFile: string
  /** The theme id, which stays the preset's id so pptwise resolves the deck-local file. */
  readonly id: string
  readonly theme: ThemeFile
}

/**
 * Generate a ThemeFile v2 from a design profile on top of a preset's menu.
 *
 * The result keeps the preset's id and lives at `<deck>/theme.json`: pptwise resolves
 * a deck-local theme by id, so the deck's IR keeps naming the preset while the file
 * supplies the profile's palette, fonts and backgrounds. A preset is materialised
 * only when the file is absent; an existing file with a different id is refused
 * rather than rebound to another menu (ADR-052). The palette must pass the WCAG
 * floor before anything is written (a failing palette is reported, never adjusted).
 *
 * @param options - workspace, profile, preset and output.
 * @returns the written theme path, its id and the theme document.
 * @throws DshPptFailure `OutputMissing` when the profile is absent,
 *   `PathOutsideWorkspace` for an output outside the workspace, `ContractViolation`
 *   for an invalid profile, a failing contrast floor or a menu mismatch.
 */
export function themeApplyProfile(options: ThemeApplyProfileOptions): ThemeApplyProfileResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const profilePath = resolve(dir, options.profile)
  const profileText = fs.readText(profilePath)
  if (profileText === null) {
    throw new DshPptFailure('OutputMissing', `the design profile is absent: ${profilePath}`, { detail: { profilePath } })
  }
  const profile = parseDesignProfile(JSON.parse(profileText) as unknown)
  const outputFile = assertInsideWorkspace(dir, options.output ?? 'theme.json', 'output')
  const existing = fs.readText(outputFile)
  if (existing === null) {
    frontendFor(dir, options.deps).themeNew({ from: options.from, output: outputFile, id: options.from })
  } else {
    const current = parseThemeFile(JSON.parse(existing) as unknown)
    if (current.id !== options.from) {
      throw new DshPptFailure(
        'ContractViolation',
        `${outputFile} holds theme "${current.id}" but --from is "${options.from}"; a profile does not rebind a deck to another menu (ADR-052)`,
        { detail: { outputFile, current: current.id, from: options.from } },
      )
    }
  }
  const baseText = fs.readText(outputFile)
  if (baseText === null) {
    throw new DshPptFailure('OutputMissing', `pptwise did not write the theme file at ${outputFile}`, { detail: { outputFile, preset: options.from } })
  }
  const base = parseThemeFile(JSON.parse(baseText) as unknown)
  const theme = themeFromProfile(base, profile)
  fs.writeText(outputFile, toJsonDocument(theme))
  return { outputFile, id: base.id, theme }
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
