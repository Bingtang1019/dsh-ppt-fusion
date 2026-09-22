import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isPresetId, tokensExport } from './tokens.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise, themeHandler } from '../../tests/support/fake-pptwise.ts'

const cwd = join(process.cwd(), 'tmp', 'cwd')

describe('isPresetId', () => {
  it('treats a bare name as a preset and anything path-like as a file', () => {
    expect(isPresetId('brief')).toBe(true)
    expect(isPresetId('themes/acme.theme.json')).toBe(false)
    expect(isPresetId('acme.theme.json')).toBe(false)
    expect(isPresetId('C:\\themes\\acme.json')).toBe(false)
  })
})

describe('tokensExport', () => {
  it('materialises a preset and exports its tokens', () => {
    const fs = createFakeFileSystem({})
    const { resolveModule } = installFakePptwise(fs, { packageDir: join(cwd, 'pptwise') })
    const runner = createFakeRunner(themeHandler(fs, { workspace: join(tmpdir(), 'dsh-ppt-tokens-brief'), documents: { brief: fakeThemeDocument('brief') } }))
    const result = tokensExport({ input: 'brief', deps: defaultDependencies({ fs, runner, cwd, resolveModule }) })
    expect(result.outputFile).toBeNull()
    expect(result.document).toMatchObject({ schema: 'dsh-ppt-fusion.tokens.v1', themeId: 'brief' })
  })

  it('creates the workspace before the first spawn so the child has a real cwd', () => {
    const fs = createFakeFileSystem({})
    const { resolveModule } = installFakePptwise(fs, { packageDir: join(cwd, 'pptwise') })
    const workdir = join(tmpdir(), 'dsh-ppt-tokens-brief')
    const runner = createFakeRunner(themeHandler(fs, { workspace: workdir, documents: { brief: fakeThemeDocument('brief') } }))
    tokensExport({ input: 'brief', deps: defaultDependencies({ fs, runner, cwd, resolveModule }) })
    const call = runner.calls[0]
    expect(call).toBeDefined()
    expect(fs.isDirectory(call?.options.cwd ?? '')).toBe(true)
  })

  it('exports the master projection when asked', () => {
    const fs = createFakeFileSystem({})
    const { resolveModule } = installFakePptwise(fs, { packageDir: join(cwd, 'pptwise') })
    const runner = createFakeRunner(themeHandler(fs, { workspace: join(tmpdir(), 'dsh-ppt-tokens-brief'), documents: { brief: fakeThemeDocument('brief') } }))
    const result = tokensExport({ input: 'brief', master: true, deps: defaultDependencies({ fs, runner, cwd, resolveModule }) })
    expect(result.document).toMatchObject({ schema: 'dsh-ppt-fusion.master-design.v1', slideBackground: '#F7F6F2' })
  })

  it('reads a theme file and writes the export where asked', () => {
    const themePath = join(cwd, 'acme.theme.json')
    const outPath = join(cwd, 'tokens.json')
    const fs = createFakeFileSystem({ files: { [themePath]: JSON.stringify(fakeThemeDocument('acme')) } })
    const result = tokensExport({ input: themePath, output: outPath, deps: defaultDependencies({ fs, runner: createFakeRunner(), cwd }) })
    expect(result.outputFile).toBe(outPath)
    expect(fs.readText(outPath)).toContain('"themeId": "acme"')
  })

  it('fails loudly for a missing theme file', () => {
    const fs = createFakeFileSystem({})
    expect(() => tokensExport({ input: join(cwd, 'nope.theme.json'), deps: defaultDependencies({ fs, runner: createFakeRunner(), cwd }) })).toThrowError(
      /theme file not found/,
    )
  })
})
