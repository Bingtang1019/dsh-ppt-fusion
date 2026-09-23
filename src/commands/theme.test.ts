import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { themeApplyProfile } from './theme.ts'
import { defaultDependencies } from './context.ts'
import { parseDesignProfile } from '../schema/design-profile.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { createFakeFileSystem, createFakeRunner, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise, themeHandler } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise')
const fixture = readFileSync(join(process.cwd(), 'fixtures', 'reference', 'profile.json'), 'utf8')

/** A workspace holding the reference profile and a fake upstream theme preset. */
function build(): { fs: FakeFileSystem; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'design-profile.json')]: fixture,
    },
    directories: [workspace],
  })
  const resolveModule = installFakePptwise(fs, { packageDir }).resolveModule
  const runner = createFakeRunner(themeHandler(fs, { workspace, documents: { brief: fakeThemeDocument('brief') } }))
  const deps = defaultDependencies({ fs, runner, cwd: workspace, resolveModule })
  return { fs, deps }
}

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('themeApplyProfile', () => {
  it('materialises the preset and replaces colours and fonts while keeping the preset id', () => {
    const { fs, deps } = build()
    const result = themeApplyProfile({ dir: workspace, profile: 'design-profile.json', from: 'brief', output: 'theme.json', deps })
    expect(result.outputFile).toBe(join(workspace, 'theme.json'))
    expect(result.id).toBe('brief')
    expect(result.theme.style.colors.accent).toBe('#577FD2')
    const written = parseDesignProfile(JSON.parse(fixture) as unknown)
    expect(result.theme.style.colors.bg).toBe(written.palette.bg)
    const stored = JSON.parse(fs.readText(result.outputFile) ?? '{}') as { id?: string; style?: { colors?: { accent?: string } }; menu?: unknown }
    expect(stored.id).toBe('brief')
    expect(stored.style?.colors?.accent).toBe('#577FD2')
    expect(stored.menu).toBeDefined()
  })

  it('defaults to theme.json and reuses an existing deck-local theme', () => {
    const { fs, deps } = build()
    const first = themeApplyProfile({ dir: workspace, profile: 'design-profile.json', from: 'brief', deps })
    expect(first.outputFile).toBe(join(workspace, 'theme.json'))
    const second = themeApplyProfile({ dir: workspace, profile: 'design-profile.json', from: 'brief', deps })
    expect(second.theme.style.colors.accent).toBe('#577FD2')
    expect(fs.readText(join(workspace, 'theme.json'))).toContain('"accent": "#577FD2"')
  })

  it('refuses a missing profile, an invalid profile, an output outside the workspace and a cross-menu rebind', () => {
    const { fs, deps } = build()
    expect(codeOf(() => themeApplyProfile({ dir: workspace, profile: 'missing.json', from: 'brief', deps }))).toBe('OutputMissing')
    fs.writeText(join(workspace, 'broken.json'), JSON.stringify({ version: 1 }))
    expect(codeOf(() => themeApplyProfile({ dir: workspace, profile: 'broken.json', from: 'brief', deps }))).toBe('ContractViolation')
    expect(codeOf(() => themeApplyProfile({ dir: workspace, profile: 'design-profile.json', from: 'brief', output: '../outside.json', deps }))).toBe('PathOutsideWorkspace')
    fs.writeText(join(workspace, 'other.json'), JSON.stringify(fakeThemeDocument('thesis')))
    expect(codeOf(() => themeApplyProfile({ dir: workspace, profile: 'design-profile.json', from: 'brief', output: 'other.json', deps }))).toBe('ContractViolation')
  })
})
