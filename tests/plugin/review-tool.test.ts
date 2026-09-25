import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REVIEW_MAX_PAGES, createReviewService } from '../../dsh/review-tool.js'

/** Directories created by a case, removed afterwards. */
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** @returns a fixture CLI that writes the render index and page images the tool reads. */
async function fixtureCli(pages: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-'))
  created.push(dir)
  const script = join(dir, 'fake-cli.mjs')
  const source = `
if (process.env.DSH_REVIEW_FIXTURE_FAIL === '1') { console.error('fixture cli refused'); process.exit(1) }
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [command, target] = process.argv.slice(2)
if (command !== 'renderpages') { console.error('unexpected command', command); process.exit(2) }
const root = join(target, '.dsh-ppt', 'render')
const entries = []
for (let index = 1; index <= ${String(pages)}; index += 1) {
  const file = 'page-' + String(index).padStart(4, '0') + '.png'
  await mkdir(join(root, 'libreoffice'), { recursive: true })
  await writeFile(join(root, 'libreoffice', file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]))
  entries.push({ index, file, width: 1280, height: 721, bytes: 12, sha256: 'x' })
}
await writeFile(join(root, 'libreoffice', 'manifest.json'), JSON.stringify({ schemaVersion: 1, engine: 'libreoffice', engineVersion: '0.1.1', cacheKey: 'k', source: 'out/deck.pptx', sourceSha256: 'abc', scale: 1, dpi: 96, maxPages: 30, maxPixels: 1, pages: entries }))
await writeFile(join(root, 'pages.json'), JSON.stringify({ schemaVersion: 1, source: 'out/deck.pptx', sourceSha256: 'abc', scale: 1, maxPages: 30, maxPixels: 1, engines: [{ engine: 'libreoffice', status: 'cached', version: '0.1.1', directory: 'libreoffice', cacheKey: 'k', pages: entries }], pagesFile: '.dsh-ppt/render/pages.json', skipped: [] }))
`
  await writeFile(script, source)
  return script
}

/** @returns a scope whose `get` answers the two services the tool asks for. */
function scope(options: { attachments?: boolean; imageInput?: boolean } = {}): Record<string, unknown> {
  const attachments = {
    imageLimits: { maxImageBytes: 5_000_000, maxMessageImageBytes: 5_000_000, maxImageDimension: 8192, maxImagePixels: 16_777_216, mediaTypes: ['image/png'] },
    saveImage: async ({ data, mediaType, name }: { data: Buffer; mediaType: string; name: string }) => ({ attachmentId: 'att-1', mediaType, bytes: data.length, width: 1280, height: 721, name }),
  }
  const llm = { resolveModelInfo: async () => ({ inputModalities: options.imageInput === false ? ['text'] : ['image', 'text'] }) }
  return {
    get: (name: string) => (name === 'attachments' ? (options.attachments === false ? undefined : attachments) : name === 'llm' ? llm : undefined),
  }
}

/** @returns the execution context the tool reads the routed model from. */
function execution(): Record<string, unknown> {
  return { agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'vision-model' } }) }, options: {} } }
}

/** @returns a deck directory with a source deck marked as rendered. */
async function deck(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-deck-'))
  created.push(dir)
  await mkdir(join(dir, 'out'), { recursive: true })
  await writeFile(join(dir, 'out', 'deck.pptx'), 'PK')
  return dir
}

describe('dsh_ppt_review', () => {
  it('attaches every rendered page with the rubric and returns image blocks', async () => {
    const target = await deck()
    const service = createReviewService(await fixtureCli(2), { ctx: scope() })
    const value = (await service.tool.execute({ target }, execution())) as { mode: string; pageCount: number; images: unknown[]; reviewFile: string }
    expect(value.mode).toBe('inspect')
    expect(value.pageCount).toBe(2)
    expect(value.images).toHaveLength(2)
    const blocks = service.tool.output.render({}, value) as { type: string }[]
    expect(blocks[0]?.type).toBe('text')
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(2)
    expect(String((blocks[0] as unknown as { text: string }).text)).toContain('Review every attached page')
    expect(value.reviewFile.endsWith('.dsh-ppt/review/review.json')).toBe(true)
  })

  it('honours the page selection', async () => {
    const target = await deck()
    const service = createReviewService(await fixtureCli(REVIEW_MAX_PAGES + 2), { ctx: scope() })
    const value = (await service.tool.execute({ target, pages: [2, 3] }, execution())) as { pageCount: number; pages: { index: number }[] }
    expect(value.pageCount).toBe(2)
    expect(value.pages.map((page) => page.index)).toEqual([2, 3])
  })

  it('refuses to pretend it can see without the attachment service or an image-capable model', async () => {
    const target = await deck()
    const noAttachments = createReviewService(await fixtureCli(1), { ctx: scope({ attachments: false }) })
    await expect(noAttachments.tool.execute({ target }, execution())).rejects.toThrow(/image-input-unavailable/)
    const blind = createReviewService(await fixtureCli(1), { ctx: scope({ imageInput: false }) })
    await expect(blind.tool.execute({ target }, execution())).rejects.toThrow(/image-input-unavailable/)
  })

  it('records validated findings and rejects unusable ones', async () => {
    const target = await deck()
    const service = createReviewService(await fixtureCli(3), { ctx: scope() })
    await service.tool.execute({ target }, execution())
    const value = (await service.tool.execute(
      {
        target,
        findings: [
          { page: 1, severity: 'error', rule: 'render-overflow', message: 'title runs past the card', fix: 'shorten it' },
          { page: 2, severity: 'warning', rule: 'contrast', message: 'subtitle is light' },
        ],
      },
      execution(),
    )) as { mode: string; counts: { error: number; warning: number } }
    expect(value.mode).toBe('record')
    expect(value.counts).toMatchObject({ error: 1, warning: 1 })
    const written = JSON.parse(await readFile(join(target, '.dsh-ppt', 'review', 'review.json'), 'utf8')) as { schemaVersion: number; findings: unknown[] }
    expect(written.schemaVersion).toBe(1)
    expect(written.findings).toHaveLength(2)
    await expect(service.tool.execute({ target, findings: [{ page: 1, severity: 'fatal', rule: 'x', message: 'y' }] }, execution())).rejects.toThrow(/severity/)
    await expect(service.tool.execute({ target, findings: [{ page: 9, severity: 'error', rule: 'x', message: 'y' }] }, execution())).rejects.toThrow(/page must be a page number/)
  })

  it('surfaces a failing render instead of reviewing a stale index', async () => {
    const target = await deck()
    const service = createReviewService(await fixtureCli(1), { ctx: scope() })
    process.env.DSH_REVIEW_FIXTURE_FAIL = '1'
    try {
      await expect(service.tool.execute({ target }, execution())).rejects.toThrow(/fixture cli refused/)
    } finally {
      delete process.env.DSH_REVIEW_FIXTURE_FAIL
    }
  })
})
