import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { brandExtract } from './brand.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'brand-deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise-brand')

/** A deck workspace whose fake pptwise writes whatever brand extract should return. */
function build(options: { theme?: unknown } = {}): { fs: FakeFileSystem; runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'out', 'deck.pptx')]: 'ppt-bytes',
      [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: [{ type: 'cover' }] }),
      [join(workspace, 'deck.fusion.json')]: JSON.stringify({
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [{ index: 1, route: 'pptwise' }],
      }),
    },
  })
  const { resolveModule } = installFakePptwise(fs, { packageDir })
  const runner = createFakeRunner((call) => {
    if (call.args[1] === 'brand' && call.args[2] === 'extract') {
      const output = call.args[call.args.indexOf('-o') + 1] ?? ''
      fs.writeText(join(workspace, output), JSON.stringify(options.theme ?? fakeThemeDocument('brand'), null, 2))
      return ok('wrote theme\n')
    }
    return ok()
  })
  return { fs, runner, deps: defaultDependencies({ fs, cwd: workspace, runner, resolveModule }) }
}

describe('brandExtract', () => {
  it('extracts a ThemeFile v2 and reports its id', () => {
    const { fs, deps } = build()
    const result = brandExtract({ dir: workspace, file: 'out/deck.pptx', deps })
    expect(result.themeId).toBe('brand')
    expect(result.bound).toBeNull()
    expect(fs.readText(join(workspace, 'brand.theme.json'))).toContain('"id": "brand"')
  })

  it('binds the theme to a deck and derives its tokens', () => {
    const { fs, runner, deps } = build()
    const result = brandExtract({ dir: workspace, file: 'out/deck.pptx', bind: '.', deps })
    expect(result.bound?.deckDir).toBe('.')
    expect(result.bound?.themeFile).toBe('brand.theme.json')
    const manifest = JSON.parse(fs.readText(join(workspace, 'deck.fusion.json')) ?? 'null') as Record<string, unknown>
    expect(manifest).toMatchObject({ theme: { file: 'brand.theme.json' } })
    expect(fs.readText(join(workspace, 'tokens.json'))).toContain('"brand"')
    const argv = runner.callsWith('brand')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['brand', 'extract', 'out/deck.pptx', '-o', 'brand.theme.json']))
  })

  it('refuses an output that is not a ThemeFile v2', () => {
    const { deps } = build({ theme: { nope: true } })
    expect(() => brandExtract({ dir: workspace, file: 'out/deck.pptx', deps })).toThrow(/not a ThemeFile v2/)
  })
})
