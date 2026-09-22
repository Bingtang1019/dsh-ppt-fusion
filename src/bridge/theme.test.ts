import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createThemeBridge } from './theme.ts'
import { parseFusionDeck, type FusionDeck } from '../schema/fusion.ts'
import { createFrontend } from '../frontend.ts'
import { createFakeFileSystem, createFakeRunner, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise, themeHandler } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise')

const deckOf = (theme: { preset: string } | { file: string }): FusionDeck =>
  parseFusionDeck({
    version: 1,
    name: 'hello',
    pptwiseIr: 'deck.ir.json',
    theme,
    pages: [{ index: 1, route: 'pptwise' }],
  })

function build(options: { fs?: FakeFileSystem; documents?: Record<string, unknown> } = {}) {
  const fs = options.fs ?? createFakeFileSystem({})
  installFakePptwise(fs, { packageDir })
  const runner = createFakeRunner(
    themeHandler(fs, { workspace, documents: options.documents ?? { brief: fakeThemeDocument('brief') } }),
  )
  const frontend = createFrontend({
    cli: { packageDir, cliPath: join(packageDir, 'dist', 'cli.js'), version: '0.35.0' },
    workspace,
    runner,
    env: {},
  })
  return { bridge: createThemeBridge({ workspace, frontend, fs, upstream: '0.35.0' }), fs, runner }
}

describe('theme ensure', () => {
  it('materialises a preset and derives tokens and the master design', () => {
    const { bridge, fs, runner } = build()
    const result = bridge.ensure(deckOf({ preset: 'brief' }))
    expect(runner.callsWith('theme').length).toBe(1)
    expect(result.changed).toEqual([join(workspace, 'theme.json'), join(workspace, 'tokens.json'), join(workspace, 'master-design.json')])
    expect(fs.exists(join(workspace, 'theme.json'))).toBe(true)
    const tokens = JSON.parse(fs.readText(join(workspace, 'tokens.json')) ?? '{}') as { themeId: string; schema: string }
    expect(tokens.themeId).toBe('brief')
    expect(tokens.schema).toBe('dsh-ppt-fusion.tokens.v1')
    const master = JSON.parse(fs.readText(join(workspace, 'master-design.json')) ?? '{}') as { palette: string[] }
    expect(master.palette.length).toBeGreaterThan(5)
  })

  it('is idempotent: a second run writes nothing and does not call upstream again', () => {
    const { bridge, runner } = build()
    bridge.ensure(deckOf({ preset: 'brief' }))
    const callsAfterFirst = runner.calls.length
    const second = bridge.ensure(deckOf({ preset: 'brief' }))
    expect(second.changed).toEqual([])
    expect(runner.calls.length).toBe(callsAfterFirst)
  })

  it('replaces a preset copy whose id no longer matches the binding', () => {
    const fs = createFakeFileSystem({})
    const { bridge } = build({ fs, documents: { brief: fakeThemeDocument('brief'), memo: fakeThemeDocument('memo') } })
    // A stale copy of another theme sits where the preset should be materialised.
    fs.writeText(join(workspace, 'theme.json'), JSON.stringify(fakeThemeDocument('memo')))
    const result = bridge.ensure(deckOf({ preset: 'brief' }))
    expect(result.theme.id).toBe('brief')
    expect(result.changed).toContain(join(workspace, 'theme.json'))
  })

  it('re-exports tokens when the theme palette changed underneath them', () => {
    const fs = createFakeFileSystem({})
    const { bridge } = build({ fs })
    bridge.ensure(deckOf({ preset: 'brief' }))
    const tokensPath = join(workspace, 'tokens.json')
    fs.writeText(tokensPath, JSON.stringify({ schema: 'dsh-ppt-fusion.tokens.v1', themeId: 'brief', colors: {} }))
    const result = bridge.ensure(deckOf({ preset: 'brief' }))
    expect(result.changed).toContain(tokensPath)
  })

  it('uses a bound theme file without calling upstream', () => {
    const fs = createFakeFileSystem({ files: { [join(workspace, 'acme.theme.json')]: JSON.stringify(fakeThemeDocument('acme')) } })
    const { bridge, runner } = build({ fs })
    const result = bridge.ensure(deckOf({ file: 'acme.theme.json' }))
    expect(runner.calls).toHaveLength(0)
    expect(result.tokens.source).toMatchObject({ kind: 'file', path: 'acme.theme.json' })
  })

  it('fails loudly when the bound theme file is absent', () => {
    const { bridge } = build()
    expect(() => bridge.ensure(deckOf({ file: 'missing.theme.json' }))).toThrowError(/absent/)
  })
})
