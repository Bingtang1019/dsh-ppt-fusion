import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { formatImagesSearch, imagesSearch } from './images.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'

const workspace = join(process.cwd(), 'tmp', 'images-deck')
const dshHome = join(process.cwd(), 'tmp', 'images-dsh')

/** One engine manifest item, as `image_search.py` writes it. */
function manifestItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: 'mountain.jpg',
    provider: 'openverse',
    license_name: 'CC0 1.0',
    license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    license_tier: 'public-domain',
    author: 'Jane Doe',
    source_page_url: 'https://example.com/photo',
    download_url: 'https://cdn.example.com/photo.jpg',
    attribution_required: false,
    attribution_text: '"mountain" by Jane Doe, CC0 1.0',
    title: 'Mountain',
    ...overrides,
  }
}

/** A workspace whose fake engine writes the manifest the command will validate. */
function build(options: { items?: Record<string, unknown>[]; writeManifest?: boolean; raw?: string } = {}): {
  fs: FakeFileSystem
  runner: FakeRunner
  deps: ReturnType<typeof defaultDependencies>
} {
  const fs = createFakeFileSystem({ directories: [workspace] })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => {
    if (call.args.includes('image-search')) {
      if (options.writeManifest === false) return ok('downloaded nothing\n')
      const manifest = call.args[call.args.indexOf('--manifest') + 1] ?? ''
      fs.writeText(join(workspace, manifest), options.raw ?? JSON.stringify({ items: options.items ?? [manifestItem()] }))
      fs.writeText(join(workspace, 'assets', 'mountain.jpg'), 'jpeg-bytes')
      return ok('downloaded 1 image\n')
    }
    return ok()
  })
  return { fs, runner, deps: defaultDependencies({ fs, cwd: workspace, env: { DSH_HOME: dshHome }, runner }) }
}

describe('imagesSearch', () => {
  it('records the download and its attribution in assets/image_sources.json', async () => {
    const { fs, runner, deps } = build()
    const result = await imagesSearch({ dir: workspace, query: 'mountain', provider: 'openverse', strictNoAttribution: true, filename: 'mountain.jpg', minWidth: 1200, deps })
    expect(result.outputDir).toBe('assets')
    expect(result.manifestPath).toBe('assets/image_sources.json')
    expect(result.items).toEqual([
      expect.objectContaining({
        filename: 'mountain.jpg',
        provider: 'openverse',
        licenseName: 'CC0 1.0',
        author: 'Jane Doe',
        requiresAttribution: false,
        attributionText: '"mountain" by Jane Doe, CC0 1.0',
      }),
    ])
    expect(formatImagesSearch(result)).toContain('"mountain" by Jane Doe, CC0 1.0')
    expect(fs.readText(join(workspace, 'assets', 'image_sources.json'))).toContain('items')
    const argv = runner.callsWith('image-search')[0]?.args ?? []
    expect(argv).toEqual(
      expect.arrayContaining([
        'image-search', 'mountain', '--provider', 'openverse', '--filename', 'mountain.jpg', '--strict-no-attribution', '--min-width', '1200', '-o', 'assets', '--manifest', 'assets/image_sources.json',
      ]),
    )
  })

  it('passes the candidate and manual-URL flags through', async () => {
    const { runner, deps } = build({ items: [manifestItem({ filename: 'team.jpg', license_name: 'manual', attribution_required: true, attribution_text: 'team.jpg: manual replacement' })] })
    await imagesSearch({
      dir: workspace,
      query: '',
      saveCandidates: true,
      maxCandidates: 4,
      fromUrl: 'https://cdn.example.com/team.jpg',
      purpose: 'team page',
      slide: 3,
      resolveHost: async () => ['93.184.216.34'],
      deps,
    })
    expect(runner.callsWith('image-search')[0]?.args).toEqual(
      expect.arrayContaining(['--save-candidates', '--max-candidates', '4', '--from-url', 'https://cdn.example.com/team.jpg', '--purpose', 'team page', '--slide', '3', '--filename', 'image.jpg']),
    )
  })

  it('refuses to record an image without licence provenance', async () => {
    const missingLicense = build({ items: [manifestItem({ license_name: null })] })
    await expect(imagesSearch({ dir: workspace, query: 'mountain', deps: missingLicense.deps })).rejects.toMatchObject({ code: 'ContractViolation' })

    const missingAttribution = build({ items: [manifestItem({ attribution_required: true, attribution_text: '' })] })
    await expect(imagesSearch({ dir: workspace, query: 'mountain', deps: missingAttribution.deps })).rejects.toMatchObject({ code: 'ContractViolation' })
  })

  it('fails when --strict-no-attribution still yields an attribution-required image', async () => {
    const { deps } = build({ items: [manifestItem({ attribution_required: true, attribution_text: 'by Jane Doe, CC BY 4.0' })] })
    await expect(imagesSearch({ dir: workspace, query: 'mountain', strictNoAttribution: true, deps })).rejects.toMatchObject({ code: 'ContractViolation' })
  })

  it('applies the source URL policy to --from-url before spawning', async () => {
    const { runner, deps } = build()
    await expect(imagesSearch({ dir: workspace, query: '', fromUrl: 'http://127.0.0.1/x.jpg', deps })).rejects.toMatchObject({ code: 'UsageError' })
    await expect(imagesSearch({ dir: workspace, query: '', fromUrl: 'https://intranet.example/x.jpg', resolveHost: async () => ['10.1.2.3'], deps })).rejects.toMatchObject({ code: 'UsageError' })
    expect(runner.callsWith('image-search')).toHaveLength(0)
  })

  it('passes a keyed provider its key through the child environment', async () => {
    const fs = createFakeFileSystem({ directories: [workspace] })
    installFakeVenv(fs, { dshHome })
    const runner = createFakeRunner((call) => {
      if (call.args.includes('image-search')) {
        const manifest = call.args[call.args.indexOf('--manifest') + 1] ?? ''
        fs.writeText(join(workspace, manifest), JSON.stringify({ items: [manifestItem()] }))
        fs.writeText(join(workspace, 'assets', 'mountain.jpg'), 'jpeg-bytes')
        return ok('downloaded 1 image\n')
      }
      return ok()
    })
    const deps = defaultDependencies({ fs, cwd: workspace, env: { DSH_HOME: dshHome, PEXELS_API_KEY: 'test-key' }, runner })
    await imagesSearch({ dir: workspace, query: 'mountain', provider: 'pexels', filename: 'mountain.jpg', deps })

    const call = runner.callsWith('image-search')[0]
    expect(call?.args).toContain('pexels')
    expect(call?.options.env.PEXELS_API_KEY).toBe('test-key')
  })

  it('refuses a missing or unreadable manifest', async () => {
    const missing = build({ writeManifest: false })
    await expect(imagesSearch({ dir: workspace, query: 'mountain', deps: missing.deps })).rejects.toMatchObject({ code: 'OutputMissing' })
    const broken = build({ raw: 'not json' })
    await expect(imagesSearch({ dir: workspace, query: 'mountain', deps: broken.deps })).rejects.toMatchObject({ code: 'ContractViolation' })
    const noItems = build({ raw: JSON.stringify({ nope: [] }) })
    await expect(imagesSearch({ dir: workspace, query: 'mountain', deps: noItems.deps })).rejects.toMatchObject({ code: 'ContractViolation' })
  })
})
