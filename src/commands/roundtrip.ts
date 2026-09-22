import { basename, join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative, type InheritanceMode } from '../engine/contracts.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'

/** Parameters for `dsh-ppt deep native roundtrip`. */
export interface NativeRoundtripOptions {
  /** Deck workspace the input and output paths resolve against. */
  readonly dir: string
  /** pptx to import back into SVG. */
  readonly file: string
  /** Output workspace; defaults to `<deck>/.dsh-ppt/roundtrip/<stem>`. */
  readonly output?: string
  /** Inheritance mode; `both` is required by `--roundtrip`. */
  readonly inheritanceMode?: InheritanceMode
  readonly keepHidden?: boolean
  readonly strict?: boolean
  readonly deps: CommandDependencies
}

/** What one round-trip import produced. */
export interface NativeRoundtripResult {
  readonly file: string
  readonly outputDir: string
  /** Editable slide SVGs, workspace-relative and sorted. */
  readonly slides: readonly string[]
  readonly stdout: string
}

/**
 * Import a published pptx back into the engine's source-preserving SVG workspace.
 *
 * The minimal path plan §5 M5 asks for: `pptx-to-svg --roundtrip
 * --inheritance-mode both`, which publishes `authoring-svg-flat/` as the editable
 * source. The result is what `deep template create` materialises templates from, and
 * what the M6 SKILL uses to edit an existing deck natively.
 *
 * @param options - workspace, input pptx, output directory and round-trip flags.
 * @returns the editable SVGs and the engine's stdout.
 * @throws DshPptFailure `OutputMissing` when the input or the expected SVGs are absent,
 *   `PathOutsideWorkspace` for a path outside the deck.
 */
export function deepNativeRoundtrip(options: NativeRoundtripOptions): NativeRoundtripResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const file = toWorkspaceRelative(dir, options.file)
  if (!fs.exists(resolve(dir, file))) {
    throw new DshPptFailure('OutputMissing', `no pptx at ${file}`, { detail: { file, dir } })
  }
  const stem = basename(file).replace(/\.pptx$/i, '')
  const outputDir = toWorkspaceRelative(dir, options.output === undefined ? join(dir, '.dsh-ppt', 'roundtrip', stem) : resolve(dir, options.output))
  const call = engineFor(dir, options.deps).pptxToSvg({
    file,
    output: outputDir,
    inheritanceMode: options.inheritanceMode ?? 'both',
    roundtrip: true,
    ...(options.keepHidden === true ? { keepHidden: true } : {}),
    ...(options.strict === true ? { strict: true } : {}),
  })
  const slides = listSlideSvgs(options.deps, dir, outputDir)
  if (slides.length === 0) {
    throw new DshPptFailure('OutputMissing', `pptx-to-svg reported success but wrote no editable SVG under ${outputDir}`, {
      detail: { outputDir, stdout: call.result.stdout.slice(-2000) },
    })
  }
  return { file, outputDir, slides, stdout: call.result.stdout }
}

/** @returns editable slide SVGs, preferring the round-trip authoring source. */
function listSlideSvgs(deps: CommandDependencies, dir: string, outputDir: string): string[] {
  for (const candidate of ['authoring-svg-flat', 'svg', 'svg-flat']) {
    const path = resolve(dir, outputDir, candidate)
    if (!deps.fs.isDirectory(path)) continue
    const files = deps.fs.listDir(path).filter((name) => name.toLowerCase().endsWith('.svg')).sort()
    if (files.length > 0) return files.map((name) => `${outputDir}/${candidate}/${name}`)
  }
  return []
}
