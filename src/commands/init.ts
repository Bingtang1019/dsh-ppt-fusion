import { basename, join } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { parseFusionDeck, defaultChrome, type FusionChrome, type FusionDeck } from '../schema/fusion.ts'
import { STORYBOARD_FILE, storyboardSkeleton } from '../schema/storyboard.ts'
import { FUSION_MANIFEST, readThemeDocument, themePaths, type IrView } from '../deck.ts'
import { parseDesignProfile, type DesignProfile } from '../schema/design-profile.ts'
import { toJsonDocument, type BridgeResult } from '../bridge/theme.ts'
import { themeApplyProfile } from './theme.ts'
import { themeBridgeFor, type CommandDependencies } from './context.ts'

/** Options for `dsh-ppt init`. */
export interface InitOptions {
  readonly dir: string
  /** Factory preset id bound as the deck theme. */
  readonly theme: string
  /**
   * Absolute path of a design profile (V7.2 B2). When present, `init` writes the
   * deck-local `theme.json` from the profile (keeping the preset id), disables page
   * numbers when the profile has none, and derives chrome/tokens from the result.
   */
  readonly profile?: string
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
export function skeletonManifest(
  name: string,
  preset: string,
  slideCount: number,
  options: { readonly chrome?: FusionChrome; readonly designProfile?: string } = {},
): FusionDeck {
  return parseFusionDeck({
    version: 1,
    name,
    pptwiseIr: 'deck.ir.json',
    theme: { preset },
    pages: Array.from({ length: slideCount }, (_, offset) => ({ index: offset + 1, route: 'pptwise' })),
    // A fresh deck starts with the plan's chrome contract: cover and ending skip
    // page numbers, everything else carries one. A profile whose reference deck has
    // no page numbers passes `{ pageNumber: { show: false } }` instead.
    chrome: options.chrome ?? defaultChrome(),
    ...(options.designProfile === undefined ? {} : { designProfile: options.designProfile }),
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
  const profile = options.profile === undefined ? null : readDesignProfile(options.profile, deps.fs)
  const designProfileName = profile === null ? undefined : 'design-profile.json'

  const irPath = join(dir, 'deck.ir.json')
  const ir = skeletonIr(name, options.theme)
  // A reference deck without page numbers keeps chrome switched off entirely, which
  // is the profile's `chrome.pageNumber === false` measured on the reference pages.
  const chrome = profile !== null && !profile.chrome.pageNumber ? { pageNumber: { show: false } } : defaultChrome()
  const deck = skeletonManifest(name, options.theme, ir.slideCount, {
    chrome,
    ...(designProfileName === undefined ? {} : { designProfile: designProfileName }),
  })
  deps.fs.writeText(irPath, toJsonDocument(ir.document))
  deps.fs.writeText(manifestPath, toJsonDocument(deck))
  const created = [irPath, manifestPath]
  if (profile !== null && designProfileName !== undefined) {
    // The deck keeps its own copy of the profile: `render` applies its fonts and
    // `validate` can check it without needing the user's original path.
    const profilePath = join(dir, designProfileName)
    deps.fs.writeText(profilePath, toJsonDocument(profile))
    created.push(profilePath)
  }
  // Materialise the theme first: its menu decides which layout each skeleton page
  // gets, so `init` leaves a deck whose storyboard already validates (V6 WP2).
  const firstTheme = themeBridgeFor(dir, deps).ensure(deck)
  created.push(...firstTheme.changed)
  let theme = firstTheme
  if (profile !== null) {
    // Patch the deck-local theme in place (it keeps the preset id, so both pptwise
    // rendering and the fusion tokens read it), then re-derive tokens/master from
    // the patched palette: the first ensure ran against the untouched preset.
    const applied = themeApplyProfile({ dir, profile: options.profile ?? '', from: options.theme, output: 'theme.json', deps })
    created.push(applied.outputFile)
    theme = themeBridgeFor(dir, deps).ensure(deck)
  }
  const themeDocument = readThemeDocument(themePaths(dir, deck).themePath, deps.fs)
  // A deck is not planned until it has a storyboard (plan §4.1); `init` writes the
  // skeleton so `validate` and `render` can require it from the first command.
  const storyboardPath = join(dir, STORYBOARD_FILE)
  deps.fs.writeText(
    storyboardPath,
    toJsonDocument(
      storyboardSkeleton(
        deck,
        { slides: ir.document.slides as IrView['slides'] },
        themeDocument === null ? undefined : { id: themeDocument.id, menu: themeDocument.menu },
      ),
    ),
  )
  return { dir, created: [...created, storyboardPath, ...theme.changed], theme }
}

/**
 * @param path - absolute profile path.
 * @param fs - filesystem port.
 * @returns the validated design profile.
 * @throws DshPptFailure `OutputMissing` when the file is absent, `ContractViolation` when it is invalid.
 */
function readDesignProfile(path: string, fs: CommandDependencies['fs']): DesignProfile {
  const text = fs.readText(path)
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `the design profile is absent: ${path}`, { detail: { path } })
  }
  return parseDesignProfile(JSON.parse(text) as unknown)
}
