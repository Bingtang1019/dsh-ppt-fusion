import { join, relative } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { assertInsideWorkspace } from '../engine/contracts.ts'
import { loadDeck } from '../deck.ts'
import { frontendFor, resolveDeckDir, type CommandDependencies } from './context.ts'

/** Options for `dsh-ppt preview`. */
export interface PreviewOptions {
  readonly dir: string
  /** Output directory, deck-relative; defaults to `.dsh-ppt/preview`. */
  readonly output?: string
  /** Also write the self-contained `preview.html` viewer. */
  readonly html: boolean
  readonly deps: CommandDependencies
}

/** One page in the preview manifest. */
export interface PreviewPage {
  readonly index: number
  readonly file: string
  readonly deep: boolean
}

/** What one `dsh-ppt preview` run wrote. */
export interface PreviewResult {
  /** Deck-relative output directory. */
  readonly outputDir: string
  readonly manifestPath: string
  /** Deck-relative viewer file, or null when `--html` was not requested. */
  readonly htmlFile: string | null
  readonly pages: readonly PreviewPage[]
  /** Deep pages whose authored SVG replaced pptwise's placeholder. */
  readonly overlaid: readonly number[]
  /** Deep pages that stayed placeholders because no authored SVG exists yet. */
  readonly placeholders: readonly number[]
  /** True when the viewer HTML was rewritten to match the overlaid pages. */
  readonly htmlPatched: boolean
}

/** One page entry of the pptwise preview manifest, as read from disk. */
interface ManifestPage {
  page?: unknown
  file?: unknown
  placeholder?: unknown
  deep?: unknown
}

/**
 * Render a deck to SVG pages for review.
 *
 * Standard pages come from pptwise `preview` over the deck's IR. Deep pages are
 * authored SVGs, so each placeholder the front end drew is replaced by the file
 * that will be exported, and the self-contained viewer is patched in place when
 * its inline markup still matches.
 *
 * @param options - deck directory, output directory, viewer switch and dependencies.
 * @returns what was written, which pages came from the deep engine and which are still placeholders.
 * @throws DshPptFailure `OutputMissing` when pptwise writes no manifest,
 *   `ContractViolation` when it is not JSON, `PathOutsideWorkspace` for an output
 *   directory outside the deck.
 */
export function previewDeck(options: PreviewOptions): PreviewResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const context = loadDeck(dir, fs)
  const outputDir = assertInsideWorkspace(dir, options.output ?? join('.dsh-ppt', 'preview'), 'output')
  const outputRelative = relative(dir, outputDir).replace(/\\/g, '/')
  frontendFor(dir, options.deps).preview(context.deck.pptwiseIr, { output: outputRelative, html: options.html })

  const manifestPath = join(outputDir, 'manifest.json')
  const manifestText = fs.readText(manifestPath)
  if (manifestText === null) {
    throw new DshPptFailure('OutputMissing', `preview wrote no manifest at ${outputRelative}/manifest.json`, {
      detail: { dir, output: outputRelative, project: context.deck.pptwiseIr },
    })
  }
  let manifest: { pages?: ManifestPage[] }
  try {
    manifest = JSON.parse(manifestText) as { pages?: ManifestPage[] }
  } catch (error) {
    throw new DshPptFailure('ContractViolation', `${outputRelative}/manifest.json is not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      detail: { path: `${outputRelative}/manifest.json` },
    })
  }
  const entries = manifest.pages ?? []

  const deepByIndex = new Map<number, string>()
  for (const page of context.deck.pages) {
    if (page.route === 'ppt-master') deepByIndex.set(page.index, page.deep.dir)
  }

  let viewer = options.html ? fs.readText(join(outputDir, 'preview.html')) : null
  let htmlPatched = false
  const overlaid: number[] = []
  const placeholders: number[] = []
  const pages: PreviewPage[] = []
  for (const entry of entries) {
    const index = typeof entry.page === 'number' ? entry.page : 0
    const file = typeof entry.file === 'string' ? entry.file : ''
    const deepDir = deepByIndex.get(index)
    if (deepDir !== undefined) {
      const authored = fs.readText(join(dir, deepDir, 'page.svg'))
      const target = join(outputDir, file)
      const drawn = fs.readText(target)
      if (authored !== null) {
        fs.writeText(target, authored)
        delete entry.placeholder
        entry.deep = true
        overlaid.push(index)
        if (viewer !== null && drawn !== null) {
          const before = svgMarkup(drawn)
          const after = svgMarkup(authored)
          if (before !== null && after !== null) {
            const at = viewer.indexOf(before)
            if (at >= 0) {
              viewer = `${viewer.slice(0, at)}${after}${viewer.slice(at + before.length)}`
              htmlPatched = true
            }
          }
        }
      } else {
        placeholders.push(index)
      }
    }
    pages.push({ index, file, deep: deepDir !== undefined })
  }
  fs.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  if (viewer !== null && htmlPatched) fs.writeText(join(outputDir, 'preview.html'), viewer)

  return {
    outputDir: outputRelative,
    manifestPath: `${outputRelative}/manifest.json`,
    htmlFile: options.html ? `${outputRelative}/preview.html` : null,
    pages,
    overlaid,
    placeholders,
    htmlPatched,
  }
}

/** @returns the first complete `<svg>…</svg>` element, or null. */
function svgMarkup(text: string): string | null {
  return /<svg[\s\S]*<\/svg>/.exec(text)?.[0] ?? null
}

/** @param result - the finished preview. @returns the one-line CLI receipt. */
export function formatPreviewResult(result: PreviewResult): string {
  const deep = result.overlaid.length === 0 ? '' : `, ${String(result.overlaid.length)} deep page(s) overlaid`
  const pending = result.placeholders.length === 0 ? '' : `, ${String(result.placeholders.length)} placeholder(s) left`
  const viewer = result.htmlFile === null ? '' : `, viewer ${result.htmlFile}${result.htmlPatched ? ' (deep pages patched in)' : ''}`
  return `wrote ${String(result.pages.length)} page(s) to ${result.outputDir}${deep}${pending}${viewer}`
}
