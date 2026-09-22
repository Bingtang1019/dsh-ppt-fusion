import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative } from '../engine/contracts.ts'
import { FUSION_MANIFEST } from '../deck.ts'
import { parseFusionDeck } from '../schema/fusion.ts'
import { parseThemeFile } from '../schema/tokens.ts'
import { frontendFor, resolveDeckDir, type CommandDependencies } from './context.ts'
import { themeEnsure } from './theme.ts'

/** Parameters for `dsh-ppt brand extract`. */
export interface BrandExtractOptions {
  /** Workspace the pptwise front end runs in; every path stays inside it. */
  readonly dir: string
  /** Office file (pptx/docx) to read the colours and fonts from. */
  readonly file: string
  /** Output theme file, deck-relative; defaults to `brand.theme.json`. */
  readonly output?: string
  /** pptwise preset to start from, when the caller wants one. */
  readonly from?: string
  /** Deck to bind the extracted theme to: extract → write binding → ensure tokens. */
  readonly bind?: string
  readonly deps: CommandDependencies
}

/** What one brand extraction produced. */
export interface BrandExtractResult {
  readonly outputFile: string
  readonly themeId: string
  readonly bound: { readonly deckDir: string; readonly themeFile: string; readonly ensured: readonly string[] } | null
}

/**
 * Extract a ThemeFile v2 from an Office file with pptwise `brand extract`, and
 * optionally bind it to a deck.
 *
 * Binding rewrites that deck's `deck.fusion.json` theme to `{file: "brand.theme.json"}`
 * and runs `theme ensure`, which is the linkage plan §5 M5 item 4 asks for: one command
 * turns a customer deck into a theme this toolchain can render with.
 *
 * @param options - workspace, source file, output path, optional preset and deck.
 * @returns the written theme, its id, and the binding it performed.
 * @throws DshPptFailure `PathOutsideWorkspace` for a path outside the workspace,
 *   `OutputMissing` when the deck or the written theme is absent, and
 *   `ContractViolation` when the output is not a ThemeFile v2.
 */
export function brandExtract(options: BrandExtractOptions): BrandExtractResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const target = options.bind === undefined ? null : toWorkspaceRelative(dir, options.bind)
  const outputFile = options.output === undefined ? (target === null ? 'brand.theme.json' : join(target, 'brand.theme.json')) : options.output
  const output = toWorkspaceRelative(dir, resolve(dir, outputFile))
  const file = toWorkspaceRelative(dir, options.file)
  if (!fs.exists(resolve(dir, file))) {
    throw new DshPptFailure('OutputMissing', `no Office file at ${file}`, { detail: { file } })
  }
  const result = frontendFor(dir, options.deps).brandExtract({
    file,
    output,
    ...(options.from === undefined ? {} : { from: options.from }),
  })
  const text = fs.readText(resolve(dir, output))
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `brand extract reported success but ${output} is absent`, { detail: { output } })
  }
  let themeId: string
  try {
    themeId = parseThemeFile(JSON.parse(text) as unknown).id
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `brand extract wrote ${output}, which is not a ThemeFile v2: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { output },
      cause: error,
    })
  }
  if (target === null) return { outputFile: result.outputFile, themeId, bound: null }

  const themeFile = join(target, 'brand.theme.json')
  const boundDeck = target === '' ? '.' : target
  if (themeFile !== output) fs.writeText(resolve(dir, themeFile), text)
  const manifestPath = join(dir, target, FUSION_MANIFEST)
  const manifestText = fs.readText(manifestPath)
  if (manifestText === null) {
    throw new DshPptFailure('OutputMissing', `${target} has no ${FUSION_MANIFEST} to bind`, { detail: { target } })
  }
  const updated = { ...(JSON.parse(manifestText) as Record<string, unknown>), theme: { file: 'brand.theme.json' } }
  parseFusionDeck(updated)
  fs.writeText(manifestPath, `${JSON.stringify(updated, null, 2)}\n`)
  const ensured = themeEnsure({ dir: resolve(dir, target), deps: options.deps })
  return { outputFile: result.outputFile, themeId, bound: { deckDir: boundDeck, themeFile: 'brand.theme.json', ensured: ensured.changed } }
}
