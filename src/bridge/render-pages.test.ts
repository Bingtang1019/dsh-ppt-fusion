import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeFileSystem, createFakeRunner, fail, ok, spawnFailed, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { DEFAULT_MAX_PAGES, DEFAULT_MAX_PIXELS, renderCacheKey, renderPages, type KitLocation, type RenderPagesRequest } from './render-pages.ts'

const workspace = join(process.cwd(), 'tmp', 'renderpages-deck')
const source = join(workspace, 'out', 'deck.pptx')
const outputRoot = join(workspace, '.dsh-ppt', 'render')
const kit: KitLocation = { node: 'C:/node/node.exe', cli: 'C:/kit/lib/cli.js' }
const comScript = join(process.cwd(), 'scripts', 'win-com-export-pages.ps1')

/** A complete 45-byte PNG: signature, an IHDR chunk carrying the dimensions, and IEND. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(45)
  bytes.writeUInt32BE(0x89504e47, 0)
  bytes.writeUInt32BE(0x0d0a1a0a, 4)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes.writeUInt32BE(0, 29) // IHDR CRC; the reader never validates it
  bytes.write('IEND', 37, 'latin1')
  bytes.writeUInt32BE(0xae426082, 41)
  return bytes
}

/** @returns the same header without its IEND chunk: what a still-writing engine leaves behind. */
function truncatedPng(width: number, height: number): Buffer {
  return png(width, height).subarray(0, 32)
}

/** @returns the base request every case varies from. */
function request(fs: FakeFileSystem, runner: FakeRunner, overrides: Partial<RenderPagesRequest> = {}): RenderPagesRequest {
  return {
    dir: workspace,
    sourcePath: source,
    sourceRelative: 'out/deck.pptx',
    outputRoot,
    outputRelative: '.dsh-ppt/render',
    engines: ['libreoffice'],
    scale: 1,
    maxPages: DEFAULT_MAX_PAGES,
    maxPixels: DEFAULT_MAX_PIXELS,
    force: false,
    required: false,
    fs,
    runner,
    env: {},
    platform: 'linux',
    kit,
    soffice: null,
    comScript,
    powershell: 'powershell',
    ...overrides,
  }
}

/** @returns a filesystem seeded with the source pptx. */
function fileSystem(): FakeFileSystem {
  const fs = createFakeFileSystem()
  fs.writeBytes(source, Buffer.from('pptx bytes'))
  return fs
}

/** @returns a runner that answers the kit's capabilities and render calls. */
function kitRunner(fs: FakeFileSystem, options: { pages?: number; scaleDpi?: (dpi: number) => void; failRender?: boolean } = {}): FakeRunner {
  const pages = options.pages ?? 2
  return createFakeRunner((call) => {
    if (call.args[1] === 'capabilities') return ok(JSON.stringify({ runtime: { version: '0.1.1', backend: 'native' } }))
    if (call.args[1] !== 'render') return {}
    const output = call.args[call.args.indexOf('--output-dir') + 1] ?? ''
    const dpi = Number(call.args[call.args.indexOf('--dpi') + 1] ?? '96')
    options.scaleDpi?.(dpi)
    if (options.failRender === true) return fail(1, JSON.stringify({ code: 'failed', error: 'engine exploded' }))
    const images = []
    for (let index = 1; index <= pages; index += 1) {
      const file = `page-${String(index).padStart(4, '0')}.png`
      const bytes = png(1280, 720)
      fs.writeBytes(join(output, file), bytes)
      images.push({ index, page: index, path: join(output, file), width: 1280, height: 720, byteLength: bytes.length })
    }
    return ok(JSON.stringify({ backend: 'native', pageCount: pages, images }))
  })
}

describe('renderpages engine loop', () => {
  it('renders pages through the kit and writes the engine manifest and pages.json', () => {
    const fs = fileSystem()
    const runner = kitRunner(fs)
    const report = renderPages(request(fs, runner))
    expect(report.engines).toHaveLength(1)
    const engine = report.engines[0]
    expect(engine?.status).toBe('rendered')
    expect(engine?.version).toBe('0.1.1')
    expect(engine?.pages.map((page) => page.file)).toEqual(['page-0001.png', 'page-0002.png'])
    expect(engine?.pages[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const manifest = JSON.parse(fs.readText(join(outputRoot, 'libreoffice', 'manifest.json')) ?? '{}') as { pages?: unknown[]; cacheKey?: string }
    expect(manifest.pages).toHaveLength(2)
    expect(manifest.cacheKey).toBe(engine?.cacheKey)
    expect(report.pagesFile).toBe(join('.dsh-ppt/render', 'pages.json'))
    expect(fs.exists(join(outputRoot, 'pages.json'))).toBe(true)
  })

  it('reuses the cache on the second run and re-renders with --force', () => {
    const fs = fileSystem()
    const runner = kitRunner(fs)
    renderPages(request(fs, runner))
    const renders = (): number => runner.calls.filter((call) => call.args[1] === 'render').length
    expect(renders()).toBe(1)
    const cached = renderPages(request(fs, runner))
    expect(cached.engines[0]?.status).toBe('cached')
    expect(renders()).toBe(1)
    const forced = renderPages(request(fs, runner, { force: true }))
    expect(forced.engines[0]?.status).toBe('rendered')
    expect(renders()).toBe(2)
  })

  it('invalidates the cache when the source bytes change', () => {
    const fs = fileSystem()
    const runner = kitRunner(fs)
    const first = renderPages(request(fs, runner))
    fs.writeBytes(source, Buffer.from('changed bytes'))
    const second = renderPages(request(fs, runner))
    expect(second.engines[0]?.status).toBe('rendered')
    expect(second.sourceSha256).not.toBe(first.sourceSha256)
    expect(runner.calls.filter((call) => call.args[1] === 'render')).toHaveLength(2)
  })

  it('scales the export DPI with --scale', () => {
    const fs = fileSystem()
    let dpi = 0
    const runner = kitRunner(fs, { scaleDpi: (value) => { dpi = value } })
    renderPages(request(fs, runner, { scale: 2 }))
    expect(dpi).toBe(192)
  })

  it('reports a skipped engine and fails only when --required is set', () => {
    const fs = fileSystem()
    const runner = kitRunner(fs)
    const skipped = renderPages(request(fs, runner, { kit: null, soffice: null }))
    expect(skipped.engines[0]?.status).toBe('skipped')
    expect(skipped.skipped[0]).toContain('DSH_PPT_LOKIT_CLI')
    expect(skipped.pagesFile).toBeNull()
    expect(() => renderPages(request(fs, runner, { kit: null, soffice: null, required: true }))).toThrow(/--required/)
  })

  it('skips a soffice-only host when pdftoppm is missing', () => {
    const fs = fileSystem()
    const runner = createFakeRunner((call) => {
      if (call.command.endsWith('soffice.exe') && call.args[0] === '--version') return ok('LibreOffice 25.2.0.3\n')
      if (call.command === 'pdftoppm') return spawnFailed()
      return {}
    })
    const report = renderPages(request(fs, runner, { kit: null, soffice: 'C:/lo/soffice.exe' }))
    expect(report.engines[0]?.status).toBe('skipped')
    expect(report.engines[0]?.detail).toContain('pdftoppm')
  })

  it('rasterises through soffice and pdftoppm when the kit is absent', () => {
    const fs = fileSystem()
    const runner = createFakeRunner((call) => {
      if (call.command.endsWith('soffice.exe') && call.args[0] === '--version') return ok('LibreOffice 25.2.0.3\n')
      if (call.command === 'pdftoppm' && call.args[0] === '-v') return ok('pdftoppm version 25.2.0\n')
      if (call.command.endsWith('soffice.exe')) {
        const outdir = call.args[call.args.indexOf('--outdir') + 1] ?? ''
        fs.writeBytes(join(outdir, 'deck.pdf'), Buffer.from('%PDF-1.7'))
        return ok()
      }
      if (call.command === 'pdftoppm') {
        const prefix = call.args[call.args.length - 1] ?? ''
        fs.writeBytes(`${prefix}-1.png`, png(1280, 720))
        fs.writeBytes(`${prefix}-2.png`, png(1280, 720))
        return ok()
      }
      return {}
    })
    const report = renderPages(request(fs, runner, { kit: null, soffice: 'C:/lo/soffice.exe' }))
    expect(report.engines[0]?.status).toBe('rendered')
    expect(report.engines[0]?.pages.map((page) => page.file)).toEqual(['page-0001.png', 'page-0002.png'])
    expect(report.engines[0]?.pages[0]).toMatchObject({ width: 1280, height: 720 })
  })

  it('classifies an engine failure and a page-limit breach', () => {
    const fs = fileSystem()
    expect(() => renderPages(request(fs, kitRunner(fs, { failRender: true })))).toThrow(/engine exploded/)
    const many = fileSystem()
    expect(() => renderPages(request(many, kitRunner(many, { pages: 4 }), { maxPages: 3 }))).toThrow(/above --max-pages/)
  })

  it('keeps cache keys stable for identical inputs', () => {
    const parts = { sourceSha256: 'a'.repeat(64), engine: 'libreoffice' as const, engineVersion: '0.1.1', scale: 1, maxPages: 30, maxPixels: DEFAULT_MAX_PIXELS }
    expect(renderCacheKey(parts)).toBe(renderCacheKey({ ...parts }))
    expect(renderCacheKey(parts)).not.toBe(renderCacheKey({ ...parts, engineVersion: '0.2.0' }))
  })
})
describe('pages.json index', () => {
  it('keeps a previous engine entry when a later run asks for one engine only', () => {
    const fs = fileSystem()
    const runner = kitRunner(fs)
    const first = renderPages(request(fs, runner, { engines: ['libreoffice'] }))
    expect(first.engines.map((entry) => entry.engine)).toEqual(['libreoffice'])
    const index = JSON.parse(fs.readText(join(outputRoot, 'pages.json')) ?? '{}') as { engines?: { engine: string }[] }
    expect(index.engines?.map((entry) => entry.engine)).toEqual(['libreoffice'])
  })

  it('drops engine entries recorded for a different source digest', () => {
    const fs = fileSystem()
    fs.writeText(
      join(outputRoot, 'pages.json'),
      JSON.stringify({ schemaVersion: 1, source: 'out/other.pptx', sourceSha256: 'stale', scale: 1, maxPages: 30, maxPixels: 1, engines: [{ engine: 'powerpoint', status: 'cached', version: '16.0', directory: 'powerpoint', cacheKey: 'k', pages: [] }], pagesFile: null, skipped: [] }),
    )
    const runner = kitRunner(fs)
    renderPages(request(fs, runner, { engines: ['libreoffice'] }))
    const index = JSON.parse(fs.readText(join(outputRoot, 'pages.json')) ?? '{}') as { engines?: { engine: string }[] }
    expect(index.engines?.map((entry) => entry.engine)).toEqual(['libreoffice'])
  })
})
describe('engine output validation', () => {
  it('fails on a malformed kit page record instead of shrinking the deck', () => {
    const fs = fileSystem()
    const runner = createFakeRunner((call) => {
      if (call.args[1] === 'capabilities') return ok(JSON.stringify({ runtime: { version: '0.1.1', backend: 'native' } }))
      return ok(JSON.stringify({ backend: 'native', pageCount: 2, images: [{ index: 1, path: 'C:/tmp/page-0001.png' }, { index: 2, path: 'C:/tmp/page-0002.png' }] }))
    })
    expect(() => renderPages(request(fs, runner))).toThrow(/unusable page record/)
  })

  it('fails when a soffice raster cannot be read or is not a PNG', () => {
    const unreadable = fileSystem()
    const unreadableRunner = createFakeRunner((call) => {
      if (call.command.endsWith('soffice.exe') && call.args[0] === '--version') return ok('LibreOffice 25.2.0.3\n')
      if (call.command === 'pdftoppm' && call.args[0] === '-v') return ok('pdftoppm version 25.2.0\n')
      if (call.command.endsWith('soffice.exe')) {
        const outdir = call.args[call.args.indexOf('--outdir') + 1] ?? ''
        unreadable.writeBytes(join(outdir, 'deck.pdf'), Buffer.from('%PDF-1.7'))
        return ok()
      }
      if (call.command === 'pdftoppm') {
        // Listed by listDir but unreadable: the text map is a different store.
        unreadable.writeText(`${call.args[call.args.length - 1] ?? ''}-1.png`, 'not bytes')
        return ok()
      }
      return {}
    })
    expect(() => renderPages(request(unreadable, unreadableRunner, { kit: null, soffice: 'C:/lo/soffice.exe' }))).toThrow(/cannot be read/)

    const notPng = fileSystem()
    const notPngRunner = createFakeRunner((call) => {
      if (call.command.endsWith('soffice.exe') && call.args[0] === '--version') return ok('LibreOffice 25.2.0.3\n')
      if (call.command === 'pdftoppm' && call.args[0] === '-v') return ok('pdftoppm version 25.2.0\n')
      if (call.command.endsWith('soffice.exe')) {
        const outdir = call.args[call.args.indexOf('--outdir') + 1] ?? ''
        notPng.writeBytes(join(outdir, 'deck.pdf'), Buffer.from('%PDF-1.7'))
        return ok()
      }
      if (call.command === 'pdftoppm') {
        notPng.writeBytes(`${call.args[call.args.length - 1] ?? ''}-1.png`, Buffer.from('not a png at all'))
        return ok()
      }
      return {}
    })
    expect(() => renderPages(request(notPng, notPngRunner, { kit: null, soffice: 'C:/lo/soffice.exe' }))).toThrow(/not a PNG/)
  })
})

/** @returns a runner that answers the COM version probe and the export call. */
function comRunner(fs: FakeFileSystem, outcome: { truncated?: boolean; fail?: string; pages?: number } = {}): FakeRunner {
  const pages = outcome.pages ?? 1
  const name = (index: number): string => `page-${String(index).padStart(4, '0')}.png`
  return createFakeRunner((call) => {
    if (call.command !== 'powershell') return {}
    const at = call.args.indexOf('-OutDir')
    // The version probe carries no `-OutDir`; `indexOf` returning -1 must not fall through
    // to the export branch, which would answer the probe with an export payload.
    if (at < 0) return ok('ok 16.0\r\n')
    const outdir = call.args[at + 1]
    if (outdir === undefined) return ok('ok 16.0\r\n')
    if (outcome.fail !== undefined) return ok(JSON.stringify({ ok: false, error: outcome.fail }))
    for (let index = 1; index <= pages; index += 1) {
      fs.writeBytes(join(outdir, name(index)), outcome.truncated === true ? truncatedPng(1280, 720) : png(1280, 720))
    }
    return ok(
      JSON.stringify({
        ok: true,
        engineVersion: '16.0',
        pageCount: pages,
        width: 1280,
        height: 720,
        pages: Array.from({ length: pages }, (_unused, offset) => ({ index: offset + 1, file: name(offset + 1) })),
      }),
    )
  })
}

describe('PowerPoint COM export (F7, ADR-101)', () => {
  it('renders through the COM leg when PowerPoint is available', () => {
    const fs = fileSystem()
    const runner = comRunner(fs, { pages: 2 })
    const report = renderPages(request(fs, runner, { engines: ['powerpoint'], platform: 'win32' }))
    expect(report.engines[0]?.engine).toBe('powerpoint')
    expect(report.engines[0]?.status).toBe('rendered')
    expect(report.engines[0]?.pages.map((page) => page.file)).toEqual(['page-0001.png', 'page-0002.png'])
  })

  it('rejects a page image the COM leg was still writing', () => {
    const fs = fileSystem()
    const runner = comRunner(fs, { truncated: true })
    expect(() => renderPages(request(fs, runner, { engines: ['powerpoint'], platform: 'win32' }))).toThrow(/not a complete PNG/)
  })

  it('names the LibreOffice fallback when the COM leg fails', () => {
    const fs = fileSystem()
    const runner = comRunner(fs, { fail: 'cannot start PowerPoint COM' })
    expect(() => renderPages(request(fs, runner, { engines: ['powerpoint'], platform: 'win32' }))).toThrow(/--engine libreoffice/)
  })
})
