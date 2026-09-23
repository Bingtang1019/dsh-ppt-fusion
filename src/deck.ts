import { z } from 'zod'
import { join } from 'node:path'
import { DshPptFailure } from './engine/errors.ts'
import { describeIssues, chromeRoleFor, parseFusionDeck, type ChromeRole, type FusionDeck } from './schema/fusion.ts'
import { exportTokens, parseThemeFile, tokensEqual, type ThemeFile, type TokensFile } from './schema/tokens.ts'
import type { FileSystemPort } from './engine/venv.ts'

/** File name of the authoritative manifest. */
export const FUSION_MANIFEST = 'deck.fusion.json'

/**
 * A deliberately partial view of pptwise IR v5.
 *
 * pptwise owns IR validity; the fusion only needs the page list and which pages
 * are placeholders, so it reads those fields and leaves the rest untouched.
 */
const IrViewSchema = z.object({
  version: z.union([z.string(), z.number()]).optional(),
  // Deck meta (organization, authors) feeds the profile's cover/ending meta footer.
  meta: z.unknown().optional(),
  slides: z.array(
    z
      .object({
        type: z.string(),
        id: z.string().optional(),
        placeholder: z.boolean().optional(),
      })
      // Slide fields beyond the view stay in the parsed document: the budget gate
      // measures their prose and components (V6 WP2).
      .passthrough(),
  ),
})

/** The parts of the IR this package reads. */
export interface IrView {
  readonly version?: string | number
  /** Deck metadata (organization, authors); shape owned by pptwise. */
  readonly meta?: unknown
  readonly slides: readonly { type: string; id?: string; placeholder?: boolean; readonly [key: string]: unknown }[]
}

/** Everything the deck commands need, already loaded and validated. */
export interface DeckContext {
  /** Absolute deck workspace. */
  readonly dir: string
  readonly deck: FusionDeck
  readonly manifestPath: string
  /** Absolute path of the referenced IR file. */
  readonly irPath: string
  readonly ir: IrView
  /** Present when `tokens.json` exists and matches its theme binding. */
  readonly tokens: TokensFile | null
  /** Absolute path of `tokens.json`. */
  readonly tokensPath: string
  /** Absolute path of the bound theme file. */
  readonly themePath: string
}

/** Read and validate `deck.fusion.json`. */
export function readManifest(dir: string, fs: FileSystemPort): { deck: FusionDeck; manifestPath: string } {
  const manifestPath = join(dir, FUSION_MANIFEST)
  const text = fs.readText(manifestPath)
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `${FUSION_MANIFEST} is absent in ${dir}`, { detail: { dir } })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${FUSION_MANIFEST} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { manifestPath },
      cause: error,
    })
  }
  return { deck: parseFusionDeck(raw), manifestPath }
}

/** Read the pptwise IR the manifest points at. */
export function readIr(dir: string, deck: FusionDeck, fs: FileSystemPort): { ir: IrView; irPath: string } {
  const irPath = join(dir, deck.pptwiseIr)
  const text = fs.readText(irPath)
  if (text === null) {
    throw new DshPptFailure('OutputMissing', `the manifest points at ${deck.pptwiseIr} but it is absent`, {
      detail: { pptwiseIr: deck.pptwiseIr, dir },
    })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${deck.pptwiseIr} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  const result = IrViewSchema.safeParse(raw)
  if (!result.success) {
    throw new DshPptFailure('ContractViolation', `${deck.pptwiseIr} does not look like pptwise IR: ${describeIssues(result.error.issues).join('; ')}`, {
      detail: { issues: describeIssues(result.error.issues) },
    })
  }
  return { ir: result.data, irPath }
}

/**
 * @param dir - deck workspace.
 * @param deck - validated manifest.
 * @returns absolute paths of the bound theme file and the token file.
 */
export function themePaths(dir: string, deck: FusionDeck): { themePath: string; tokensPath: string; masterPath: string } {
  const themePath = 'preset' in deck.theme ? join(dir, 'theme.json') : join(dir, deck.theme.file)
  return { themePath, tokensPath: join(dir, 'tokens.json'), masterPath: join(dir, 'master-design.json') }
}

/**
 * @param ir - loaded IR view.
 * @param index - 1-based page index.
 * @returns the page's chrome and storyboard role; a missing slide is `content`.
 */
export function irRoleAt(ir: IrView, index: number): ChromeRole {
  const slide = ir.slides[index - 1]
  return chromeRoleFor(slide?.type, typeof slide?.kind === 'string' ? slide.kind : undefined)
}

/**
 * Read a theme document when it is readable.
 *
 * An absent or malformed theme file is a finding the theme gate owns; callers that
 * only need the theme's data (the layout menu, the storyboard skeleton) treat it as
 * absent instead of duplicating that finding.
 *
 * @param path - absolute theme file path.
 * @param fs - filesystem port.
 * @returns the parsed ThemeFile, or null when it is missing or invalid.
 */
export function readThemeDocument(path: string, fs: FileSystemPort): ThemeFile | null {
  const text = fs.readText(path)
  if (text === null) return null
  try {
    return parseThemeFile(JSON.parse(text))
  } catch {
    // Deliberately swallowed: the theme gate reports the malformed file, so the
    // caller only needs to know there is no document to read.
    return null
  }
}

/**
 * Load a deck workspace: manifest, IR, and the token file when it is in sync.
 *
 * @param dir - absolute deck workspace.
 * @param fs - filesystem port.
 * @returns the loaded context; `tokens` is null when the file is absent or stale.
 */
export function loadDeck(dir: string, fs: FileSystemPort): DeckContext {
  const { deck, manifestPath } = readManifest(dir, fs)
  const { ir, irPath } = readIr(dir, deck, fs)
  const { themePath, tokensPath } = themePaths(dir, deck)
  let tokens: TokensFile | null = null
  const themeText = fs.readText(themePath)
  const tokensText = fs.readText(tokensPath)
  if (themeText !== null && tokensText !== null) {
    try {
      const expected = exportTokens(parseThemeFile(JSON.parse(themeText)), { kind: 'preset' })
      const stored = JSON.parse(tokensText) as TokensFile
      if (tokensEqual({ ...expected, source: stored.source }, stored)) tokens = stored
    } catch {
      // A malformed theme or token file leaves `tokens` null; validate reports it.
      tokens = null
    }
  }
  return { dir, deck, manifestPath, ir, irPath, tokens, tokensPath, themePath }
}
