import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { OpcPackage, REL } from '../bridge/opc.ts'
import { compatLint, compatLintDocument, formatCompatLint } from './compat.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem } from '../../tests/support/fake-runner.ts'

const REPO_ROOT = process.cwd()

/** Put a package at `deck/out/deck.pptx` in an in-memory workspace. */
async function workspaceWith(pkg: OpcPackage): Promise<{ dir: string; deps: ReturnType<typeof defaultDependencies> }> {
  const dir = join(REPO_ROOT, 'tmp', 'compat-lint-test')
  const fs = createFakeFileSystem({ directories: [dir, join(dir, 'out')] })
  fs.byteFiles.set(join(dir, 'out', 'deck.pptx'), await pkg.write())
  return { dir, deps: defaultDependencies({ fs, cwd: REPO_ROOT }) }
}

/** A one-slide package carrying the given slide XML. */
function slidePackage(slideXml: string): OpcPackage {
  const pkg = new OpcPackage()
  pkg.setPart('ppt/slides/slide1.xml', slideXml)
  pkg.setPart('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>')
  pkg.setRelationships('ppt/presentation.xml', [{ id: 'rId1', type: REL.slide, target: 'slides/slide1.xml' }])
  return pkg
}

describe('compatLint', () => {
  it('accepts the real golden deck at the standard level', async () => {
    const result = await compatLint({ dir: REPO_ROOT, file: 'fixtures/golden/hello-merged.pptx', level: 'standard', strict: true, deps: defaultDependencies() })
    expect(result.ok).toBe(true)
    expect(result.inspection.occurrences).toHaveLength(5)
    expect(result.inspection.occurrences.every((occurrence) => occurrence.feature === 'p14:dur')).toBe(true)
    expect(formatCompatLint(result)).toContain('ok (5 occurrence(s)')
  })

  it('fails on warning-level findings only under --strict', async () => {
    const { dir, deps } = await workspaceWith(slidePackage('<p:sld><a:p><a:r><a:rPr lang="zh-CN"/><a:t>\u4E2D\u6587</a:t></a:r></a:p></p:sld>'))
    const relaxed = await compatLint({ dir, file: 'out/deck.pptx', level: 'standard', strict: false, deps })
    expect(relaxed.ok).toBe(true)
    expect(relaxed.inspection.findings).toHaveLength(1)
    expect(relaxed.failures).toEqual([])

    const strict = await compatLint({ dir, file: 'out/deck.pptx', level: 'standard', strict: true, deps })
    expect(strict.ok).toBe(false)
    expect(strict.failures).toHaveLength(1)
    expect(formatCompatLint(strict)).toContain('FAIL warning compat-feature')
    expect(compatLintDocument(strict).ok).toBe(false)
  })

  it('fails an error-level finding even without --strict', async () => {
    const { dir, deps } = await workspaceWith(slidePackage('<p:sld xmlns:p15="urn:p15" p15:unknown="1"/>'))
    const result = await compatLint({ dir, file: 'out/deck.pptx', level: 'max', strict: false, deps })
    expect(result.ok).toBe(false)
    expect(result.failures.map((finding) => finding.rule)).toContain('namespace-unregistered')
  })

  it('refuses a path outside the workspace and a file that is not there', async () => {
    const deps = defaultDependencies()
    await expect(compatLint({ dir: REPO_ROOT, file: '../outside.pptx', level: 'standard', strict: false, deps })).rejects.toMatchObject({ code: 'PathOutsideWorkspace' })
    await expect(compatLint({ dir: REPO_ROOT, file: 'fixtures/golden/missing.pptx', level: 'standard', strict: false, deps })).rejects.toMatchObject({ code: 'OutputMissing' })
  })
})
