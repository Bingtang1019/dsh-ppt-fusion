import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { formatImagesGenerate, formatImagesSearch, imagesGenerate, imagesSearch } from './images.ts'
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

/** A workspace whose fake engine writes a generated image when it sees `image-gen`. */
function buildGenerate(options: { write?: boolean; env?: NodeJS.ProcessEnv } = {}): {
  fs: FakeFileSystem
  runner: FakeRunner
  deps: ReturnType<typeof defaultDependencies>
} {
  const fs = createFakeFileSystem({ directories: [workspace] })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => {
    if (call.args.includes('image-gen')) {
      if (options.write === false) return ok('generated nothing\n')
      const output = call.args[call.args.indexOf('-o') + 1] ?? 'assets'
      const filename = call.args[call.args.indexOf('--filename') + 1] ?? 'ai.png'
      fs.writeBytes(join(workspace, output, filename), Buffer.from('fake-png'))
      return ok('generated 1 image\n')
    }
    return ok()
  })
  const deps = defaultDependencies({
    fs,
    cwd: workspace,
    env: { DSH_HOME: dshHome, DSH_PPT_ENABLE_IMAGE_GEN: '1', OPENAI_API_KEY: 'sk-test', ...options.env },
    runner,
  })
  return { fs, runner, deps }
}

describe('imagesGenerate', () => {
  it('refuses while the extension is disabled and prints the fallback order', async () => {
    const { deps } = buildGenerate({ env: { DSH_PPT_ENABLE_IMAGE_GEN: '0' } })
    const error = await imagesGenerate({ dir: workspace, prompt: 'a cat', provider: 'openai-compatible', deps }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'ContractViolation' })
    expect((error as Error).message).toContain('svg')
    expect((error as Error).message).toContain('images search')
    expect((error as { detail: { fallback: string[] } }).detail.fallback).toHaveLength(5)
  })

  it('refuses when the provider key is absent', async () => {
    const { deps } = buildGenerate({ env: { OPENAI_API_KEY: '' } })
    await expect(imagesGenerate({ dir: workspace, prompt: 'a cat', provider: 'openai-compatible', deps })).rejects.toMatchObject({ code: 'UsageError' })
    const gemini = buildGenerate({ env: { GEMINI_API_KEY: '' } })
    const error = await imagesGenerate({ dir: workspace, prompt: 'a cat', provider: 'gemini', deps: gemini.deps }).catch((reason: unknown) => reason)
    expect((error as Error).message).toContain('GEMINI_API_KEY')
  })

  it('generates through the engine and records the ai-image provenance', async () => {
    const { fs, runner, deps } = buildGenerate()
    const result = await imagesGenerate({
      dir: workspace,
      prompt: 'A food-safety lab bench, soft daylight',
      provider: 'openai-compatible',
      aspectRatio: '16:9',
      imageSize: '1K',
      purpose: 'chapter background',
      slide: 3,
      deps,
    })
    expect(result.outputFile).toBe('assets/ai-a-food-safety-lab-bench-soft-daylight.png')
    expect(result.provider).toBe('ai-image-openai-compatible')
    expect(result.manifestPath).toBe('assets/image_sources.json')
    expect(formatImagesGenerate(result)).toContain('review before publishing')
    const call = runner.callsWith('image-gen')[0]
    expect(call?.args).toEqual(
      expect.arrayContaining([
        'image-gen',
        'A food-safety lab bench, soft daylight',
        '--backend',
        'openai',
        '-o',
        'assets',
        '--filename',
        'ai-a-food-safety-lab-bench-soft-daylight.png',
        '--aspect_ratio',
        '16:9',
        '--image_size',
        '1K',
      ]),
    )
    expect(call?.options.env.OPENAI_API_KEY).toBe('sk-test')
    const manifest = JSON.parse(fs.readText(join(workspace, 'assets', 'image_sources.json')) ?? '') as { items: Record<string, unknown>[] }
    expect(manifest.items).toHaveLength(1)
    const item = manifest.items[0] ?? {}
    expect(item.provider).toBe('ai-image-openai-compatible')
    expect(item.prompt).toBe('A food-safety lab bench, soft daylight')
    expect(item.license_name).toContain('AI-generated')
    expect(item.attribution_text).toContain('人工复核')
    expect(item.slide).toBe('3')
    expect(item.purpose).toBe('chapter background')
  })

  it('replaces the record for the same file and appends a new one for another', async () => {
    const { fs, deps } = buildGenerate()
    await imagesGenerate({ dir: workspace, prompt: 'one', filename: 'ai-one.png', provider: 'openai-compatible', deps })
    await imagesGenerate({ dir: workspace, prompt: 'one again', filename: 'ai-one.png', provider: 'openai-compatible', deps })
    await imagesGenerate({ dir: workspace, prompt: 'two', filename: 'ai-two.png', provider: 'openai-compatible', deps })
    const manifest = JSON.parse(fs.readText(join(workspace, 'assets', 'image_sources.json')) ?? '') as { items: { filename: string; prompt: string }[] }
    expect(manifest.items.map((item) => item.filename)).toEqual(['ai-one.png', 'ai-two.png'])
    expect(manifest.items[0]?.prompt).toBe('one again')
  })

  it('fails when the engine writes no image or the manifest is unusable', async () => {
    const empty = buildGenerate({ write: false })
    await expect(imagesGenerate({ dir: workspace, prompt: 'a cat', provider: 'openai-compatible', deps: empty.deps })).rejects.toMatchObject({ code: 'OutputMissing' })
    const { fs, deps } = buildGenerate()
    fs.writeText(join(workspace, 'assets', 'image_sources.json'), 'not json')
    await expect(imagesGenerate({ dir: workspace, prompt: 'a cat', provider: 'openai-compatible', deps })).rejects.toMatchObject({ code: 'ContractViolation' })
  })
})
