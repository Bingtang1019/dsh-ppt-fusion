import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { textMeasureCommand, parseBoxOption, formatTextMeasureResult } from './text-measure.ts'
import { defaultDependencies } from './context.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeRunner } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'text-measure')
const dshHome = join(process.cwd(), 'tmp', 'text-measure-dsh')

/** @param handler - answers the engine spawn. @returns dependencies over a healthy fake venv. */
function build(handler: Parameters<typeof createFakeRunner>[0]): { runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem()
  installFakeVenv(fs, { dshHome })
  fs.mkdirp(workspace)
  const runner = createFakeRunner(handler)
  return { runner, deps: defaultDependencies({ fs, runner, cwd: workspace, env: { ...process.env, DSH_HOME: dshHome } }) }
}

describe('textMeasureCommand', () => {
  it('batches single-line measurements through the engine and keeps the order', () => {
    const { runner, deps } = build(() => ok(JSON.stringify([{ text: '标题一', width: 120.5 }, { text: '标题二', width: 98 }])))
    const result = textMeasureCommand({ texts: ['标题一', '标题二'], dir: workspace, sizePt: 24, family: 'MiSans', deps })
    expect(result.mode).toBe('measure')
    expect(result.items.map((item) => item.width)).toEqual([120.5, 98])
    expect(result.fits).toBe(true)
    expect(runner.calls[0]?.args.slice(0, 4)).toEqual(['text-measure', 'measure', '标题一', '标题二'])
    expect(runner.calls[0]?.args).toEqual(expect.arrayContaining(['--size', '24', '--family', 'MiSans', '--json']))
  })

  it('wraps against a box and reports the overflow axis', () => {
    const { runner, deps } = build(() => ok(JSON.stringify({ lines: ['食品质量与安全专业', '认识实习汇报'], widths: [298.2, 112.4], max_width: 300, height: 74.5 })))
    const result = textMeasureCommand({ texts: ['食品质量与安全专业认识实习汇报'], dir: workspace, sizePt: 14, box: { width: 300, height: 60 }, deps })
    expect(result.mode).toBe('wrap')
    expect(result.box).toEqual({ width: 300, height: 60 })
    expect(result.items[0]?.lines).toHaveLength(2)
    expect(result.overflow).toEqual(['y'])
    expect(result.fits).toBe(false)
    const args = runner.calls[0]?.args ?? []
    expect(args.slice(0, 2)).toEqual(['text-measure', 'wrap'])
    expect(args).toEqual(expect.arrayContaining(['--max-width', '300', '--x', '0', '--dy', '17']))
  })

  it('flags horizontal overflow when one word is wider than the box', () => {
    const { deps } = build(() => ok(JSON.stringify({ lines: ['食品质量与安全专业认识实习汇报'], widths: [420], max_width: 300, height: 20 })))
    const result = textMeasureCommand({ texts: ['食品质量与安全专业认识实习汇报'], dir: workspace, sizePt: 14, box: { width: 300, height: 60 }, deps })
    expect(result.overflow).toEqual(['x'])
  })

  it('refuses malformed engine payloads and empty text', () => {
    const { deps } = build(() => ok('no json here'))
    expect(() => textMeasureCommand({ texts: ['x'], dir: workspace, sizePt: 14, deps })).toThrow(/no JSON array/)
    const empty = build(() => ok('[]'))
    expect(() => textMeasureCommand({ texts: [], dir: workspace, sizePt: 14, deps: empty.deps })).toThrow(/at least one text/)
  })

  it('parses boxes and formats the report', () => {
    expect(parseBoxOption('300x60')).toEqual({ width: 300, height: 60 })
    expect(parseBoxOption('300×60')).toEqual({ width: 300, height: 60 })
    expect(() => parseBoxOption('300')).toThrow(/--box/)
    const { deps } = build(() => ok(JSON.stringify([{ text: 'a', width: 10 }])))
    const text = formatTextMeasureResult(textMeasureCommand({ texts: ['a'], dir: workspace, sizePt: 12, deps }))
    expect(text).toContain('text-measure: 1 item(s) at 12 pt')
    expect(text).toContain('no --box given')
  })
})
