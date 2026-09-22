import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { SOURCE_MAX_BYTES, sourceConvert, sourceTypeOf } from './source.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'

const workspace = join(process.cwd(), 'tmp', 'source-deck')
const dshHome = join(process.cwd(), 'tmp', 'source-dsh')

/** A workspace with one file per route; the fake engine writes the requested Markdown. */
function build(options: { markdown?: (output: string) => string } = {}): { fs: FakeFileSystem; runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'sources', 'paper.pdf')]: '%PDF-1.4',
      [join(workspace, 'sources', 'report.docx')]: 'docx-bytes',
      [join(workspace, 'sources', 'table.xlsx')]: 'xlsx-bytes',
      [join(workspace, 'sources', 'deck.pptx')]: 'pptx-bytes',
      [join(workspace, 'sources', 'notes.txt')]: 'plain text',
      [join(workspace, 'sources', 'readme.md')]: '# readme',
    },
  })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => {
    if (call.args.includes('source-to-md')) {
      const output = call.args[call.args.indexOf('-o') + 1] ?? ''
      fs.writeText(join(workspace, output), options.markdown?.(output) ?? `# converted ${output}\n`)
      fs.writeText(join(workspace, output.replace(/\.md$/, '.conversion_profile.json')), '{"warnings":[]}')

      return ok(`converted \${output}\n`)
    }
    return ok()
  })
  return { fs, runner, deps: defaultDependencies({ fs, cwd: workspace, env: { DSH_HOME: dshHome }, runner }) }
}

describe('sourceTypeOf', () => {
  it('maps extensions and URLs to the dispatcher types', () => {
    expect(sourceTypeOf('sources/a.pdf')).toBe('pdf')
    expect(sourceTypeOf('sources/a.docx')).toBe('doc')
    expect(sourceTypeOf('sources/a.xlsx')).toBe('excel')
    expect(sourceTypeOf('sources/a.pptx')).toBe('pptx')
    expect(sourceTypeOf('sources/a.md')).toBe('markdown')
    expect(sourceTypeOf('sources/a.txt')).toBe('text')
    expect(sourceTypeOf('https://example.com/x')).toBe('web')
    expect(sourceTypeOf('sources/a.bin')).toBeNull()
  })
})

describe('sourceConvert', () => {
  it('converts all five local routes, names the outputs and writes a manifest', async () => {
    const { fs, runner, deps } = build()
    const result = await sourceConvert({
      dir: workspace,
      inputs: ['sources/paper.pdf', 'sources/report.docx', 'sources/table.xlsx', 'sources/deck.pptx', 'sources/notes.txt'],
      output: 'sources/md',
      deps,
    })
    expect(result.entries.map((entry) => entry.type)).toEqual(['pdf', 'doc', 'excel', 'pptx', 'text'])
    expect(result.entries.every((entry) => entry.profile?.endsWith('.conversion_profile.json') === true)).toBe(true)
    expect(result.entries.map((entry) => entry.output)).toEqual([
      'sources/md/paper.md',
      'sources/md/report.md',
      'sources/md/table.md',
      'sources/md/deck.md',
      'sources/md/notes.md',
    ])
    expect(result.manifestPath).toBe('sources/md/source-manifest.json')
    const manifest = JSON.parse(fs.readText(join(workspace, result.manifestPath)) ?? 'null') as { schema: string; entries: unknown[] }
    expect(manifest.schema).toBe('dsh-ppt-fusion.source-manifest.v1')
    expect(manifest.entries).toHaveLength(5)
    const argv = runner.callsWith('source-to-md')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['source-to-md', 'sources/paper.pdf', '-t', 'pdf', '-o', 'sources/md/paper.md']))
  })

  it('expands a directory, passes --no-images and de-duplicates output stems', async () => {
    const { fs, runner, deps } = build()
    fs.writeText(join(workspace, 'sources/extra', 'notes.txt'), 'more text')
    const result = await sourceConvert({
      dir: workspace,
      inputs: ['sources', 'sources/extra/notes.txt'],
      output: 'md',
      noImages: true,
      deps,
    })
    expect(result.entries).toHaveLength(7)
    const stems = result.entries.map((entry) => entry.output)
    expect(new Set(stems).size).toBe(stems.length)
    expect(runner.callsWith('--no-images')).toHaveLength(7)
  })

  it('refuses a URL that fails the policy before spawning anything', async () => {
    const { runner, deps } = build()
    await expect(sourceConvert({ dir: workspace, inputs: ['http://localhost/x'], output: 'md', deps })).rejects.toMatchObject({ code: 'UsageError' })
    await expect(
      sourceConvert({ dir: workspace, inputs: ['https://intranet.example/x'], output: 'md', deps, resolveHost: async () => ['10.0.0.7'] }),
    ).rejects.toMatchObject({ code: 'UsageError' })
    expect(runner.callsWith('source-to-md')).toHaveLength(0)
  })

  it('accepts a public URL and passes the type through', async () => {
    const { runner, deps } = build()
    const result = await sourceConvert({
      dir: workspace,
      inputs: ['https://example.com/article'],
      output: 'md',
      deps,
      resolveHost: async () => ['93.184.216.34'],
    })
    expect(result.entries[0]).toMatchObject({ input: 'https://example.com/article', type: 'web', output: 'md/article.md' })
    expect(runner.callsWith('source-to-md')[0]?.args).toEqual(expect.arrayContaining(['-t', 'web']))
  })

  it('refuses a missing file, an unknown extension and a forced type that cannot apply', async () => {
    const { deps } = build()
    await expect(sourceConvert({ dir: workspace, inputs: ['sources/missing.pdf'], output: 'md', deps })).rejects.toMatchObject({ code: 'OutputMissing' })
    await expect(sourceConvert({ dir: workspace, inputs: ['sources/readme.xyz'], output: 'md', deps })).rejects.toMatchObject({ code: 'UsageError' })
    await expect(sourceConvert({ dir: workspace, inputs: ['sources/paper.pdf'], output: 'md', type: 'web', deps })).rejects.toMatchObject({ code: 'UsageError' })
  })

  it('caps the Markdown the engine may write', async () => {
    const { deps } = build({ markdown: () => 'x'.repeat(SOURCE_MAX_BYTES + 1) })
    await expect(sourceConvert({ dir: workspace, inputs: ['sources/notes.txt'], output: 'md', deps })).rejects.toMatchObject({ code: 'ContractViolation' })
  })
})
