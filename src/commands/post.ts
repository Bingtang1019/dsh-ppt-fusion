import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative } from '../engine/contracts.ts'
import { loadDeck } from '../deck.ts'
import { OpcPackage } from '../bridge/opc.ts'
import { applyPost, readPostConfig, type PostReport } from '../bridge/post.ts'
import { applyCompatPass, compatReportHash, serializeCompatReport, type CompatReport } from '../bridge/compat.ts'
import { resolveCompatLevel } from './render.ts'
import { resolveDeckDir, type CommandDependencies } from './context.ts'

/** Parameters for `dsh-ppt post animate`. */
export interface PostAnimateOptions {
  readonly dir: string
  /** Config override, deck-relative; defaults to the manifest's `post.animations`. */
  readonly config?: string
  /** Package to animate, deck-relative; defaults to `out/<name>.pptx`. */
  readonly file?: string
  /** Output package, deck-relative; defaults to the input (replaced atomically). */
  readonly output?: string
  readonly deps: CommandDependencies
}

/** What one `post animate` run produced. */
export interface PostAnimateResult {
  readonly file: string
  readonly outputFile: string
  readonly report: PostReport
  readonly compat: CompatReport
  readonly sha256: string
  readonly bytes: number
  readonly slides: number
}

/**
 * Apply a deck's motion configuration to an already published package.
 *
 * This is the standalone form of the pass `render` runs between the merge and the
 * compat pass (ADR-032): the deck's `post/animations.json` (or `--config`) is applied
 * to `out/<name>.pptx` (or `--file`), the compat pass re-runs at the deck's level, and
 * the package is replaced atomically. `out/compat-report.json` and the compat block of
 * `out/manifest.json` are refreshed so the artifact stays auditable.
 *
 * @param options - deck workspace, config and package overrides.
 * @returns the applied report, the compat report and the new artifact hash.
 * @throws DshPptFailure `OutputMissing` when the config or package is absent,
 *   `ContractViolation` when a selector matches nothing or the compat pass finds an
 *   error, and `PathOutsideWorkspace` for a path outside the deck.
 */
export async function postAnimate(options: PostAnimateOptions): Promise<PostAnimateResult> {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const context = loadDeck(dir, fs)
  const configured = options.config ?? context.deck.post?.animations ?? (fs.exists(join(dir, 'post', 'animations.json')) ? 'post/animations.json' : null)
  if (configured === null) {
    throw new DshPptFailure('OutputMissing', `${dir} declares no post.animations and has no post/animations.json`, { detail: { dir } })
  }
  const configPath = toWorkspaceRelative(dir, resolve(dir, configured))
  const config = readPostConfig(fs, resolve(dir, configPath))
  const file = toWorkspaceRelative(dir, resolve(dir, options.file ?? join('out', `${context.deck.name}.pptx`)))
  const absolute = resolve(dir, file)
  if (!fs.exists(absolute)) {
    throw new DshPptFailure('OutputMissing', `no package to animate at ${file}`, { detail: { file } })
  }
  const bytes = fs.readBytes(absolute)
  if (bytes === null || bytes.length === 0) {
    throw new DshPptFailure('OutputMissing', `package at ${file} is unreadable`, { detail: { file } })
  }
  const pkg = await OpcPackage.read(bytes)
  const report = applyPost(pkg, config)
  if (report.unmatched.length > 0) {
    throw new DshPptFailure('ContractViolation', `post configuration selected shapes that do not exist on slide ${report.unmatched.join(', ')}; check the target names against the published pages`, {
      detail: { unmatched: report.unmatched },
    })
  }
  const level = resolveCompatLevel(undefined, context.deck.compat).level
  const compat = await applyCompatPass(pkg, { level })
  const compatErrors = compat.findings.filter((finding) => finding.level === 'error')
  if (compatErrors.length > 0) {
    throw new DshPptFailure('ContractViolation', `compat pass (${level}) rejected the animated deck: ${compatErrors.map((finding) => finding.message).join('; ')}`, {
      detail: { findings: compatErrors, level },
    })
  }

  const built = await pkg.write()
  const outputFile = toWorkspaceRelative(dir, resolve(dir, options.output ?? file))
  const outputAbsolute = resolve(dir, outputFile)
  fs.mkdirp(resolve(dir, 'out'))
  const temporary = `${outputAbsolute}.tmp`
  fs.writeBytes(temporary, built)
  fs.rename(temporary, outputAbsolute)

  const sha256 = createHash('sha256').update(built).digest('hex')
  const slides = countSlides(pkg)
  fs.writeText(join(dir, 'out', 'compat-report.json'), serializeCompatReport(compat))
  const manifestPath = join(dir, 'out', 'manifest.json')
  const manifestText = fs.readText(manifestPath)
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText) as Record<string, unknown>
      const updated = {
        ...manifest,
        file: outputFile,
        sha256,
        bytes: built.length,
        slides,
        post: report,
        compat: {
          level,
          levelSource: 'post-animate',
          registryVersion: compat.registryVersion,
          report: { file: 'compat-report.json', sha256: compatReportHash(compat) },
          counts: compat.counts,
          applied: compat.applied,
        },
      }
      fs.writeText(manifestPath, `${JSON.stringify(updated, null, 2)}\n`)
    } catch {
      // A corrupt manifest is not this command's finding; the package itself is written.
    }
  }
  return { file, outputFile, report, compat, sha256, bytes: built.length, slides }
}

/** @returns the slide count from `p:sldIdLst`, which the merge preserves. */
function countSlides(pkg: OpcPackage): number {
  return [...pkg.text('ppt/presentation.xml').matchAll(/<p:sldId\b/g)].length
}
