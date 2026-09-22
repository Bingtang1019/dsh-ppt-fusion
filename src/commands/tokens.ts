import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { masterDesign, exportTokens, parseThemeFile, type MasterDesign, type TokensFile } from '../schema/tokens.ts'
import { toJsonDocument } from '../bridge/theme.ts'
import { frontendFor, type CommandDependencies } from './context.ts'

/** Result of `tokens export`. */
export interface TokensExportResult {
  /** The document that was produced: tokens, or the master projection. */
  readonly document: TokensFile | MasterDesign
  /** Absolute path written with `-o`; null when the document goes to stdout. */
  readonly outputFile: string | null
}

/**
 * @param input - a `tokens export` argument.
 * @returns true when the argument names a factory preset rather than a file.
 */
export function isPresetId(input: string): boolean {
  return !input.includes('/') && !input.includes('\\') && !input.toLowerCase().endsWith('.json')
}

/**
 * Export the palette contract for a preset or a theme file.
 *
 * A preset is materialised through the upstream CLI into a temporary directory
 * first, because only a complete ThemeFile carries the fonts, shape and
 * background groups a deep page needs.
 *
 * @param options.input - preset id or theme file path.
 * @param options.master - emit the master projection instead of the raw tokens.
 * @param options.output - write the document here instead of returning it.
 * @param options.deps - command dependencies.
 * @returns the document and, when `-o` was given, the path written.
 */
export function tokensExport(options: {
  input: string
  master?: boolean
  output?: string
  deps: CommandDependencies
}): TokensExportResult {
  const { deps } = options
  let tokens: TokensFile
  if (isPresetId(options.input)) {
    // The front end runs the CLI with this directory as its cwd, so it has to
    // exist before the first spawn.
    const dir = join(tmpdir(), `dsh-ppt-tokens-${options.input}`)
    deps.fs.mkdirp(dir)
    const written = frontendFor(dir, deps).themeNew({ from: options.input, output: 'theme.json', id: options.input })
    const text = deps.fs.readText(written.outputFile)
    if (text === null) throw new Error(`the upstream CLI did not write ${written.outputFile}`)
    tokens = exportTokens(parseThemeFile(JSON.parse(text)), { kind: 'preset', preset: options.input })
  } else {
    const path = deps.fs.exists(options.input) ? options.input : join(deps.cwd, options.input)
    const text = deps.fs.readText(path)
    if (text === null) throw new Error(`theme file not found: ${path}`)
    tokens = exportTokens(parseThemeFile(JSON.parse(text)), { kind: 'file', path: options.input })
  }

  const document: TokensFile | MasterDesign = options.master === true ? masterDesign(tokens) : tokens
  if (options.output === undefined) return { document, outputFile: null }
  deps.fs.writeText(options.output, toJsonDocument(document))
  return { document, outputFile: options.output }
}
