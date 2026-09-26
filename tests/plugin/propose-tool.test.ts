import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROPOSE_ROUTE, PROPOSE_ROUTE_HEADER, createProposeService, isProposalId } from '../../dsh/propose-tool.js'

/** Directories created by a case, removed afterwards. */
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** @returns a temporary directory tracked for cleanup. */
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])

/**
 * @param options.summary - diff summary the fake CLI reports.
 * @returns a fixture CLI that answers propose, diff and versions.
 */
async function fixtureCli(options: { summary?: string; pageCount?: number; fail?: boolean } = {}): Promise<string> {
  const dir = await temp('dsh-propose-')
  const script = join(dir, 'fake-cli.mjs')
  const source = `
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
if (process.env.DSH_PROPOSE_FIXTURE_FAIL === '1') { console.error('fixture cli refused'); process.exit(1) }
const argv = process.argv.slice(2)
const command = argv[0]
const deck = argv[1]
const json = argv.includes('--json')
const id = 'p-20260927-090000-abcdef'
const pageCount = ${String(options.pageCount ?? 2)}
if (command === 'propose') {
  const relative = join('.dsh-ppt', 'versions', id)
  const dir = join(deck, relative)
  await mkdir(join(dir, 'pages', 'libreoffice'), { recursive: true })
  await writeFile(join(dir, 'demo.pptx'), 'PK fake')
  const pages = []
  for (let index = 1; index <= pageCount; index += 1) {
    const file = 'page-' + String(index).padStart(4, '0') + '.png'
    if (argv.includes('--render')) await writeFile(join(dir, 'pages', 'libreoffice', file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]))
    pages.push({ index, file, width: 1280, height: 721, bytes: 12, sha256: 'x' })
  }
  const result = {
    view: {
      id,
      dir,
      record: {
        schemaVersion: 1,
        id,
        createdAt: '2026-09-27T09:00:00.000Z',
        message: 'fixture draft',
        source: { file: join(relative, 'demo.pptx'), sha256: 'a'.repeat(64), bytes: 7, slides: pageCount },
        files: { pptx: join(relative, 'demo.pptx'), manifest: join(relative, 'manifest.json'), audit: join(relative, 'audit.json') },
      },
      status: { schemaVersion: 1, status: 'draft', updatedAt: '2026-09-27T09:00:00.000Z' },
    },
    pruned: [],
    ...(argv.includes('--render') ? { pages: { engines: [{ engine: 'libreoffice', status: 'rendered', pages }], skipped: [] } } : {}),
  }
  process.stdout.write(json ? JSON.stringify(result) : 'proposed')
  process.exit(0)
}
if (command === 'diff') {
  const result = {
    left: { ref: 'trunk', pptx: 'out/demo.pptx', pages: null, findings: [], pinned: null },
    right: { ref: id, pptx: '.dsh-ppt/versions/' + id + '/demo.pptx', pages: null, findings: [], pinned: true },
    semantic: { equal: false, left: { pages: 1, parts: 20 }, right: { pages: 2, parts: 24 }, pages: [{ index: 2, status: 'added', shapes: { left: 0, right: 2 }, changedParts: [], notes: ['page exists only in the newer version'] }], globalParts: [], summary: ${JSON.stringify(options.summary ?? '2 page(s): 1 added, 0 removed, 0 modified')} },
    audit: { added: [{ level: 'error', source: 'pptx', rule: 'render-off-page', message: 'title leaves the canvas', page: 2 }], removed: [], unchanged: 3, summary: 'audit: 1 added (1 error(s)), 0 removed, 3 unchanged' },
    skipped: ['render: trunk has no page snapshots (propose with --render, or renderpages)'],
    summary: 'diff trunk -> ' + id,
  }
  process.stdout.write(json ? JSON.stringify(result) : result.summary)
  process.exit(0)
}
if (command === 'versions') {
  const result = { views: [{ id, status: { status: 'draft' }, record: { createdAt: '2026-09-27T09:00:00.000Z', message: 'fixture draft' } }], trunk: null, formatted: 'fixture' }
  process.stdout.write(json ? JSON.stringify(result) : 'fixture')
  process.exit(0)
}
console.error('unexpected command ' + command)
process.exit(2)
`
  await writeFile(script, source)
  return script
}

/** @returns a deck directory the fixture CLI can write into. */
async function deck(): Promise<string> {
  const dir = await temp('dsh-propose-deck-')
  await mkdir(join(dir, 'out'), { recursive: true })
  await writeFile(join(dir, 'deck.fusion.json'), '{"name":"demo"}')
  return dir
}

/** @returns a scope recording the routes a service registers. */
function routeScope(): { routes: { path: string; handler: (req: unknown, res: FakeResponse) => Promise<void> }[]; webServer: { register: (route: never) => void } } {
  const routes: { path: string; handler: (req: unknown, res: FakeResponse) => Promise<void> }[] = []
  return {
    routes,
    webServer: {
      register: (route: never) => {
        routes.push(route as unknown as { path: string; handler: (req: unknown, res: FakeResponse) => Promise<void> })
      },
    },
  }
}

/** The response recorder a route test reads back. */
interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  body?: Buffer
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: Buffer | string): void
}

/** @returns a response object capturing what the handler wrote. */
function response(): FakeResponse {
  return {
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
    },
  }
}

/** @returns the parsed body of a captured response. */
function jsonBody(res: FakeResponse): Record<string, unknown> {
  return JSON.parse((res.body ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>
}

describe('dsh_ppt_propose', () => {
  it('proposes, diffs, records a card payload and stamps the marker', async () => {
    const target = await deck()
    const home = await temp('dsh-propose-home-')
    const service = createProposeService(await fixtureCli(), { home })
    const value = (await service.tool.execute({ target, message: 'fixture' }, {})) as Record<string, unknown>
    expect(value.proposalId).toBe('p-20260927-090000-abcdef')
    expect(String(value.summary)).toMatch(/1 added/)
    expect(String(value.approveCommand)).toContain('dsh-ppt approve')
    expect(value.pages).toBe(2)
    const payload = JSON.parse(await readFile(join(home, `${String(value.proposalId)}.json`), 'utf8')) as Record<string, unknown>
    expect(payload.deckName).toBe('demo')
    expect((payload.pages as { url: string }[])[0]?.url).toBe(`${PROPOSE_ROUTE}/p-20260927-090000-abcdef/page-1.png`)
    const text = (service.tool.output.render({}, value) as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('dsh-ppt-propose:p-20260927-090000-abcdef')
    expect(text).toContain('approve (a person runs this)')
    const meta = (service.tool.output as unknown as { presentationMeta: (args: unknown, value: unknown) => { card: string } }).presentationMeta({}, value)
    expect(meta.card).toBe('dsh-ppt-propose')
  })

  it('serves the payload and its page images, and rejects unknown ids', async () => {
    const target = await deck()
    const home = await temp('dsh-propose-home-')
    const service = createProposeService(await fixtureCli(), { home })
    const value = (await service.tool.execute({ target }, {})) as Record<string, unknown>
    const id = String(value.proposalId)
    const scope = routeScope()
    service.registerRoute(scope)
    const route = scope.routes[0]
    expect(route?.path).toBe(PROPOSE_ROUTE)

    const card = response()
    await route?.handler({ url: `${PROPOSE_ROUTE}/${id}` }, card)
    expect(card.status).toBe(200)
    expect(card.headers?.[PROPOSE_ROUTE_HEADER]).toBeTruthy()
    expect((jsonBody(card).id as string)).toBe(id)

    const page = response()
    await route?.handler({ url: `${PROPOSE_ROUTE}/${id}/page-1.png` }, page)
    expect(page.status).toBe(200)
    expect(page.headers?.['content-type']).toBe('image/png')
    expect(page.body?.equals(PNG)).toBe(true)

    const missing = response()
    await route?.handler({ url: `${PROPOSE_ROUTE}/p-nope` }, missing)
    expect(missing.status).toBe(404)
    expect(jsonBody(missing).code).toBe('unknown-proposal')

    const invalid = response()
    await route?.handler({ url: `${PROPOSE_ROUTE}/..%2Fescape` }, invalid)
    expect(invalid.status).toBe(400)

    const noPage = response()
    await route?.handler({ url: `${PROPOSE_ROUTE}/${id}/page-99.png` }, noPage)
    expect(noPage.status).toBe(404)
    expect(jsonBody(noPage).code).toBe('unknown-page')
  })

  it('skips the page snapshots when render is off', async () => {
    const target = await deck()
    const home = await temp('dsh-propose-home-')
    const service = createProposeService(await fixtureCli(), { home })
    const value = (await service.tool.execute({ target, render: false }, {})) as Record<string, unknown>
    expect(value.pages).toBe(0)
    const payload = JSON.parse(await readFile(join(home, `${String(value.proposalId)}.json`), 'utf8')) as { pages: unknown[] }
    expect(payload.pages).toEqual([])
  })

  it('surfaces a failing CLI instead of inventing a draft', async () => {
    const target = await deck()
    const home = await temp('dsh-propose-home-')
    const service = createProposeService(await fixtureCli(), { home })
    process.env.DSH_PROPOSE_FIXTURE_FAIL = '1'
    try {
      await expect(service.tool.execute({ target }, {})).rejects.toThrow(/fixture cli refused/)
    } finally {
      delete process.env.DSH_PROPOSE_FIXTURE_FAIL
    }
  })

  it('accepts only id-shaped proposal names', () => {
    expect(isProposalId('p-20260927-090000-abcdef')).toBe(true)
    expect(isProposalId('..')).toBe(false)
    expect(isProposalId('../etc')).toBe(false)
    expect(isProposalId('a/b')).toBe(false)
    expect(isProposalId('')).toBe(false)
  })
})