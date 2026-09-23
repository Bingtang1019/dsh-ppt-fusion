import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDeck } from './init.ts'
import { defaultDependencies } from './context.ts'
import { validateDeck } from './validate.ts'
import { createFakeFileSystem, createFakeRunner, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise, themeHandler } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'init-deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise')
const profileFixture = readFileSync(join(process.cwd(), 'fixtures', 'reference', 'profile.json'), 'utf8')

/** A workspace with the reference profile ready and a scripted pptwise. */
function build(): { fs: FakeFileSystem; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({ files: { [join(workspace, 'design-profile.json')]: profileFixture } })
  const runner = createFakeRunner(themeHandler(fs, { workspace, documents: { brief: fakeThemeDocument('brief') } }))
  const deps = defaultDependencies({ fs, runner, cwd: workspace, resolveModule: installFakePptwise(fs, { packageDir }).resolveModule })
  return { fs, deps }
}

describe('initDeck with a design profile (V7.2 B2)', () => {
  it('writes the deck-local profile theme, disables page numbers and validates', () => {
    const { fs, deps } = build()
    const result = initDeck({ dir: workspace, theme: 'brief', profile: join(workspace, 'design-profile.json'), deps })

    const deck = JSON.parse(fs.readText(join(workspace, 'deck.fusion.json')) ?? '{}') as { chrome?: { pageNumber?: { show?: boolean } }; theme?: { preset?: string } }
    expect(deck.theme?.preset).toBe('brief')
    expect(deck.chrome?.pageNumber?.show).toBe(false)

    const theme = JSON.parse(fs.readText(join(workspace, 'theme.json')) ?? '{}') as { id?: string; style?: { colors?: { accent?: string; bg?: string } } }
    expect(theme.id).toBe('brief')
    expect(theme.style?.colors?.accent).toBe('#577FD2')
    expect(theme.style?.colors?.bg).toBe('#FFFFFF')

    // Tokens are re-derived after the patch, so validate does not report them stale.
    const tokens = JSON.parse(fs.readText(join(workspace, 'tokens.json')) ?? '{}') as { themeId?: string; colors?: { accent?: string } }
    expect(tokens.themeId).toBe('brief')
    expect(tokens.colors?.accent).toBe('#577FD2')

    const storyboard = JSON.parse(fs.readText(join(workspace, 'deck.storyboard.json')) ?? '{}') as {
      pages: { role: string; layout: string; chrome?: { pageNumber?: string } }[]
    }
    expect(storyboard.pages.map((page) => page.role)).toEqual(['cover', 'ending'])
    expect(storyboard.pages.map((page) => page.layout)).toEqual(['brief:gauge-verdict', 'brief:gauge-next'])

    const report = validateDeck({ dir: workspace, deps })
    expect(report.findings.filter((finding) => finding.level === 'error')).toEqual([])
    expect(report.ok).toBe(true)
    expect(result.created).toContain(join(workspace, 'theme.json'))
  })

  it('keeps the default chrome contract when no profile is given', () => {
    const { fs, deps } = build()
    initDeck({ dir: workspace, theme: 'brief', deps })
    const deck = JSON.parse(fs.readText(join(workspace, 'deck.fusion.json')) ?? '{}') as { chrome?: { pageNumber?: { show?: boolean; skipRoles?: string[] } } }
    expect(deck.chrome?.pageNumber?.show).toBe(true)
    expect(deck.chrome?.pageNumber?.skipRoles).toEqual(['cover', 'ending'])
    expect(validateDeck({ dir: workspace, deps }).ok).toBe(true)
  })

  it('refuses a missing or invalid profile before creating anything', () => {
    const { fs, deps } = build()
    expect(() => initDeck({ dir: workspace, theme: 'brief', profile: join(workspace, 'nope.json'), deps })).toThrowError(/absent/)
    fs.writeText(join(workspace, 'broken.json'), JSON.stringify({ version: 1 }))
    expect(() => initDeck({ dir: workspace, theme: 'brief', profile: join(workspace, 'broken.json'), deps })).toThrowError(/invalid/)
  })
})
