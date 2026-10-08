import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createFakeFileSystem, createFakeRunner, ok } from '../../tests/support/fake-runner.ts'
import { defaultDependencies } from './context.ts'
import { engineOption, enginesOf, renderPagesCommand, resolveLibreOfficeKit, resolveSoffice, scaleOption } from './renderpages.ts'

const home = join(process.cwd(), 'tmp', 'renderpages-home')

describe('renderpages discovery', () => {
  it('prefers DSH_PPT_LOKIT_CLI and its node override', () => {
    const fs = createFakeFileSystem({ files: { [join(home, 'kit', 'cli.js')]: '// cli' } })
    const kit = resolveLibreOfficeKit({
      env: { DSH_PPT_LOKIT_CLI: join(home, 'kit', 'cli.js'), DSH_PPT_LOKIT_NODE: join(home, 'node.exe') },
      home,
      cwd: home,
      fs,
    })
    expect(kit?.cli).toBe(join(home, 'kit', 'cli.js'))
    expect(kit?.node).toBe(join(home, 'node.exe'))
  })

  it('finds a kit inside a pnpm runtime under the home directory', () => {
    const store = join(home, 'dsh-017-runtime', 'node_modules', '.pnpm', '@deepseek-ai+libreoffice-kit@0.1.1', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
    const fs = createFakeFileSystem({ files: { [store]: '// cli' }, directories: [join(home, 'dsh-017-runtime', 'node_modules', '.pnpm')] })
    const kit = resolveLibreOfficeKit({ env: {}, home, cwd: home, fs })
    expect(kit?.cli).toBe(store)
  })

  it('resolves a kit beside the plugin through the module resolver', () => {
    const packageDir = join(process.cwd(), 'tmp', 'kit-profile', 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    const fs = createFakeFileSystem({ files: { [join(packageDir, 'lib', 'cli.js')]: '// cli' } })
    const kit = resolveLibreOfficeKit({
      env: {},
      home,
      cwd: home,
      fs,
      resolveModule: () => pathToFileURL(join(packageDir, 'package.json')).href,
    })
    expect(kit?.cli).toBe(join(packageDir, 'lib', 'cli.js'))
  })

  it('returns null when nothing carries a kit', () => {
    const fs = createFakeFileSystem({ directories: [home] })
    expect(resolveLibreOfficeKit({ env: {}, home, cwd: home, fs })).toBeNull()
  })

  it('resolves soffice from PATH and from the Windows install location', () => {
    const onPath = createFakeFileSystem({ files: { [join('C:', 'Program Files', 'LibreOffice', 'program', 'soffice.exe')]: 'bin' } })
    expect(resolveSoffice({ env: { PATH: join('C:', 'other'), ProgramFiles: join('C:', 'Program Files') }, platform: 'win32', fs: onPath })).toBe(
      join('C:', 'Program Files', 'LibreOffice', 'program', 'soffice.exe'),
    )
    const viaPath = createFakeFileSystem({ files: { [join('/usr', 'bin', 'soffice')]: 'bin' } })
    expect(resolveSoffice({ env: { PATH: '/usr/bin:/bin' }, platform: 'linux', fs: viaPath })).toBe(join('/usr', 'bin', 'soffice'))
    expect(resolveSoffice({ env: { PATH: '/nope' }, platform: 'linux', fs: createFakeFileSystem() })).toBeNull()
  })

  it('maps the engine choice and validates the scale', () => {
    expect(enginesOf('both')).toEqual(['powerpoint', 'libreoffice'])
    expect(enginesOf('libreoffice')).toEqual(['libreoffice'])
    expect(engineOption('powerpoint')).toBe('powerpoint')
    expect(() => engineOption('word')).toThrow(/--engine/)
    expect(scaleOption('2')).toBe(2)
    expect(() => scaleOption('3')).toThrow(/--scale/)
  })
})
/** A complete one-pixel PNG the fake Kit reports and the fake filesystem can serve. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

/**
 * Build command dependencies whose runner answers the Kit probe and writes the
 * pages its render call reports into the given filesystem.
 *
 * @param fs - fake filesystem the Kit writes through.
 * @param outputDir - absolute directory the Kit writes page files into.
 * @returns dependencies for `renderPagesCommand`.
 */
function kitDeps(fs: ReturnType<typeof createFakeFileSystem>, outputDir: string): ReturnType<typeof defaultDependencies> {
  const runner = createFakeRunner((call) => {
    if (call.args.includes('capabilities')) return ok(JSON.stringify({ runtime: { version: '0.1.1', backend: 'native' } }))
    fs.mkdirp(outputDir)
    const pages = [1, 2].map((index) => {
      const path = join(outputDir, `kit-page-${String(index)}.png`)
      fs.writeBytes(path, PNG)
      return { index, path, width: 1280, height: 721 }
    })
    return ok(JSON.stringify({ backend: 'native', pageCount: pages.length, images: pages }))
  })
  return defaultDependencies({ fs, runner, cwd: process.cwd(), env: { DSH_PPT_LOKIT_CLI: join(process.cwd(), 'tmp', 'kit', 'cli.js'), DSH_PPT_LOKIT_NODE: join(process.cwd(), 'tmp', 'node.exe'), PATH: '' } })
}

describe('renderpages outside the workspace', () => {
  it('renders a package from outside the deck into an absolute output directory', () => {
    const base = join(process.cwd(), 'tmp', 'renderpages-outside')
    const source = join(base, 'elsewhere', 'talk.pptx')
    const outputDir = join(base, 'cache', 'viewer')
    const fs = createFakeFileSystem({ files: { [join(process.cwd(), 'tmp', 'kit', 'cli.js')]: '// cli' } })
    fs.writeBytes(source, Buffer.from('PK'))
    const report = renderPagesCommand({
      dir: join(base, 'deck'),
      file: source,
      output: '.dsh-ppt/render',
      outputDir,
      outside: true,
      engine: 'libreoffice',
      scale: 1,
      maxPages: 30,
      maxPixels: 16_777_216,
      required: false,
      force: false,
      deps: kitDeps(fs, outputDir),
    })
    expect(report.source).toBe(source.replace(/\\/g, '/'))
    expect(report.engines[0]?.status).toBe('rendered')
    expect(report.engines[0]?.pages).toHaveLength(2)
    expect((report.pagesFile ?? '').replace(/\\/g, '/')).toBe(join(outputDir, 'pages.json').replace(/\\/g, '/'))
    const keys = [...fs.byteFiles.keys()].map((key) => key.replace(/\\/g, '/'))
    expect(keys).toContain(join(outputDir, 'libreoffice', 'page-0001.png').replace(/\\/g, '/'))
  })

  it('refuses an absolute output directory without --outside', () => {
    const base = join(process.cwd(), 'tmp', 'renderpages-outside-refuse')
    const fs = createFakeFileSystem()
    fs.writeBytes(join(base, 'out', 'talk.pptx'), Buffer.from('PK'))
    expect(() =>
      renderPagesCommand({
        dir: base,
        file: join('out', 'talk.pptx'),
        output: '.dsh-ppt/render',
        outputDir: join(base, 'cache'),
        engine: 'libreoffice',
        scale: 1,
        maxPages: 30,
        maxPixels: 16_777_216,
        required: false,
        force: false,
        deps: defaultDependencies({ fs, runner: createFakeRunner(), cwd: process.cwd() }),
      }),
    ).toThrow(/needs --outside/)
  })

  it('refuses a source outside the workspace without --outside', () => {
    const base = join(process.cwd(), 'tmp', 'renderpages-outside-refuse-source')
    const fs = createFakeFileSystem()
    fs.writeBytes(join(process.cwd(), 'tmp', 'other', 'talk.pptx'), Buffer.from('PK'))
    expect(() =>
      renderPagesCommand({
        dir: base,
        file: join(process.cwd(), 'tmp', 'other', 'talk.pptx'),
        output: '.dsh-ppt/render',
        engine: 'libreoffice',
        scale: 1,
        maxPages: 30,
        maxPixels: 16_777_216,
        required: false,
        force: false,
        deps: defaultDependencies({ fs, runner: createFakeRunner(), cwd: process.cwd() }),
      }),
    ).toThrow(/PathOutsideWorkspace|outside/i)
  })
})
