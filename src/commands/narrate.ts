import { join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative, type NarrationProvider } from '../engine/contracts.ts'
import { loadDeck } from '../deck.ts'
import { detectPrimaryLanguage } from '../engine/deep-render.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'

/** Parameters for `dsh-ppt narrate`. */
export interface NarrateOptions {
  readonly dir: string
  /** TTS provider; the engine defaults to `edge`, which needs no key. */
  readonly provider?: NarrationProvider
  readonly voice?: string
  readonly rate?: string
  readonly volume?: string
  /** Audio output directory, deck-relative; the engine decides when omitted. */
  readonly output?: string
  /** Project directory holding the notes; defaults to the newest `.dsh-ppt/deep/*`. */
  readonly project?: string
  /** Also derive `narration_animations.json` from the audio and the page SRTs. */
  readonly sync?: boolean
  readonly deps: CommandDependencies
}

/** What one narration run produced. */
export interface NarrateResult {
  readonly projectDir: string
  readonly provider: NarrationProvider
  /** Audio files the engine wrote, workspace-relative and sorted. */
  readonly audio: readonly string[]
  /** Page-local SRT files the engine wrote, workspace-relative and sorted. */
  readonly subtitles: readonly string[]
  readonly synced: boolean
  readonly stdout: string
}

/**
 * @param deps - command dependencies.
 * @param dir - deck workspace.
 * @returns the curated edge-tts voice list, printed by the engine.
 */
export function narrationVoices(deps: CommandDependencies, dir: string): string {
  const workspace = resolveDeckDir(deps, dir)
  const call = engineFor(workspace, deps).notesToAudio({ projectDir: '.', provider: 'edge', listCommonVoices: true })
  return call.result.stdout
}

/**
 * Generate per-slide narration audio for a deck's deep pages.
 *
 * `notes-to-audio` reads the notes the deep export wrote; `--sync` then runs
 * `narration-sync animations`, which binds page-local SRT timings to the deck's
 * `animations.json` and writes `narration_animations.json` (the plan's "时间线存在").
 * `edge` is the default provider because it needs no API key; other providers are
 * passed through with the engine's own credentials environment.
 *
 * @param options - workspace, provider/voice selection, project override and sync flag.
 * @returns the audio and subtitle files that appeared, and the engine's stdout.
 * @throws DshPptFailure `OutputMissing` when the project or a written file is absent,
 *   `PathOutsideWorkspace` for a path outside the deck.
 */
export function narrate(options: NarrateOptions): NarrateResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const projectDir = options.project === undefined ? newestProject(options.deps, dir) : toWorkspaceRelative(dir, options.project)
  if (projectDir === null || !fs.isDirectory(resolve(dir, projectDir))) {
    throw new DshPptFailure('OutputMissing', `no project to narrate at ${projectDir}; run \`dsh-ppt deep render\` first or pass --project`, {
      detail: { projectDir },
    })
  }
  const notesDir = resolve(dir, projectDir, 'notes')
  const notes = fs.isDirectory(notesDir) ? fs.listDir(notesDir).filter((name) => name.toLowerCase().endsWith('.md')) : []
  if (notes.length === 0) {
    throw new DshPptFailure('OutputMissing', `no narration notes under ${projectDir}/notes; write one Markdown file per exported slide before narrating (${projectDir})`, {
      detail: { projectDir },
    })
  }
  const engine = engineFor(dir, options.deps)
  // `edge` refuses to run without a voice; pick one from the deck's script so a plain
  // `dsh-ppt narrate <deck>` works. Other providers keep the engine's own default and
  // expect an explicit voice id.
  const provider = options.provider ?? 'edge'
  const voice = options.voice ?? (provider === 'edge' ? deckVoice(options.deps, dir, projectDir) : undefined)
  const audioOutput = options.output === undefined ? undefined : toWorkspaceRelative(dir, options.output)
  if (audioOutput !== undefined) fs.mkdirp(resolve(dir, audioOutput))
  const call = engine.notesToAudio({
    projectDir,
    provider,
    ...(voice === undefined ? {} : { voice }),
    ...(options.rate === undefined ? {} : { rate: options.rate }),
    ...(options.volume === undefined ? {} : { volume: options.volume }),
    ...(audioOutput === undefined ? {} : { output: audioOutput }),
  })
  // With `-o` the engine writes the audio there; without it, into the project.
  const audioRoot = audioOutput ?? projectDir
  const audio = listFiles(fs, dir, resolve(dir, audioRoot), /\.(mp3|m4a|wav)$/i)
  if (audio.length === 0) {
    throw new DshPptFailure('OutputMissing', `notes-to-audio reported success but wrote no audio under ${audioRoot}`, {
      detail: { projectDir, audioRoot, stdout: call.result.stdout.slice(-2000) },
    })
  }
  const subtitles = [
    ...listFiles(fs, dir, resolve(dir, projectDir), /\.srt$/i),
    ...(audioOutput === undefined ? [] : listFiles(fs, dir, resolve(dir, audioOutput), /\.srt$/i)),
  ]
  let stdout = call.result.stdout
  if (options.sync === true) {
    const sync = engine.narrationSync({
      mode: 'animations',
      projectDir,
      ...(audioOutput === undefined ? {} : { audioDir: audioOutput }),
    })
    stdout += sync.result.stdout
  }
  return { projectDir, provider, audio, subtitles, synced: options.sync === true, stdout }
}

/**
 * @param deps - command dependencies.
 * @param dir - deck workspace.
 * @param projectDir - project the notes live in, used when the deck has no deep page.
 * @returns the edge voice a plain `narrate` should use: Chinese for a CJK deck, English
 *   otherwise.
 */
function deckVoice(deps: CommandDependencies, dir: string, projectDir: string): string {
  const texts: string[] = []
  try {
    const context = loadDeck(dir, deps.fs)
    for (const page of context.deck.pages) {
      if (page.route !== 'ppt-master') continue
      const svg = deps.fs.readText(join(dir, page.deep.dir, 'page.svg'))
      if (svg !== null) texts.push(svg)
    }
  } catch {
    // A deck that does not load still gets narrated from the project's own SVGs below.
  }
  if (texts.length === 0) {
    for (const name of deps.fs.listDir(join(dir, projectDir)).sort()) {
      if (!name.toLowerCase().endsWith('.svg')) continue
      const svg = deps.fs.readText(join(dir, projectDir, name))
      if (svg !== null) texts.push(svg)
    }
  }
  return detectPrimaryLanguage(texts).startsWith('zh') ? 'zh-CN-XiaoxiaoNeural' : 'en-US-JennyNeural'
}

/** @returns the newest project directory under `.dsh-ppt/deep`, or null when none exists. */
function newestProject(deps: CommandDependencies, dir: string): string | null {
  const root = join(dir, '.dsh-ppt', 'deep')
  if (!deps.fs.isDirectory(root)) return null
  const projects = deps.fs.listDir(root).filter((name) => deps.fs.isDirectory(join(root, name))).sort()
  const newest = projects[projects.length - 1]
  return newest === undefined ? null : `.dsh-ppt/deep/${newest}`
}

/** @returns the files under `root`, recursively, that match `pattern`, workspace-relative. */
function listFiles(fs: CommandDependencies['fs'], dir: string, root: string, pattern: RegExp): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const name of fs.listDir(current).sort()) {
      const path = join(current, name)
      if (fs.isDirectory(path)) {
        walk(path)
        continue
      }
      if (pattern.test(name)) found.push(path.replace(dir, '').replace(/^[\\/]/, '').replace(/\\/g, '/'))
    }
  }
  walk(root)
  return found.sort()
}
