import { basename, extname, join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative, type SourceDispatchType } from '../engine/contracts.ts'
import { assertPublicHttpUrl } from '../policy/url-policy.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'

/** Types `dsh-ppt source` accepts; `auto` lets the input decide. */
export const SOURCE_TYPES = ['auto', 'pdf', 'doc', 'excel', 'pptx', 'web', 'markdown', 'text'] as const

/** A conversion type. */
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Extension → conversion type, mirroring the engine's dispatcher. */
const EXTENSION_TYPES: Readonly<Record<string, SourceType>> = {
  '.pdf': 'pdf',
  '.docx': 'doc',
  '.doc': 'doc',
  '.html': 'doc',
  '.htm': 'doc',
  '.epub': 'doc',
  '.xlsx': 'excel',
  '.xlsm': 'excel',
  '.xls': 'excel',
  '.pptx': 'pptx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
}

/** Largest Markdown document the command accepts from the engine (5 MiB). */
export const SOURCE_MAX_BYTES = 5 * 1024 * 1024

/** One converted input. */
export interface SourceEntry {
  readonly input: string
  readonly type: SourceType
  readonly output: string
  readonly bytes: number
  /** The engine's conversion profile for this input, when it wrote one. */
  readonly profile?: string
}

/** Parameters for `dsh-ppt source`. */
export interface SourceOptions {
  /** Workspace every path resolves against. */
  readonly dir: string
  /** Files, directories or http(s) URLs. */
  readonly inputs: readonly string[]
  /** Output directory, deck-relative; defaults to `sources`. */
  readonly output: string
  /** Forced conversion type; `auto` (the default) uses the extension or URL. */
  readonly type?: SourceType
  /** Keep remote images as links instead of downloading them. */
  readonly noImages?: boolean
  readonly deps: CommandDependencies
  /** DNS resolver seam for the URL policy, injected by tests. */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>
}

/** What one `source` run produced. */
export interface SourceResult {
  readonly outputDir: string
  readonly entries: readonly SourceEntry[]
  readonly manifestPath: string
}

/**
 * @param target - an input path or URL.
 * @returns the conversion type, or null when neither the URL shape nor the extension
 *   identifies one.
 */
export function sourceTypeOf(target: string): SourceType | null {
  if (/^https?:\/\//i.test(target)) return 'web'
  return EXTENSION_TYPES[extname(target).toLowerCase()] ?? null
}

/** @param input - one input path. @returns a safe Markdown stem for it. */
function stemOf(input: string): string {
  const raw = basename(input).replace(/\.[^.]*$/, '')
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe === '' ? 'source' : safe
}

/**
 * Convert source documents into Markdown through the engine's dispatcher.
 *
 * Every local input is proven to live inside the workspace and every URL passes the
 * public-http policy (ADR-039) before a process starts. One engine call per input keeps
 * the output name deterministic and lets a mixed list be reported per entry; the
 * resulting Markdown is size-capped before it is recorded.
 *
 * @param options - workspace, inputs, output directory, type and image policy.
 * @returns the converted entries and the manifest written beside them.
 * @throws DshPptFailure `UsageError` for a refused URL or an unclassifiable input,
 *   `OutputMissing` when an input or the expected Markdown is absent, and
 *   `ContractViolation` when the engine writes more than the source cap.
 */
export async function sourceConvert(options: SourceOptions): Promise<SourceResult> {
  if (options.inputs.length === 0) {
    throw new DshPptFailure('UsageError', 'source needs at least one file, directory or URL', { detail: {} })
  }
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const outputDir = toWorkspaceRelative(dir, resolve(dir, options.output))
  fs.mkdirp(resolve(dir, outputDir))
  const engine = engineFor(dir, options.deps)
  const taken = new Set<string>()
  const entries: SourceEntry[] = []

  const expand = (input: string): string[] => {
    if (/^https?:\/\//i.test(input)) return [input]
    const relativeInput = toWorkspaceRelative(dir, input)
    const absolute = resolve(dir, relativeInput)
    if (fs.isDirectory(absolute)) {
      // One level only: a directory stands for its files, not for nested trees.
      const children = fs.listDir(absolute).filter((name) => !fs.isDirectory(join(absolute, name))).sort()
      if (children.length === 0) throw new DshPptFailure('OutputMissing', `source directory ${relativeInput} holds no file`, { detail: { input: relativeInput } })
      return children.map((name) => `${relativeInput}/${name}`)
    }
    // Classify before the existence check, so an unclassifiable input names that
    // problem even when the file also happens to be absent.
    if ((options.type === undefined || options.type === 'auto') && sourceTypeOf(relativeInput) === null) {
      throw new DshPptFailure('UsageError', `cannot tell how to convert ${relativeInput}; pass --type`, { detail: { input: relativeInput } })
    }
    if (!fs.exists(absolute)) throw new DshPptFailure('OutputMissing', `no source file at ${relativeInput}`, { detail: { input: relativeInput } })
    return [relativeInput]
  }

  for (const raw of options.inputs) {
    for (const input of expand(raw)) {
      const isUrl = /^https?:\/\//i.test(input)
      const dispatcherInput = input
      let type: SourceType
      if (isUrl) {
        await assertPublicHttpUrl(input, options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost })
        type = 'web'
      } else {
        const guessed = sourceTypeOf(input)
        if (guessed === null) {
          throw new DshPptFailure('UsageError', `cannot tell how to convert ${input}; pass --type`, { detail: { input } })
        }
        type = guessed
      }
      if (options.type !== undefined && options.type !== 'auto') {
        if (isUrl && options.type !== 'web') {
          throw new DshPptFailure('UsageError', `--type ${options.type} cannot be used with the URL ${input}`, { detail: { input, type: options.type } })
        }
        if (!isUrl && options.type === 'web') {
          throw new DshPptFailure('UsageError', `--type web needs an http(s) URL; ${input} is a local file`, { detail: { input, type: options.type } })
        }
        type = options.type
      }
      const stem = stemOf(dispatcherInput)
      let unique = stem
      for (let index = 2; taken.has(unique); index += 1) unique = `${stem}-${String(index)}`
      taken.add(unique)
      const outputFile = `${outputDir}/${unique}.md`
      engine.sourceToMarkdown({
        inputs: [dispatcherInput],
        type: type as SourceDispatchType,
        output: outputFile,
        ...(options.noImages === true ? { noImages: true } : {}),
      })
      const text = fs.readText(resolve(dir, outputFile))
      if (text === null || text.trim() === '') {
        throw new DshPptFailure('OutputMissing', `source-to-md wrote no Markdown at ${outputFile}`, { detail: { input: dispatcherInput, output: outputFile } })
      }
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > SOURCE_MAX_BYTES) {
        throw new DshPptFailure('ContractViolation', `${outputFile} is ${String(bytes)} bytes, above the ${String(SOURCE_MAX_BYTES)}-byte source cap`, {
          detail: { output: outputFile, bytes },
        })
      }
      const profile = `${outputDir}/${unique}.conversion_profile.json`
      entries.push({ input: dispatcherInput, type, output: outputFile, bytes, ...(fs.exists(resolve(dir, profile)) ? { profile } : {}) })
    }
  }

  const manifestPath = `${outputDir}/source-manifest.json`
  fs.writeText(resolve(dir, manifestPath), `${JSON.stringify({ schema: 'dsh-ppt-fusion.source-manifest.v1', entries }, null, 2)}\n`)
  return { outputDir, entries, manifestPath }
}
