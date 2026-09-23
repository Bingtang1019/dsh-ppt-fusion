import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { designProfileExtract } from '../engine/contracts.ts'
import { buildEnv } from '../engine/runner.ts'
import { packageAsset } from '../package-paths.ts'
import { parseDesignProfile, type DesignProfile } from '../schema/design-profile.ts'
import { loggedRunnerFor, venvManagerFor, type CommandDependencies } from './context.ts'

/**
 * `dsh-ppt design profile extract`: read the numeric design system out of one
 * reference `.pptx` (V7.2 B1).
 *
 * The extractor runs under the engine venv's Python because that is where
 * `python-pptx` lives. It writes only colours, fonts, sizes and geometry; the
 * reference deck's text, media and path never reach the profile, so nothing the
 * profile carries can leak a deck into the repository or the package.
 */

/** Options for `dsh-ppt design profile extract`. */
export interface DesignProfileExtractOptions {
  /** Reference deck; absolute or resolved against `dir`. */
  readonly file: string
  /** Output profile; absolute or resolved against `dir`; defaults to `design-profile.json`. */
  readonly output?: string
  /** Role overrides handed to the extractor, e.g. `cover=1;content=2,3`. */
  readonly roles?: string
  /**
   * Copy the deck's media under `<output dir>/.dsh-ppt/design-media`. Off by
   * default; the target is an ignored scratch directory, never beside the profile.
   */
  readonly copyMedia?: boolean
  /** Directory the input and output resolve against; defaults to the process cwd. */
  readonly dir?: string
  readonly deps: CommandDependencies
}

/** What one profile extraction produced. */
export interface DesignProfileExtractResult {
  readonly input: string
  readonly outputFile: string
  readonly mediaCopied: number
  readonly profile: DesignProfile
}

/**
 * Extract a design profile from a reference deck.
 *
 * @param options - reference deck, output path, role overrides and dependencies.
 * @returns the written profile path, the media count and the parsed profile.
 * @throws DshPptFailure `OutputMissing` when the deck or the produced profile is
 *   absent, `VenvMissing` when the engine venv cannot supply python-pptx,
 *   `EngineExit` when the extractor fails, `ContractViolation` for a bad output
 *   path or an invalid profile document.
 */
export function extractDesignProfile(options: DesignProfileExtractOptions): DesignProfileExtractResult {
  const { deps } = options
  const base = resolve(options.dir ?? deps.cwd)
  const input = isAbsolute(options.file) ? options.file : resolve(base, options.file)
  if (!deps.fs.exists(input)) {
    throw new DshPptFailure('OutputMissing', `the reference deck is not readable: ${input}`, { detail: { input } })
  }
  const requested = options.output ?? 'design-profile.json'
  const outputFile = isAbsolute(requested) ? requested : resolve(base, requested)
  if (!outputFile.toLowerCase().endsWith('.json')) {
    throw new DshPptFailure('ContractViolation', `the profile output must be a .json file: ${outputFile}`, { detail: { outputFile } })
  }
  const mediaDir = options.copyMedia === true ? join(dirname(outputFile), '.dsh-ppt', 'design-media') : undefined
  const venv = venvManagerFor(deps)
  const state = venv.state()
  if (!state.ok) {
    throw new DshPptFailure('VenvMissing', `the engine venv cannot run the extractor: ${state.problems.join('; ')}; run \`dsh-ppt doctor --repair\``, {
      detail: { venv: state.paths.root, problems: state.problems },
    })
  }
  const invocation = designProfileExtract({
    scriptPath: packageAsset('python-assets/scripts/design-profile.py'),
    input,
    output: outputFile,
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(mediaDir === undefined ? {} : { copyMedia: mediaDir }),
  })
  const runner = loggedRunnerFor(dirname(outputFile), deps)
  const result = runner(state.paths.pythonExe, [...invocation.argv], {
    cwd: base,
    timeoutMs: invocation.timeoutMs,
    env: buildEnv({ source: deps.env, extra: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }),
  })
  if (result.status !== 0) {
    const tail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).filter((line) => line !== '').slice(-3).join(' | ')
    throw new DshPptFailure('EngineExit', `design-profile exited ${String(result.status)}: ${tail}`, {
      detail: { status: result.status, stdout: result.stdout, stderr: result.stderr },
    })
  }
  const text = deps.fs.readText(outputFile)
  if (text === null || text.trim() === '') {
    throw new DshPptFailure('OutputMissing', `the extractor exited 0 but did not write ${outputFile}`, { detail: { outputFile } })
  }
  const profile = parseDesignProfile(JSON.parse(text) as unknown)
  const mediaCopied = mediaDir === undefined || !deps.fs.isDirectory(mediaDir) ? 0 : deps.fs.listDir(mediaDir).length
  return { input, outputFile, mediaCopied, profile }
}

/**
 * @param result - one extraction.
 * @returns the human-readable summary the CLI prints without `--json`.
 */
export function formatDesignProfile(result: DesignProfileExtractResult): string {
  const { profile } = result
  const lines = [
    `design profile: ${result.outputFile}`,
    `  canvas ${String(profile.canvas.widthEmu)}x${String(profile.canvas.heightEmu)} EMU; background ${profile.background.mode} (overlay ${String(profile.background.overlayOpacity)})`,
    `  palette ${Object.entries(profile.palette).map(([name, value]) => `${name}=${value}`).join(' ')}`,
    `  fonts heading=${profile.fonts.heading} body=${profile.fonts.body} number=${profile.fonts.number}`,
  ]
  for (const [role, style] of Object.entries(profile.typeScale)) {
    if (style === undefined) continue
    const body = style.body === undefined ? '' : ` body=${String(style.body.sizePt)}pt/${style.body.color}`
    lines.push(`  type ${role}: title=${String(style.title.sizePt)}pt/${style.title.color}/${style.title.font}${body}`)
  }
  for (const [role, geometry] of Object.entries(profile.roles)) {
    if (geometry === undefined) continue
    const gap = geometry.cardGapIn === undefined ? '' : ` gap=${String(geometry.cardGapIn)}in`
    const watermark = geometry.watermarkSizePt === undefined ? '' : ` watermark=${String(geometry.watermarkSizePt)}pt`
    lines.push(`  geom ${role}: title=(${String(geometry.titlePos.x)},${String(geometry.titlePos.y)}) columns=${String(geometry.columns)}${gap}${watermark}`)
  }
  lines.push(`  chrome sectionMarker=${String(profile.chrome.sectionMarker)} metaFooter=${String(profile.chrome.metaFooter)} pageNumber=${String(profile.chrome.pageNumber)}`)
  if (result.mediaCopied > 0) lines.push(`  media copied: ${String(result.mediaCopied)} file(s)`)
  return lines.join('\n')
}
