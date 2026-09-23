import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleResolver } from '../../src/frontend.ts'
import type { FakeFileSystem } from './fake-runner.ts'
import type { FakeCall } from './fake-runner.ts'
import { ok } from './fake-runner.ts'
import type { RunResult } from '../../src/engine/runner.ts'

/**
 * A minimal but complete ThemeFile v2, matching the shape pptwise 0.35.0 writes
 * (measured in M0: `{id, label, style:{id, colors, fonts, shape,
 * defaultBackgrounds}, occasions, identity, story, emphasis, version, menu}`).
 *
 * @param id - theme id.
 * @param overrides - fields to replace, for tests that need a specific palette.
 * @returns the theme document.
 */
export function fakeThemeDocument(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    label: id,
    style: {
      id,
      colors: {
        bg: '#F7F6F2',
        surface: '#FFFFFF',
        primary: '#1E2A4A',
        accent: '#F5C518',
        text: '#1C1E23',
        muted: '#5B6069',
        border: '#DDDCD4',
        chartPalette: ['#1E2A4A', '#F5C518', '#3B76A8', '#797D86'],
      },
      fonts: { heading: ['Arial'], body: ['Arial'] },
      shape: { radius: 2, gapScale: 1 },
      defaultBackgrounds: {
        cover: { kind: 'color', value: '#F7F6F2' },
        chapter: { kind: 'color', value: '#1E2A4A' },
        content: { kind: 'color', value: '#F7F6F2' },
        ending: { kind: 'color', value: '#F7F6F2' },
      },
    },
    occasions: ['business'],
    identity: 'medium',
    version: 2,
    menu: {
      cover: { face: 'gauge-verdict' },
      chapter: { face: 'gauge-section' },
      content: {
        points: { face: 'narrow-column' },
        data: { face: 'gauge-stats' },
        evidence: { face: 'one-evidence' },
        statement: { face: 'quote-stage' },
      },
      ending: { face: 'gauge-next' },
    },
    ...overrides,
  }
}

/**
 * Install a fake pptwise package into an in-memory filesystem.
 *
 * `resolvePptwiseCli` reads the package manifest and probes `dist/cli.js`, so both
 * files have to exist before any front-end call will work.
 *
 * @param fs - the fake filesystem.
 * @param options.packageDir - absolute directory to install into.
 * @param options.version - version the manifest reports.
 * @returns a module resolver that answers the pptwise specifier.
 */
export function installFakePptwise(
  fs: FakeFileSystem,
  options: { packageDir: string; version?: string },
): { resolveModule: ModuleResolver } {
  const manifestPath = join(options.packageDir, 'package.json')
  fs.writeText(manifestPath, JSON.stringify({ name: '@liustack/pptwise', version: options.version ?? '0.35.0' }))
  fs.writeText(join(options.packageDir, 'dist', 'cli.js'), '// fake pptwise cli\n')
  const manifestUrl = pathToFileURL(manifestPath).href
  return {
    resolveModule: (specifier: string) => {
      if (specifier === '@liustack/pptwise/package.json') return manifestUrl
      throw new Error(`unexpected specifier ${specifier}`)
    },
  }
}

/**
 * A runner handler that answers `theme new` the way the real CLI does: it writes
 * a complete theme file into the (fake) workspace and reports success.
 *
 * @param fs - the fake filesystem.
 * @param options.workspace - workspace the CLI runs in.
 * @param options.documents - theme documents keyed by preset id.
 * @param options.fallback - handler for every other command.
 * @returns a runner handler.
 */
export function themeHandler(
  fs: FakeFileSystem,
  options: { workspace: string; documents: Record<string, unknown>; fallback?: (call: FakeCall) => Partial<RunResult> },
): (call: FakeCall) => Partial<RunResult> {
  return (call) => {
    const args = [...call.args]
    if (args[1] === 'theme' && args[2] === 'new') {
      const from = args[args.indexOf('--from') + 1] ?? ''
      const output = args[args.indexOf('-o') + 1] ?? 'theme.json'
      const document = options.documents[from] ?? fakeThemeDocument(from)
      fs.writeText(resolve(options.workspace, output), `${JSON.stringify(document, null, 2)}\n`)
      return ok(`wrote ${resolve(options.workspace, output)} (theme "${from}"). Set spec.theme to "${from}".\n`)
    }
    return options.fallback === undefined ? ok() : options.fallback(call)
  }
}
