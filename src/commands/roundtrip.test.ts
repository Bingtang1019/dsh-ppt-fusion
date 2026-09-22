import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { deepNativeRoundtrip } from './roundtrip.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'

const workspace = join(process.cwd(), 'tmp', 'roundtrip-deck')
const dshHome = join(process.cwd(), 'tmp', 'roundtrip-dsh')

/** A deck workspace with one pptx, a fake venv and a scripted round-trip. */
function build(options: { writeSlides?: boolean } = {}): { fs: FakeFileSystem; runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({ files: { [join(workspace, 'out', 'deck.pptx')]: 'ppt-bytes' } })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => {
    if (call.args.includes('pptx-to-svg') && options.writeSlides !== false) {
      const output = call.args[call.args.indexOf('-o') + 1] ?? ''
      for (const name of ['slide_01.svg', 'slide_02.svg']) {
        fs.writeText(join(workspace, output, 'authoring-svg-flat', name), '<svg/>')
      }
      return ok('converted 2 slides\n')
    }
    return ok()
  })
  return { fs, runner, deps: defaultDependencies({ fs, cwd: workspace, env: { DSH_HOME: dshHome }, runner }) }
}

describe('deepNativeRoundtrip', () => {
  it('imports into .dsh-ppt/roundtrip and returns the editable SVGs', () => {
    const { runner, deps } = build()
    const result = deepNativeRoundtrip({ dir: workspace, file: 'out/deck.pptx', deps })
    expect(result.outputDir).toBe('.dsh-ppt/roundtrip/deck')
    expect(result.slides).toEqual([
      '.dsh-ppt/roundtrip/deck/authoring-svg-flat/slide_01.svg',
      '.dsh-ppt/roundtrip/deck/authoring-svg-flat/slide_02.svg',
    ])
    const calls = runner.callsWith('--roundtrip')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['pptx-to-svg', 'out/deck.pptx', '-o', '.dsh-ppt/roundtrip/deck', '--inheritance-mode', 'both', '--roundtrip']),
    )
  })

  it('honours an explicit output directory and the strict/keep-hidden flags', () => {
    const { runner, deps } = build()
    const result = deepNativeRoundtrip({ dir: workspace, file: 'out/deck.pptx', output: 'imports/edited', keepHidden: true, strict: true, deps })
    expect(result.outputDir).toBe('imports/edited')
    expect(runner.callsWith('--keep-hidden')[0]?.args).toEqual(expect.arrayContaining(['--keep-hidden', '--strict']))
  })

  it('refuses a missing input and a run that wrote no SVG', () => {
    const { deps } = build()
    expect(() => deepNativeRoundtrip({ dir: workspace, file: 'out/missing.pptx', deps })).toThrow(/no pptx/)
    const silent = build({ writeSlides: false })
    expect(() => deepNativeRoundtrip({ dir: workspace, file: 'out/deck.pptx', deps: silent.deps })).toThrow(/wrote no editable SVG/)
  })
})
