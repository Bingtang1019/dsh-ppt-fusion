import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { narrate, narrationVoices } from './narrate.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'

const workspace = join(process.cwd(), 'tmp', 'narrate-deck')
const dshHome = join(process.cwd(), 'tmp', 'narrate-dsh')
const project = '.dsh-ppt/deep/deck-p01_ppt169_20260922'

/** A deck with one deep project whose notes roster is either present or empty. */
function build(options: { notes?: boolean } = {}): { fs: FakeFileSystem; runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const files: Record<string, string> = {
    [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: [{ type: 'cover', placeholder: true }] }),
    [join(workspace, 'deck.fusion.json')]: JSON.stringify({
      version: 1,
      name: 'deck',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'ppt-master', deep: { dir: 'deep/p01', kind: 'native-chart', format: 'ppt169' } }],
    }),
    [join(workspace, 'deep', 'p01', 'page.svg')]: '<svg xmlns="http://www.w3.org/2000/svg"><text>世界你好，这是中文旁白</text></svg>',
    [join(workspace, project, 'svg_output', '001-deck.svg')]: '<svg/>',
    ...(options.notes === false ? {} : { [join(workspace, project, 'notes', '001-deck.md')]: '# Slide 1\n\nHello narration.' }),
  }
  const fs = createFakeFileSystem({ files })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => {
    if (call.args[0] === 'notes-to-audio') {
      const output = call.args.includes('-o') ? (call.args[call.args.indexOf('-o') + 1] ?? '') : 'exports/audio'
      fs.writeText(join(workspace, output, '001-deck.mp3'), 'mp3-bytes')
      fs.writeText(join(workspace, project, 'notes', '001-deck.srt'), '1\n00:00:00,000 --> 00:00:02,000\nHello narration.\n')
      return ok('generated 1 audio file\n')
    }
    if (call.args[0] === 'narration-sync') return ok('wrote narration_animations.json\n')
    return ok()
  })
  return { fs, runner, deps: defaultDependencies({ fs, cwd: workspace, env: { DSH_HOME: dshHome }, runner }) }
}

describe('narrate', () => {
  it('defaults the voice from the deck script and reports the audio it wrote', () => {
    const { fs, runner, deps } = build()
    const result = narrate({ dir: workspace, output: 'assets/audio', deps })
    expect(result.provider).toBe('edge')
    expect(result.projectDir).toBe(project)
    expect(result.audio).toEqual(['assets/audio/001-deck.mp3'])
    expect(result.subtitles).toEqual([`${project}/notes/001-deck.srt`])
    const argv = runner.callsWith('notes-to-audio')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['notes-to-audio', project, '--provider', 'edge', '--voice', 'zh-CN-XiaoxiaoNeural', '-o', 'assets/audio']))
    expect(fs.exists(join(workspace, 'assets', 'audio', '001-deck.mp3'))).toBe(true)
  })

  it('runs narration-sync animations when --sync is set', () => {
    const { runner, deps } = build()
    const result = narrate({ dir: workspace, sync: true, output: 'assets/audio', deps })
    expect(result.synced).toBe(true)
    const argv = runner.callsWith('narration-sync')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['narration-sync', 'animations', '--audio-dir', 'assets/audio', project]))
  })

  it('refuses a project without a notes roster and a deck without a deep project', () => {
    const noNotes = build({ notes: false })
    expect(() => narrate({ dir: workspace, deps: noNotes.deps })).toThrow(/no narration notes/)

    const missing = build()
    missing.fs.removeTree(join(workspace, project))
    expect(() => narrate({ dir: workspace, deps: missing.deps })).toThrow(/no project to narrate/)
  })

  it('prints the curated voice list without touching the project', () => {
    const { runner, deps } = build()
    const runnerWithList = createFakeRunner((call) => {
      if (call.args.includes('--list-common-voices')) return ok('Common edge-tts voices:\nzh-CN  zh-CN-XiaoxiaoNeural\n')
      return ok()
    })
    const voices = narrationVoices({ ...deps, runner: runnerWithList }, workspace)
    expect(voices).toContain('zh-CN-XiaoxiaoNeural')
    expect(runner.callsWith('notes-to-audio')).toHaveLength(0)
  })
})
