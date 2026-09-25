import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createFakeFileSystem } from '../../tests/support/fake-runner.ts'
import { engineOption, enginesOf, resolveLibreOfficeKit, resolveSoffice, scaleOption } from './renderpages.ts'

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
