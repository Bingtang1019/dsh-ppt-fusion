import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { createDeepRenderer, type DeepPage, type DeepRenderResult } from '../engine/deep-render.ts'
import { loadDeck } from '../deck.ts'
import { validateDeck } from './validate.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'
import { SLIDE_FORMATS, type SlideFormat } from '../engine/contracts.ts'

/** Parameters for `dsh-ppt deep render`. */
export interface DeepRenderCommandOptions {
  /** Deck directory as given on the command line. */
  readonly dir: string
  /** Render only this 1-based page index. */
  readonly page?: number
  /** Output pptx; defaults to `<deck>/out/deep.pptx` or `deep-p<NN>.pptx`. */
  readonly output?: string
  readonly deps: CommandDependencies
}

/**
 * Render the deck's deep pages into one pptx.
 *
 * This is the M3 surface: the deep half of the M4 `render` chain, callable on its
 * own so a single page can be rendered and inspected without touching the
 * standard pages. The deck must already pass `validate`, and its token file must
 * be in sync, because the spec lock the engine gate demands is derived from those
 * tokens.
 *
 * @param options - deck directory, optional page selector and output path.
 * @returns the render result, including the exporter report and receipt. Paths given\n *   in `--out` are resolved against the deck directory.
 * @throws DshPptFailure when the deck is invalid, has no deep pages, mixes canvas
 *   formats, or has stale theme tokens.
 */
export function deepRender(options: DeepRenderCommandOptions): DeepRenderResult & { format: SlideFormat } {
  const dir = resolveDeckDir(options.deps, options.dir)
  const context = loadDeck(dir, options.deps.fs)

  const report = validateDeck({ dir, deps: options.deps })
  const errors = report.findings.filter((finding) => finding.level === 'error')
  if (errors.length > 0) {
    throw new DshPptFailure('ContractViolation', `deck workspace is not valid: ${errors.map((finding) => finding.message).join('; ')}`, {
      detail: { findings: errors },
    })
  }
  if (context.tokens === null) {
    throw new DshPptFailure('OutputMissing', 'tokens.json is absent or stale; run `dsh-ppt theme ensure` before rendering deep pages', {
      detail: { dir },
    })
  }

  const deepPages = context.deck.pages.filter((page) => page.route === 'ppt-master')
  const selected = options.page === undefined ? deepPages : deepPages.filter((page) => page.index === options.page)
  if (selected.length === 0) {
    throw new DshPptFailure(
      'UsageError',
      options.page === undefined
        ? `${dir} declares no deep page; every page routes to pptwise, so there is nothing for the deep engine to render`
        : `page ${String(options.page)} is not a deep page in ${dir}`,
      { detail: { page: options.page } },
    )
  }

  const formats = new Set(selected.map((page) => page.deep.format))
  if (formats.size > 1) {
    throw new DshPptFailure('ContractViolation', `deep pages in one export must share a canvas format; found ${[...formats].join(', ')}`, {
      detail: { formats: [...formats] },
    })
  }
  const format = [...formats][0] ?? 'ppt169'

  const pages: DeepPage[] = selected.map((page) => {
    const spec = page.route === 'ppt-master' ? page.deep : undefined
    if (spec === undefined) throw new DshPptFailure('ContractViolation', 'internal: selected page lost its deep spec')
    return { index: page.index, spec, svgPath: join(dir, spec.dir, 'page.svg') }
  })

  // Relative `--out` resolves against the deck, matching every other deck command
  // and the engine''s rule that it only writes inside the workspace.
  const outputFile = options.output === undefined
    ? join(dir, 'out', options.page === undefined ? 'deep.pptx' : `deep-p${String(options.page).padStart(2, '0')}.pptx`)
    : resolve(dir, options.output)

  if (!SLIDE_FORMATS.includes(format)) {
    throw new DshPptFailure('ContractViolation', `deep page format ${format} is not a registered canvas`, { detail: { format } })
  }

  const renderer = createDeepRenderer({ master: engineFor(dir, options.deps), fs: options.deps.fs, tokens: context.tokens, format })
  options.deps.fs.mkdirp(join(dir, 'out'))
  const result = renderer.render({ pages, outputFile })
  return { ...result, format }
}
