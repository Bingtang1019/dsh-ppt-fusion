import { join } from 'node:path'
import { isDshPptFailure } from '../engine/errors.ts'
import { loadDeck, readThemeDocument } from '../deck.ts'
import { checkPageCoverage, chromeRoleFor, isPageNumberSkipped, type FusionDeck } from '../schema/fusion.ts'
import {
  STORYBOARD_FILE,
  checkStoryboardAgainstManifest,
  checkStoryboardCoverage,
  checkStoryboardLayouts,
  parseStoryboard,
  type Storyboard,
} from '../schema/storyboard.ts'
import { checkBudgets, formatBudgetViolation, measureDeepSvg, measureIrSlide, type PageMeasurement } from '../schema/budget.ts'
import { missingDeepFiles } from '../schema/deep-page.ts'
import { parseDesignProfile } from '../schema/design-profile.ts'
import { collectPaletteFindings, buildReport, type FusionFinding, type FusionReport } from '../audit.ts'
import { exportTokens, parseThemeFile, tokensEqual, type TokensFile } from '../schema/tokens.ts'
import type { FileSystemPort } from '../engine/venv.ts'
import type { CommandDependencies } from './context.ts'

/**
 * Validate a deck workspace.
 *
 * This is the pre-render gate: it proves the manifest, the IR page list, the
 * storyboard (existence, coverage, role/route agreement, layout legality against the
 * bound theme's menu, per-page content budgets), the deep page files and the theme
 * files agree before anything spends time rendering. Content legality inside
 * pptwise components is pptwise's own business and is checked by the unified audit
 * gate that M4 wires in.
 *
 * @param options.dir - absolute deck workspace.
 * @param options.deps - command dependencies.
 * @returns the aggregate report; deck problems become findings rather than throws.
 */
export function validateDeck(options: { dir: string; deps: CommandDependencies }): FusionReport {
  const { dir, deps } = options
  const sources: string[] = []
  const findings: FusionFinding[] = []

  let context: ReturnType<typeof loadDeck>
  try {
    context = loadDeck(dir, deps.fs)
  } catch (error) {
    const failure = isDshPptFailure(error) ? error : undefined
    findings.push({
      level: 'error',
      source: 'manifest',
      rule: failure?.code === 'OutputMissing' ? 'manifest-missing' : 'manifest-invalid',
      message: failure?.message ?? String(error),
    })
    return buildReport(findings, ['manifest'])
  }

  sources.push('manifest')

  for (const problem of checkPageCoverage(context.deck, context.ir.slides.length)) {
    findings.push({ level: 'error', source: 'manifest', rule: 'page-coverage', message: problem })
  }

  sources.push('ir')

  // The storyboard is the deck's plan (V6 WP2); without it a deck has no per-page
  // contract for role, layout or budget, so its absence is an error.
  sources.push('storyboard')
  const storyboardText = deps.fs.readText(join(dir, STORYBOARD_FILE))
  let storyboard: Storyboard | null = null
  if (storyboardText === null) {
    findings.push({
      level: 'error',
      source: 'storyboard',
      rule: 'storyboard-missing',
      message: `${STORYBOARD_FILE} is absent; run \`dsh-ppt init\` for a skeleton or \`dsh-ppt plan\` and fill role/layout/budget/source`,
    })
  } else {
    try {
      storyboard = parseStoryboard(JSON.parse(storyboardText) as unknown)
      for (const problem of checkStoryboardCoverage(storyboard, context.ir.slides.length)) {
        findings.push({ level: 'error', source: 'storyboard', rule: 'storyboard-coverage', message: problem })
      }
      for (const problem of checkStoryboardAgainstManifest(storyboard, context.deck, context.ir)) {
        findings.push({ level: 'error', source: 'storyboard', rule: 'storyboard-manifest', message: problem })
      }
    } catch (error) {
      findings.push({
        level: 'error',
        source: 'storyboard',
        rule: 'storyboard-invalid',
        message: isDshPptFailure(error) ? error.message : `${STORYBOARD_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  findings.push(...chromeFindings(context.deck, context.ir.slides, dir, deps.fs))

  // A declared design profile must be readable and valid: `render` applies its fonts,
  // so a missing or broken profile is a pre-render finding, not a render crash.
  if (context.deck.designProfile !== undefined) {
    const text = deps.fs.readText(join(dir, context.deck.designProfile))
    if (text === null) {
      findings.push({
        level: 'error',
        source: 'manifest',
        rule: 'design-profile-missing',
        message: `designProfile points at ${context.deck.designProfile} but that file is absent`,
      })
    } else {
      try {
        parseDesignProfile(JSON.parse(text) as unknown)
      } catch (error) {
        findings.push({
          level: 'error',
          source: 'manifest',
          rule: 'design-profile-invalid',
          message: isDshPptFailure(error) ? error.message : `${context.deck.designProfile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  const deepPages = context.deck.pages.filter((page) => page.route === 'ppt-master')
  for (const page of deepPages) {
    const slide = context.ir.slides[page.index - 1]
    if (slide !== undefined && slide.placeholder !== true) {
      findings.push({
        level: 'error',
        source: 'ir',
        page: page.index,
        rule: 'deep-page-not-placeholder',
        message: `page ${String(page.index)} routes to ppt-master but its IR slide is not placeholder:true, so pptwise would render content that the merge replaces`,
      })
    }
    const missing = missingDeepFiles(dir, page.deep, (path) => deps.fs.exists(path))
    if (missing.length > 0) {
      findings.push({
        level: 'error',
        source: 'deep',
        page: page.index,
        rule: 'deep-page-missing-file',
        message: `page ${String(page.index)} is missing ${missing.map((path) => relative(dir, path)).join(', ')}; a deep page is never downgraded to a standard page by itself`,
      })
    }
  }
  if (deepPages.length > 0) sources.push('deep')

  // V6 WP2: every layout must sit in a menu slot its role may use, and every page's
  // measured content must fit its budget. Layouts need the bound theme's menu; the
  // theme gate reports an absent or malformed theme, so the check stays silent then.
  if (storyboard !== null) {
    const theme = readThemeDocument(context.themePath, deps.fs)
    for (const problem of checkStoryboardLayouts(storyboard, theme === null ? null : { id: theme.id, menu: theme.menu })) {
      findings.push({ level: 'error', source: 'storyboard', rule: 'storyboard-layout', message: problem })
    }
    const measurements = new Map<number, PageMeasurement>()
    context.ir.slides.forEach((slide, offset) => measurements.set(offset + 1, measureIrSlide(slide)))
    for (const page of deepPages) {
      const svg = deps.fs.readText(join(dir, page.deep.dir, 'page.svg'))
      if (svg !== null) measurements.set(page.index, measureDeepSvg(svg))
    }
    for (const violation of checkBudgets(storyboard, measurements)) {
      findings.push({ level: 'error', source: 'storyboard', page: violation.page, rule: 'budget-exceeded', message: formatBudgetViolation(violation) })
    }
  }

  if (context.deck.post?.animations !== undefined && context.deck.post.animations !== null) {
    const path = join(dir, context.deck.post.animations)
    if (!deps.fs.exists(path)) {
      findings.push({
        level: 'error',
        source: 'post',
        rule: 'post-animations-missing',
        message: `post.animations points at ${context.deck.post.animations} but that file is absent`,
      })
    }
  }

  findings.push(...themeFindings(context.deck.theme, context.themePath, context.tokensPath, deps))
  sources.push('theme')

  if (context.tokens !== null && deepPages.length > 0) {
    const pages = deepPages.map((page) => ({
      page: page.index,
      path: relative(dir, join(dir, page.deep.dir, 'page.svg')),
      svg: deps.fs.readText(join(dir, page.deep.dir, 'page.svg')) ?? '',
    }))
    findings.push(...collectPaletteFindings(context.tokens, pages))
    sources.push('palette')
  }

  return buildReport(findings, sources)
}

/** Theme-binding findings: the theme file, its identity and the derived token file. */
function themeFindings(
  binding: { preset: string } | { file: string },
  themePath: string,
  tokensPath: string,
  deps: CommandDependencies,
): FusionFinding[] {
  const findings: FusionFinding[] = []
  const themeText = deps.fs.readText(themePath)
  if (themeText === null) {
    findings.push({
      level: 'error',
      source: 'theme',
      rule: 'theme-missing',
      message: `the manifest binds a theme but ${themePath} is absent; run \`dsh-ppt theme ensure\``,
    })
    return findings
  }
  let tokens: TokensFile | null = null
  try {
    const source = 'preset' in binding ? ({ kind: 'preset' as const, preset: binding.preset } as const) : ({ kind: 'file' as const, path: binding.file } as const)
    const theme = parseThemeFile(JSON.parse(themeText))
    if ('preset' in binding && theme.id !== binding.preset) {
      findings.push({
        level: 'error',
        source: 'theme',
        rule: 'theme-id-mismatch',
        message: `${themePath} holds theme "${theme.id}" but the manifest binds preset "${binding.preset}"`,
      })
    }
    tokens = exportTokens(theme, { ...source, upstream: 'unknown' })
  } catch (error) {
    findings.push({
      level: 'error',
      source: 'theme',
      rule: 'theme-invalid',
      message: `${themePath} is not a readable ThemeFile v2: ${error instanceof Error ? error.message : String(error)}`,
    })
    return findings
  }
  const tokensText = deps.fs.readText(tokensPath)
  if (tokensText === null) {
    findings.push({
      level: 'error',
      source: 'theme',
      rule: 'tokens-missing',
      message: `tokens.json is absent; run \`dsh-ppt theme ensure\` to derive it from the theme`,
    })
    return findings
  }
  try {
    const stored = JSON.parse(tokensText) as TokensFile
    const withoutSource = { ...tokens, source: stored.source }
    if (!tokensEqual(withoutSource, stored)) {
      findings.push({
        level: 'error',
        source: 'theme',
        rule: 'tokens-stale',
        message: `tokens.json no longer matches ${themePath}; run \`dsh-ppt theme ensure\` to re-export it`,
      })
    }
  } catch (error) {
    findings.push({
      level: 'error',
      source: 'theme',
      rule: 'tokens-invalid',
      message: `tokens.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  return findings
}

/** @returns `path` relative to `root` with forward slashes, for messages. */
function relative(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : path
}

/**
 * Workspace-level chrome checks the manifest schema cannot express.
 *
 * These run before rendering, so a deck whose chrome contract is unfulfillable
 * fails without spending an engine run. Page geometry and the rendered shapes are
 * the audit gate's job (WP1-P3).
 *
 * @param deck - validated manifest.
 * @param slides - IR slides, aligned by page index.
 * @param dir - absolute deck workspace.
 * @param fs - filesystem port.
 * @returns one finding per violation; empty means the chrome block is consistent.
 */
export function chromeFindings(
  deck: FusionDeck,
  slides: readonly { readonly type?: unknown; readonly kind?: unknown }[],
  dir: string,
  fs: FileSystemPort,
): FusionFinding[] {
  const chrome = deck.chrome
  if (chrome === undefined) return []
  const findings: FusionFinding[] = []
  const declaredSections = deck.pages.filter((page) => page.section !== undefined)
  if (declaredSections.length > 0 && chrome.section === undefined) {
    findings.push({
      level: 'error',
      source: 'manifest',
      rule: 'chrome-section-undeclared',
      message: `pages declare a section (${declaredSections.map((page) => String(page.index)).join(', ')}) but chrome.section is absent; declare chrome.section or drop pages[].section`,
    })
  }
  if (chrome.logo !== undefined && !fs.exists(join(dir, chrome.logo.file))) {
    findings.push({
      level: 'error',
      source: 'manifest',
      rule: 'chrome-logo-missing',
      message: `chrome.logo.file is not in the deck: ${chrome.logo.file}`,
    })
  }
  if (chrome.pageNumber?.show !== false) {
    const roles = deck.pages.map((_page, offset) => {
      const slide = slides[offset]
      return chromeRoleFor(typeof slide?.type === 'string' ? slide.type : undefined, typeof slide?.kind === 'string' ? slide.kind : undefined)
    })
    if (roles.every((role) => isPageNumberSkipped(chrome, role))) {
      findings.push({
        level: 'warning',
        source: 'manifest',
        rule: 'chrome-skip-all',
        message: 'chrome.pageNumber skips every page of this deck; show page numbers somewhere or drop the contract',
      })
    }
  }
  return findings
}
