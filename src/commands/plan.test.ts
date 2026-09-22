import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { confirmPlan, outlineFromMarkdown, planDeck, PLAN_DRAFT } from './plan.ts'
import { defaultDependencies } from './context.ts'
import { parseFusionDeck } from '../schema/fusion.ts'
import { createFakeFileSystem, createFakeRunner } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')

const depsWith = (fs: ReturnType<typeof createFakeFileSystem>) =>
  defaultDependencies({ fs, runner: createFakeRunner(), cwd: workspace, resolveModule: () => 'unused' })

describe('outlineFromMarkdown', () => {
  it('turns H2 headings into pages and infers a data kind for numeric headings', () => {
    const outline = outlineFromMarkdown('# Title\n\n## 背景\n\n## 2025 年度数据\n')
    expect(outline).toEqual([
      { heading: '背景', kind: 'points' },
      { heading: '2025 年度数据', kind: 'data' },
    ])
  })

  it('falls back to one points page when there are no headings', () => {
    expect(outlineFromMarkdown('prose only')).toEqual([{ heading: 'Points', kind: 'points' }])
  })
})

describe('planDeck', () => {
  it('writes a draft that wraps a schema-valid manifest and lists what to confirm', () => {
    const fs = createFakeFileSystem({ files: { [join(workspace, 'sources', 'brief.md')]: '## Intro\n\n## Market data\n' } })
    const result = planDeck({ dir: workspace, deps: depsWith(fs), sources: ['sources/brief.md'] })
    expect(result.draftPath).toBe(join(workspace, PLAN_DRAFT))
    expect(result.pageCount).toBe(4)
    expect(result.needsConfirmation.length).toBeGreaterThan(0)
    const draft = JSON.parse(fs.readText(result.draftPath) ?? '{}') as { manifest?: unknown }
    const manifest = parseFusionDeck(draft.manifest)
    expect(manifest.pages).toHaveLength(4)
    expect(manifest.name).toBe('deck')
  })

  it('reuses an existing manifest and still flags the routing decision', () => {
    const fs = createFakeFileSystem({
      files: {
        [join(workspace, 'deck.fusion.json')]: JSON.stringify({
          version: 1,
          name: 'hello',
          pptwiseIr: 'deck.ir.json',
          theme: { preset: 'brief' },
          pages: [{ index: 1, route: 'pptwise' }],
        }),
      },
    })
    const result = planDeck({ dir: workspace, deps: depsWith(fs) })
    expect(result.needsConfirmation.join(' ')).toContain('route')
  })
})

describe('confirmPlan', () => {
  it('copies the draft manifest into place', () => {
    const fs = createFakeFileSystem({})
    const deps = depsWith(fs)
    planDeck({ dir: workspace, deps })
    const written = confirmPlan({ dir: workspace, deps })
    expect(written).toBe(join(workspace, 'deck.fusion.json'))
    expect(parseFusionDeck(JSON.parse(fs.readText(written) ?? '{}')).name).toBe('deck')
  })

  it('refuses when there is no draft', () => {
    const deps = depsWith(createFakeFileSystem({}))
    expect(() => confirmPlan({ dir: workspace, deps })).toThrowError(/no draft/)
  })
})
