import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { extractDesignProfile, formatDesignProfile } from './design.ts'
import { defaultDependencies } from './context.ts'
import { venvPaths } from '../engine/venv.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { createFakeFileSystem, createFakeRunner, fail, ok, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'design')
const dshHome = join(process.cwd(), 'tmp', 'design-dsh')
const paths = venvPaths(dshHome, '0.1.128', '3.13')

/** A minimal valid profile the fake extractor writes. */
const PROFILE = {
  version: 1,
  canvas: { widthEmu: 12192000, heightEmu: 6858000 },
  palette: { bg: '#FFFFFF', title: '#0D0D0D', accent: '#577FD2', body: '#262626', muted: '#595959', watermark: '#F2F7FA', onAccent: '#FFFFFF' },
  fonts: { heading: 'MiSans', body: 'MiSans', number: 'Noto Sans SC' },
  typeScale: { cover: { title: { sizePt: 44, bold: true, color: '#000000', font: 'MiSans' } } },
  roles: { cover: { titlePos: { x: 0.69, y: 3.08 }, columns: 1 } },
  chrome: { sectionMarker: true, metaFooter: true, pageNumber: false },
  background: { mode: 'photo', overlayOpacity: 0.15 },
}

/** Build a workspace with a healthy venv, a reference deck and a scripted extractor. */
function build(options: { profile?: unknown; status?: number; health?: boolean } = {}): {
  fs: FakeFileSystem
  deps: ReturnType<typeof defaultDependencies>
  calls: { command: string; args: readonly string[] }[]
} {
  const files: Record<string, string> = {
    [join(workspace, 'ref.pptx')]: 'PK',
  }
  if (options.health !== false) {
    files[paths.pythonExe] = 'binary'
    files[paths.engineExe] = 'binary'
    files[join(paths.sitePackages, 'ppt_master-0.1.128.dist-info', 'METADATA')] = 'Name: ppt-master\n'
  }
  const fs = createFakeFileSystem({ files, directories: options.health === false ? [] : [paths.root] })
  const calls: { command: string; args: readonly string[] }[] = []
  const runner = createFakeRunner((call) => {
    calls.push({ command: call.command, args: call.args })
    if (options.status !== undefined && options.status !== 0) return fail(options.status, 'extractor exploded')
    const output = call.args[call.args.indexOf('--output') + 1] ?? ''
    if (output !== '') fs.writeText(output, JSON.stringify(options.profile ?? PROFILE))
    return ok(JSON.stringify({ output, mediaCopied: 0 }))
  })
  const deps = defaultDependencies({ fs, runner, cwd: workspace, env: { ...process.env, DSH_HOME: dshHome } })
  return { fs, deps, calls }
}

describe('extractDesignProfile', () => {
  it('runs the extractor under the venv python and returns the parsed profile', () => {
    const { deps, calls } = build()
    const result = extractDesignProfile({ file: 'ref.pptx', deps })
    expect(result.outputFile).toBe(join(workspace, 'design-profile.json'))
    expect(result.profile.fonts.number).toBe('Noto Sans SC')
    expect(result.mediaCopied).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(paths.pythonExe)
    expect(calls[0]?.args[0]).toContain('design-profile.py')
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--input', join(workspace, 'ref.pptx'), '--output', join(workspace, 'design-profile.json')]))
    expect(calls[0]?.args).not.toContain('--copy-media')
  })

  it('keeps media copies in the ignored scratch directory only when asked', () => {
    const { deps, calls } = build()
    extractDesignProfile({ file: 'ref.pptx', output: 'out/profile.json', copyMedia: true, deps })
    const index = calls[0]?.args.indexOf('--copy-media') ?? -1
    expect(index).toBeGreaterThan(-1)
    expect(calls[0]?.args[index + 1]).toBe(join(workspace, 'out', '.dsh-ppt', 'design-media'))
  })

  it('reports the profile summary without JSON', () => {
    const { deps } = build()
    const text = formatDesignProfile(extractDesignProfile({ file: 'ref.pptx', deps }))
    expect(text).toContain('palette')
    expect(text).toContain('fonts heading=MiSans')
    expect(text).toContain('type cover: title=44pt/#000000/MiSans')
  })

  it('refuses a missing deck, a non-JSON output and an unusable venv', () => {
    const missing = build()
    expect(failureCode(() => extractDesignProfile({ file: 'nope.pptx', deps: missing.deps }))).toBe('OutputMissing')
    const badOutput = build()
    expect(failureCode(() => extractDesignProfile({ file: 'ref.pptx', output: 'profile.txt', deps: badOutput.deps }))).toBe('ContractViolation')
    const unhealthy = build({ health: false })
    expect(failureCode(() => extractDesignProfile({ file: 'ref.pptx', deps: unhealthy.deps }))).toBe('VenvMissing')
  })

  it('fails the run when the extractor exits non-zero or writes an invalid profile', () => {
    const failed = build({ status: 3 })
    expect(failureCode(() => extractDesignProfile({ file: 'ref.pptx', deps: failed.deps }))).toBe('EngineExit')
    const invalid = build({ profile: { version: 1 } })
    expect(failureCode(() => extractDesignProfile({ file: 'ref.pptx', deps: invalid.deps }))).toBe('ContractViolation')
  })
})

/** @returns the DshPptFailure code of `run`, or a marker when it did not throw one. */
function failureCode(run: () => unknown): string {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}
