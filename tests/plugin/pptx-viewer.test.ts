import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PPTX_VIEWER_HEADER, PPTX_VIEWER_ROUTE, createPptxViewerService, isDeckPath } from '../../dsh/pptx-viewer.js'

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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')

/**
 * @returns a deck file plus a CLI runner that answers `renderpages` by writing pages
 *   into the cache root it was given.
 */
async function fixture(options: { pages?: number[]; fail?: boolean } = {}): Promise<{ file: string; cacheRoot: string; service: ReturnType<typeof createPptxViewerService>; calls: string[][] }> {
  const base = await temp('dsh-pptx-')
  const file = join(base, 'talk.pptx')
  await writeFile(file, Buffer.from('PK fake deck'))
  const cacheRoot = join(base, 'cache')
  const pages = options.pages ?? [1, 2]
  const calls: string[][] = []
  const service = createPptxViewerService('C:/nope/cli.js', {
    cacheRoot,
    runCli: async (args) => {
      calls.push(args)
      if (options.fail === true) throw new Error('engine unavailable')
      const root = args[args.indexOf('--output-dir') + 1] ?? ''
      for (const engine of ['libreoffice', 'powerpoint']) {
        await mkdir(join(root, engine), { recursive: true })
        for (const index of pages) await writeFile(join(root, engine, `page-${String(index).padStart(4, '0')}.png`), PNG)
      }
      const entries = pages.map((index) => ({ index, file: `page-${String(index).padStart(4, '0')}.png`, width: 1280, height: 721, bytes: PNG.length, sha256: 'x' }))
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          source: file.replace(/\\/g, '/'),
          sourceSha256: 'a'.repeat(64),
          engines: [
            { engine: 'libreoffice', status: 'rendered', version: '0.1.1', directory: 'libreoffice', cacheKey: 'k', pages: entries },
            { engine: 'powerpoint', status: 'skipped', version: null, directory: null, cacheKey: null, pages: [], detail: 'not on this host' },
          ],
          skipped: ['powerpoint: not on this host'],
        }),
        stderr: '',
      }
    },
  })
  return { file, cacheRoot, service, calls }
}

/** @returns a response recorder plus the handler the service registered. */
function routeOf(service: ReturnType<typeof createPptxViewerService>): { handler: (req: unknown, res: Recorder) => Promise<void>; path: string } {
  const routes: { path: string; handler: (req: unknown, res: Recorder) => Promise<void> }[] = []
  service.registerRoute({ webServer: { register: (route: never) => routes.push(route as unknown as { path: string; handler: (req: unknown, res: Recorder) => Promise<void> }) } })
  return routes[0] as { handler: (req: unknown, res: Recorder) => Promise<void>; path: string }
}

/** The response recorder the route tests read back. */
interface Recorder {
  status?: number
  headers?: Record<string, string>
  body?: Buffer | string
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: Buffer | string): void
}

/** @returns a response object capturing what the handler wrote. */
function recorder(): Recorder {
  return {
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body === undefined ? Buffer.alloc(0) : body
    },
  }
}

describe('pptx viewer', () => {
  it('serves a paging view for a deck and its page images', async () => {
    const { file, service, calls } = await fixture()
    const route = routeOf(service)
    expect(route.path).toBe(PPTX_VIEWER_ROUTE)
    const view = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/view?path=${encodeURIComponent(file)}` }, view)
    expect(view.status).toBe(200)
    expect(view.headers?.[PPTX_VIEWER_HEADER]).toBe('dsh-ppt-pptx')
    expect(view.headers?.['content-type']).toMatch(/text\/html/)
    expect(String(view.body)).toContain('2 page(s)')
    expect(view.body).toContain(`${PPTX_VIEWER_ROUTE}/page?path=`)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('--outside')
    expect(calls[0]).not.toContain('--force')

    const page = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/page?path=${encodeURIComponent(file)}&index=2` }, page)
    expect(page.status).toBe(200)
    expect(page.headers?.['content-type']).toBe('image/png')
    expect(Buffer.isBuffer(page.body) ? page.body.length : Buffer.from(String(page.body)).length).toBe(PNG.length)
  })

  it('re-renders when refresh is asked for', async () => {
    const { file, service, calls } = await fixture()
    const route = routeOf(service)
    const view = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/view?path=${encodeURIComponent(file)}&refresh=1` }, view)
    expect(view.status).toBe(200)
    expect(calls[0]).toContain('--force')
  })

  it('rejects non-deck files, unknown routes and unknown pages', async () => {
    const { file, service } = await fixture()
    const route = routeOf(service)
    const txt = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/view?path=${encodeURIComponent(file.replace('.pptx', '.txt'))}` }, txt)
    expect(txt.status).toBe(400)
    expect(String(txt.body)).toMatch(/unsupported-file/)

    const bogus = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/nope?path=${encodeURIComponent(file)}` }, bogus)
    expect(bogus.status).toBe(404)

    const page = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/page?path=${encodeURIComponent(file)}&index=9` }, page)
    expect(page.status).toBe(404)
    expect(String(page.body)).toMatch(/unknown-page/)
  })

  it('reports a render failure instead of an empty viewer', async () => {
    const { file, service } = await fixture({ fail: true })
    const route = routeOf(service)
    const view = recorder()
    await route.handler({ url: `${PPTX_VIEWER_ROUTE}/view?path=${encodeURIComponent(file)}` }, view)
    expect(view.status).toBe(502)
    expect(String(view.body)).toMatch(/engine unavailable/)
  })

  it('refuses a missing file and a missing deck suffix', async () => {
    const { service } = await fixture()
    await expect(service.ensurePages(join(tmpdir(), 'nope', 'ghost.pptx'))).rejects.toThrow()
    await expect(service.ensurePages('/etc/hosts')).rejects.toThrow(/only renders/)
  })

  it('claims exactly the deck suffixes', () => {
    expect(isDeckPath('a/b/deck.pptx')).toBe(true)
    expect(isDeckPath('a/b/DECK.PPTX')).toBe(true)
    expect(isDeckPath('a/b/deck.pptm')).toBe(true)
    expect(isDeckPath('a/b/deck.txt')).toBe(false)
    expect(isDeckPath('')).toBe(false)
  })
})