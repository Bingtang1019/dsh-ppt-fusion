import { join } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { exportTokens, masterDesign, parseThemeFile, tokensEqual, type MasterDesign, type ThemeFile, type TokensFile } from '../schema/tokens.ts'
import { themePaths } from '../deck.ts'
import type { FusionDeck } from '../schema/fusion.ts'
import type { FileSystemPort } from '../engine/venv.ts'
import type { Frontend } from '../frontend.ts'

/** What a bridge operation wrote, so callers can report "0 changes" honestly. */
export interface BridgeResult {
  readonly themePath: string
  readonly tokensPath: string
  readonly masterPath: string
  /** Absolute paths written or rewritten during this call; empty means no change. */
  readonly changed: string[]
  readonly theme: ThemeFile
  readonly tokens: TokensFile
  readonly master: MasterDesign
}

/** Serialize JSON the way every file in a deck workspace is written. */
export function toJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Create the theme bridge.
 *
 * The bridge never edits a theme file: `theme ensure` only materialises a preset
 * through the pptwise CLI, and every derived file (`tokens.json`,
 * `master-design.json`) is regenerated from it. A second run over an unchanged
 * deck writes nothing, which is what makes `theme ensure` idempotent.
 *
 * @param options.workspace - deck workspace.
 * @param options.frontend - pptwise front end used to materialise presets.
 * @param options.fs - filesystem port.
 * @param options.upstream - upstream pptwise version recorded in the token source.
 * @returns the bridge operations used by `theme ensure` and `tokens export`.
 */
export function createThemeBridge(options: {
  workspace: string
  frontend: Frontend
  fs: FileSystemPort
  upstream: string
}) {
  const { fs } = options

  const readTheme = (path: string): ThemeFile => {
    const text = fs.readText(path)
    if (text === null) throw new DshPptFailure('OutputMissing', `theme file is absent: ${path}`, { detail: { path } })
    try {
      return parseThemeFile(JSON.parse(text))
    } catch (error) {
      throw new DshPptFailure('ContractViolation', `theme file is not a ThemeFile v2: ${error instanceof Error ? error.message : String(error)}`, {
        detail: { path },
        cause: error,
      })
    }
  }

  /** Materialise a preset into `theme.json` unless a matching file is already there. */
  const materialise = (preset: string, themePath: string): { theme: ThemeFile; changed: boolean } => {
    const existing = fs.readText(themePath)
    if (existing !== null) {
      try {
        const parsed = parseThemeFile(JSON.parse(existing))
        if (parsed.id === preset) return { theme: parsed, changed: false }
      } catch {
        // An unreadable preset copy is replaced below rather than trusted.
      }
    }
    options.frontend.themeNew({ from: preset, output: relativeToWorkspace(options.workspace, themePath), id: preset })
    if (fs.readText(themePath) === null) {
      throw new DshPptFailure('OutputMissing', `pptwise did not write the theme file at ${themePath}`, { detail: { themePath, preset } })
    }
    return { theme: readTheme(themePath), changed: true }
  }

  /**
   * Bring a deck's theme files to the state its manifest asks for.
   *
   * @param deck - validated manifest.
   * @returns the paths, what changed, and the derived documents.
   */
  const ensure = (deck: FusionDeck): BridgeResult => {
    const paths = themePaths(options.workspace, deck)
    const changed: string[] = []
    let theme: ThemeFile
    if ('preset' in deck.theme) {
      const materialised = materialise(deck.theme.preset, paths.themePath)
      theme = materialised.theme
      if (materialised.changed) changed.push(paths.themePath)
    } else {
      theme = readTheme(paths.themePath)
    }
    const tokens = exportTokens(
      theme,
      'preset' in deck.theme
        ? { kind: 'preset', preset: deck.theme.preset, upstream: options.upstream }
        : { kind: 'file', path: deck.theme.file, upstream: options.upstream },
    )
    const master = masterDesign(tokens)

    const storedTokens = fs.readText(paths.tokensPath)
    if (storedTokens === null || !tokensEqual(JSON.parse(storedTokens), tokens)) {
      fs.writeText(paths.tokensPath, toJsonDocument(tokens))
      changed.push(paths.tokensPath)
    }
    const storedMaster = fs.readText(paths.masterPath)
    if (storedMaster === null || !tokensEqual(JSON.parse(storedMaster), master)) {
      fs.writeText(paths.masterPath, toJsonDocument(master))
      changed.push(paths.masterPath)
    }
    return { ...paths, changed, theme, tokens, master }
  }

  return { ensure, readTheme, materialise }
}

/** @returns `path` relative to the workspace with forward slashes, for CLI arguments. */
function relativeToWorkspace(workspace: string, path: string): string {
  const normalizedWorkspace = workspace.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedPath = path.replace(/\\/g, '/')
  return normalizedPath.startsWith(`${normalizedWorkspace}/`) ? normalizedPath.slice(normalizedWorkspace.length + 1) : normalizedPath
}

/** @returns the default token file path inside a deck workspace. */
export function deckTokensPath(dir: string): string {
  return join(dir, 'tokens.json')
}
