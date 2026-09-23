import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { formatResumeReport, runResume } from './resume.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'resume-deck')

/** @returns a filesystem with the given checkpoint and extra files. */
function build(checkpoint: string, files: Record<string, string> = {}): FakeFileSystem {
  return createFakeFileSystem({
    directories: [workspace],
    files: { [join(workspace, '.dsh-ppt', 'checkpoint.json')]: checkpoint, ...files },
  })
}

/** @returns a valid checkpoint document. */
function checkpoint(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    phase: 3,
    deck: 'quarterly-review',
    updatedAt: '2026-09-22T12:00:00Z',
    artifacts: ['deck.fusion.json', 'tokens.json'],
    gates: { validate: 'pass' },
    notes: 'outline confirmed by the user',
    ...overrides,
  })
}

/** @returns dependencies over the fake filesystem. */
function deps(fs: FakeFileSystem): ReturnType<typeof defaultDependencies> {
  return defaultDependencies({ fs, cwd: workspace })
}

describe('runResume', () => {
  it('reports the phase, the present artifacts and the next commands', () => {
    const fs = build(checkpoint(), {
      [join(workspace, 'deck.fusion.json')]: '{}',
      [join(workspace, 'tokens.json')]: '{}',
    })
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.ok).toBe(true)
    expect(report.phase).toBe('3')
    expect(report.deck).toBe('quarterly-review')
    expect(report.updatedAt).toBe('2026-09-22T12:00:00Z')
    expect(report.artifacts).toEqual([
      { path: 'deck.fusion.json', exists: true },
      { path: 'tokens.json', exists: true },
    ])
    expect(report.next).toEqual([`dsh-ppt validate ${workspace}`])
    expect(formatResumeReport(report)).toContain('checkpoint phase 3')
  })

  it('fails the report when a claimed artifact is missing', () => {
    const fs = build(checkpoint())
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.ok).toBe(false)
    expect(report.missing).toEqual(['deck.fusion.json', 'tokens.json'])
    expect(formatResumeReport(report)).toContain('missing: deck.fusion.json')
  })

  it('reports the published package from out/manifest.json', () => {
    const fs = build(checkpoint({ phase: 6 }), {
      [join(workspace, 'out', 'manifest.json')]: JSON.stringify({ file: 'out/quarterly.pptx', sha256: 'ab'.repeat(32), bytes: 196845, slides: 12 }),
    })
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.published).toEqual({ file: 'out/quarterly.pptx', sha256: 'ab'.repeat(32), bytes: 196845, slides: 12 })
    expect(report.next).toEqual([`dsh-ppt audit ${workspace} --pixels`])
  })

  it('refuses a checkpoint that is not JSON', () => {
    const report = () => runResume({ dir: workspace, write: false, deps: deps(build('not json')) })
    expect(report).toThrowError(/checkpoint\.json is not JSON/)
  })

  it('refuses a checkpoint with an unknown phase and names the field', () => {
    const report = () => runResume({ dir: workspace, write: false, deps: deps(build(checkpoint({ phase: 'nine' }))) })
    expect(report).toThrowError(/phase/)
  })

  it('refuses when no checkpoint was written yet', () => {
    const fs = createFakeFileSystem({ directories: [workspace] })
    expect(() => runResume({ dir: workspace, write: false, deps: deps(fs) })).toThrowError(/does not exist/)
  })

  it('writes the resume brief with exactly one trailing newline', () => {
    const fs = build(checkpoint(), { [join(workspace, 'deck.fusion.json')]: '{}', [join(workspace, 'tokens.json')]: '{}' })
    const report = runResume({ dir: workspace, write: true, deps: deps(fs) })

    expect(report.written).toBe('.dsh-ppt/resume.md')
    const brief = fs.readText(join(workspace, '.dsh-ppt', 'resume.md')) ?? ''
    expect(brief.startsWith('# Resume brief')).toBe(true)
    expect(brief.endsWith('`\n')).toBe(true)
    expect(brief.endsWith('\n\n')).toBe(false)
    expect(brief).toContain('## Next commands')
  })

  it('records an unreadable published manifest as a problem, not a crash', () => {
    const fs = build(checkpoint({ phase: 6, storyboard: 'deck.storyboard.json' }), {
      [join(workspace, 'deck.storyboard.json')]: '{}',
      [join(workspace, 'out', 'manifest.json')]: '{ nope',
    })
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.published).toBeNull()
    expect(report.problems[0]).toContain('out/manifest.json is not JSON')
  })

  it('verifies the storyboard the checkpoint references', () => {
    const fs = build(checkpoint({ storyboard: 'deck.storyboard.json' }), {
      [join(workspace, 'deck.fusion.json')]: '{}',
      [join(workspace, 'tokens.json')]: '{}',
      [join(workspace, 'deck.storyboard.json')]: '{}',
    })
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.ok).toBe(true)
    expect(report.artifacts).toContainEqual({ path: 'deck.storyboard.json', exists: true })
    expect(report.problems).toEqual([])
  })

  it('fails when the referenced storyboard is missing and does not duplicate it', () => {
    const fs = build(checkpoint({ storyboard: 'deck.storyboard.json', artifacts: ['deck.fusion.json', 'deck.storyboard.json'] }), {
      [join(workspace, 'deck.fusion.json')]: '{}',
    })
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.ok).toBe(false)
    expect(report.missing).toEqual(['deck.storyboard.json'])
    expect(report.artifacts.filter((artifact) => artifact.path === 'deck.storyboard.json')).toHaveLength(1)
  })

  it('flags a phase-3 checkpoint that never references the storyboard', () => {
    const fs = build(checkpoint())
    const report = runResume({ dir: workspace, write: false, deps: deps(fs) })

    expect(report.problems.some((problem) => problem.includes('does not reference deck.storyboard.json'))).toBe(true)
  })
})
