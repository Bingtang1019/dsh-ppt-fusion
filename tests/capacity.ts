// Capacity probe (plan M8.4): synthesize a 60-page all-standard deck from the
// `init` skeleton and measure the full render chain. Run with `pnpm capacity:run`
// and record the numbers in docs/capacity.md.
//
// The deck has no deep pages on purpose: the deep-page cost is measured by the
// golden and theme-matrix gates, and this probe is about scale on the pptwise
// side plus the merge/compat passes.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDependencies } from '../src/commands/context.ts'
import { initDeck } from '../src/commands/init.ts'
import { renderDeck } from '../src/commands/render.ts'
import { readThemeDocument, themePaths } from '../src/deck.ts'
import { parseFusionDeck } from '../src/schema/fusion.ts'
import { storyboardSkeleton } from '../src/schema/storyboard.ts'
import { themeEnsure } from '../src/commands/theme.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const WORK = join(ROOT, 'tmp', 'capacity')
const REPORT = join(ROOT, 'docs', 'capacity.md')
const pagesArg = process.argv.indexOf('--pages')
const PAGES = pagesArg < 0 ? 60 : Number.parseInt(process.argv[pagesArg + 1] ?? '60', 10)
if (!Number.isInteger(PAGES) || PAGES < 2) throw new Error('--pages needs an integer >= 2')

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const deps = defaultDependencies()
initDeck({ dir: WORK, theme: 'brief', deps })

/** Slide ids stay unique so the IR validates at scale. */
const ir = JSON.parse(readFileSync(join(WORK, 'deck.ir.json'), 'utf8')) as { slides: Record<string, unknown>[] }
const skeleton = ir.slides.filter((slide) => slide.placeholder !== true)
if (skeleton.length === 0) throw new Error('init produced no standard slide to cycle')
const slides = Array.from({ length: PAGES }, (_, index) => ({ ...skeleton[index % skeleton.length], id: `p${String(index + 1).padStart(3, '0')}` }))
writeFileSync(join(WORK, 'deck.ir.json'), `${JSON.stringify({ ...ir, slides }, null, 2)}\n`, 'utf8')

const manifest = JSON.parse(readFileSync(join(WORK, 'deck.fusion.json'), 'utf8')) as { pages: unknown }
manifest.pages = slides.map((_, index) => ({ index: index + 1, route: 'pptwise' }))
writeFileSync(join(WORK, 'deck.fusion.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
// The 60-page deck needs its own storyboard: `init` wrote one for two pages. The
// bound theme's menu supplies each page's default layout, exactly as `init` does.
const capacityDeck = parseFusionDeck(JSON.parse(readFileSync(join(WORK, 'deck.fusion.json'), 'utf8')))
const capacityTheme = readThemeDocument(themePaths(WORK, capacityDeck).themePath, deps.fs)
const capacityStoryboard = storyboardSkeleton(
  capacityDeck,
  { slides: slides.map((slide) => ({ type: String((slide as { type?: unknown }).type ?? ''), kind: String((slide as { kind?: unknown }).kind ?? '') })) },
  capacityTheme === null ? undefined : { id: capacityTheme.id, menu: capacityTheme.menu },
)
writeFileSync(join(WORK, 'deck.storyboard.json'), `${JSON.stringify(capacityStoryboard, null, 2)}\n`, 'utf8')
themeEnsure({ dir: WORK, deps })

const started = Date.now()
const rendered = await renderDeck({ dir: WORK, deps })
const elapsedMs = Date.now() - started
const summary = {
  pages: PAGES,
  elapsedMs,
  elapsedSeconds: Math.round(elapsedMs / 100) / 10,
  slides: rendered.slides,
  bytes: rendered.bytes,
  merge: { replaced: rendered.merge.replaced.length, imported: Object.keys(rendered.merge.imported).length, multiMaster: rendered.merge.multiMaster === true },
  compat: { level: rendered.compat.report.level, counts: rendered.compat.report.counts },
}
console.log(JSON.stringify(summary, null, 2))
writeFileSync(
  REPORT,
  [
    '# Capacity (plan M8.4)',
    '',
    `Last measured with \`pnpm capacity:run\` (${new Date().toISOString().slice(0, 10)}):`,
    '',
    `- deck: ${String(PAGES)} standard pages (no deep pages), theme \`brief\`, synthesized from the \`init\` skeleton`,
    `- wall time: ${String(summary.elapsedSeconds)} s (${String(elapsedMs)} ms)`,
    `- package: ${String(rendered.slides)} slide(s), ${String(rendered.bytes)} bytes`,
    `- merge: ${String(rendered.merge.replaced.length)} page(s) replaced, ${String(Object.keys(rendered.merge.imported).length)} part(s) imported, ${rendered.merge.multiMaster ? 'multi-master' : 'single master'}`,
    `- compat: level ${rendered.compat.report.level}, ${String(rendered.compat.report.counts.occurrences)} occurrence(s), ${String(rendered.compat.report.counts.warnings)} warning(s)`,
    '',
    'Guardrail: a future change that makes this probe exceed roughly twice the recorded wall time or',
    'bytes at the same page count needs an ADR explaining the regression or the new baseline. The',
    'probe is a manual gate (`pnpm capacity:run`), not part of `pnpm test`, because it renders a',
    '60-page deck.',
    '',
  ].join('\n'),
  'utf8',
)
console.log(`capacity: wrote ${REPORT}`)
