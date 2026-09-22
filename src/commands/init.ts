import { basename, join } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { parseFusionDeck, type FusionDeck } from '../schema/fusion.ts'
import { FUSION_MANIFEST } from '../deck.ts'
import { toJsonDocument, type BridgeResult } from '../bridge/theme.ts'
import { themeBridgeFor, type CommandDependencies } from './context.ts'

/** Options for `dsh-ppt init`. */
export interface InitOptions {
  readonly dir: string
  /** Factory preset id bound as the deck theme. */
  readonly theme: string
  readonly deps: CommandDependencies
}

/** What `init` produced. */
export interface InitResult {
  readonly dir: string
  readonly created: readonly string[]
  readonly theme: BridgeResult
}

/**
 * The two-page skeleton every new deck starts from.
 *
 * A cover and an ending are the smallest deck pptwise validates and renders, so
 * `init` leaves the workspace in a state where `validate` already passes and the
 * author only adds content.
 *
 * @param name - deck name, taken from the directory.
 * @param themeId - bound preset id; the IR must name the same theme pptwise renders with.
 * @returns the IR document and its slide count.
 */
export function skeletonIr(name: string, themeId: string): { document: Record<string, unknown>; slideCount: number } {
  const slides: Record<string, unknown>[] = [
    { type: 'cover', id: 'p01', heading: name, subheading: 'created by dsh-ppt init', components: [] },
    { type: 'ending', id: 'p02', heading: 'Thank you', components: [] },
  ]
  return {
    document: {
      version: '5',
      filename: name,
      theme: { id: themeId },
      meta: { organization: name, authors: [{ name: 'dsh-ppt' }] },
      assets: { images: {} },
      slides,
    },
    slideCount: slides.length,
  }
}

/**
 * The manifest for that skeleton: one pptwise route per IR page.
 *
 * @param name - deck name.
 * @param preset - bound preset id.
 * @param slideCount - number of slides the IR has.
 * @returns the manifest document.
 */
export function skeletonManifest(name: string, preset: string, slideCount: number): FusionDeck {
  return parseFusionDeck({
    version: 1,
    name,
    pptwiseIr: 'deck.ir.json',
    theme: { preset },
    pages: Array.from({ length: slideCount }, (_, offset) => ({ index: offset + 1, route: 'pptwise' })),
  })
}

/**
 * Create a deck workspace that already validates.
 *
 * @param options - target directory, bound preset and dependencies.
 * @returns the created file paths and the theme bridge result.
 * @throws DshPptFailure `ContractViolation` when the target already holds a manifest.
 */
export function initDeck(options: InitOptions): InitResult {
  const { dir, deps } = options
  const manifestPath = join(dir, FUSION_MANIFEST)
  if (deps.fs.exists(manifestPath)) {
    throw new DshPptFailure('ContractViolation', `${dir} already holds a ${FUSION_MANIFEST}; refusing to overwrite it`, {
      detail: { dir },
    })
  }
  const name = basename(dir)
  deps.fs.mkdirp(dir)

  const irPath = join(dir, 'deck.ir.json')
  const ir = skeletonIr(name, options.theme)
  const deck = skeletonManifest(name, options.theme, ir.slideCount)
  deps.fs.writeText(irPath, toJsonDocument(ir.document))
  deps.fs.writeText(manifestPath, toJsonDocument(deck))

  const theme = themeBridgeFor(dir, deps).ensure(deck)
  return { dir, created: [irPath, manifestPath, ...theme.changed], theme }
}
