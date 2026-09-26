// Right-sidebar `.pptx` viewer: the host half (ADR-087, plan Part D).
//
// A file tree opens files as `dsh-resource://file/...` addresses and the shell
// renders each one with a document-preview implementation chosen by file suffix.
// `pptx` is on the product's unviewable-binary list, so before this module a deck in
// the tree offered "Open in app" and nothing else. The client half registers a
// document preview for the deck suffixes; this half answers the two requests that
// preview makes:
//
//   GET <route>/view?path=<abs>          a self-contained paging view of the deck
//   GET <route>/page?path=<abs>&index=N  one page image
//
// Both render through the packaged CLI (`renderpages --outside --output-dir`), which
// is the same LibreOffice/PowerPoint path every other snapshot uses, and cache under
// the plugin home keyed by the file's own sha256. The viewer adds no renderer: it
// draws the page images the CLI already knows how to produce.
//
// Plain dependency-free JS by design (node builtins only).
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { runChild } from './spawnHidden.js'

/** Route prefix the client preview fetches from. */
export const PPTX_VIEWER_ROUTE = '/dsh-ppt-pptx'

/** Header every answer from this route carries, success and failure alike. */
export const PPTX_VIEWER_HEADER = 'x-dsh-ppt-pptx'

/** Value of {@link PPTX_VIEWER_HEADER}. */
export const PPTX_VIEWER_HEADER_VALUE = 'dsh-ppt-pptx'

/** Deck suffixes this viewer claims; the client preview declares the same list. */
export const PPTX_VIEWER_EXTENSIONS = ['pptx', 'pptm', 'potx', 'ppsx']

/** Largest deck the viewer will render, in bytes. */
export const PPTX_VIEWER_MAX_BYTES = 200 * 1024 * 1024

/** Engine preference when both engines produced pages. */
const ENGINE_PREFERENCE = ['libreoffice', 'powerpoint']

/** @param path - candidate file path. @returns true when it names a deck this viewer claims. */
export function isDeckPath(path) {
  return typeof path === 'string' && PPTX_VIEWER_EXTENSIONS.includes(extname(path).replace(/^\./, '').toLowerCase())
}

/** @param text - the CLI's stdout. @returns the JSON document it printed. */
function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`the CLI did not print a JSON result: ${text.trim().slice(0, 200)}`)
  return JSON.parse(text.slice(start, end + 1))
}

/** @param html - a text node. @returns the same text with HTML metacharacters escaped. */
function escapeHtml(html) {
  return String(html).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Build the viewer service for one plugin instance.
 *
 * @param cliPath - absolute path of the packaged CLI (`dsh-ppt`).
 * @param options - optional overrides for tests.
 * @param options.cacheRoot - plugin home for rendered pages.
 * @param options.resolveNode - returns the Node executable used for CLI children.
 * @param options.runCli - CLI runner override for tests.
 * @returns the route registrar plus the pure helpers.
 */
export function createPptxViewerService(cliPath, options = {}) {
  const resolveNode = options.resolveNode ?? (() => process.env.npm_node_execpath || process.execPath)
  const runCli =
    options.runCli ??
    ((args, signal) =>
      runChild(resolveNode(), [cliPath, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal }).then(({ code, stdout, stderr }) => {
        if (code === 0) return { stdout, stderr }
        throw new Error(stderr.trim() || stdout.trim() || `dsh-ppt exited with code ${code}`)
      }))
  const cacheRoot = options.cacheRoot ?? join(homedir(), '.dsh', 'ppt-fusion', 'pptx-cache')

  /**
   * Render (or reuse) the pages of one deck file.
   *
   * @param file - absolute path of the deck.
   * @param options.force - ignore the snapshot cache.
   * @returns the engine that produced pages, its page files and the source digest.
   * @throws Error when the file is unusable or no engine produced pages.
   */
  async function ensurePages(file, options = {}) {
    const path = resolve(file)
    if (!isDeckPath(path)) throw new Error(`the viewer only renders ${PPTX_VIEWER_EXTENSIONS.join(', ')} files`)
    const info = await stat(path)
    if (!info.isFile()) throw new Error('the path is not a file')
    if (info.size > PPTX_VIEWER_MAX_BYTES) throw new Error(`the deck is larger than ${String(Math.round(PPTX_VIEWER_MAX_BYTES / 1024 / 1024))} MB`)
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    const root = join(cacheRoot, digest)
    await mkdir(root, { recursive: true })
    // One engine per attempt, in preference order. `--engine both` would probe both
    // on every open — the PowerPoint leg alone costs seconds even when it only
    // reports `skipped` — while a single engine answers from its own cache in well
    // under a second once it has rendered once.
    const failures = []
    for (const engine of [...ENGINE_PREFERENCE, 'both']) {
      let report
      try {
        report = parseJson(
          (
            await runCli(['renderpages', root, '--file', path, '--outside', '--output-dir', root, '--engine', engine, '--json', ...(options.force === true ? ['--force'] : [])])
          ).stdout,
        )
      } catch (error) {
        failures.push(`${engine}: ${error && error.message ? error.message : String(error)}`)
        continue
      }
      const produced = (Array.isArray(report.engines) ? report.engines : []).find((entry) => entry.status !== 'skipped' && Array.isArray(entry.pages) && entry.pages.length > 0)
      if (produced !== undefined) {
        return { root, digest, engine: produced.engine, pages: produced.pages.map((page) => page.index), skipped: Array.isArray(report.skipped) ? report.skipped : [] }
      }
      failures.push(`${engine}: ${(report.skipped ?? []).join('; ') || 'produced no pages'}`)
    }
    throw new Error(`no engine could render this deck: ${failures.join(' | ')}`)
  }

  /**
   * @param html - page body.
   * @param file - the deck being viewed.
   * @returns a self-contained document: no script or style is fetched from anywhere.
   */
  function viewerPage(html, file) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(basename(file))}</title>` +
      `<style>html,body{margin:0;height:100%;font:13px/1.5 system-ui,sans-serif;background:#111;color:#eaeaea}` +
      `header{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid #333;font-size:12px;color:#bbb}` +
      `header b{color:#eee;font-weight:600}main{height:calc(100% - 42px);display:flex;flex-direction:column;gap:8px;padding:8px}` +
      `img.page{flex:1;min-height:0;object-fit:contain;background:#000;border-radius:6px}` +
      `nav{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}nav img{height:56px;border:1px solid #333;border-radius:4px;cursor:pointer;background:#000}` +
      `nav img.on{border-color:#8ab4f8}button{font:inherit;background:#222;color:#eee;border:1px solid #444;border-radius:5px;padding:2px 8px;cursor:pointer}` +
      `</style></head><body>${html}</body></html>`
  }

  /**
   * Serve the viewer and its page images.
   *
   * @param ctx - a scope carrying the harness `webServer` service.
   */
  function registerRoute(ctx) {
    ctx.webServer.register({
      name: 'dsh-ppt-pptx',
      kind: 'prefix',
      path: PPTX_VIEWER_ROUTE,
      handler: async (req, res) => {
        const url = new URL(String(req.url || ''), 'http://127.0.0.1')
        const rest = url.pathname.slice(PPTX_VIEWER_ROUTE.length).replace(/^\/+/, '')
        const file = url.searchParams.get('path') ?? ''
        const force = url.searchParams.get('refresh') === '1'
        const send = (status, headers, body) => {
          res.writeHead(status, { ...headers, [PPTX_VIEWER_HEADER]: PPTX_VIEWER_HEADER_VALUE })
          res.end(body)
        }
        const fail = (status, code, message) => {
          const body = `<!doctype html><meta charset="utf-8"><body style="font:13px/1.6 system-ui,sans-serif;padding:16px">` +
            `<p><b>${escapeHtml(code)}</b></p><p>${escapeHtml(message)}</p></body>`
          send(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) }, body)
        }
        if (file === '' || !isDeckPath(file)) {
          fail(400, 'unsupported-file', `the viewer renders ${PPTX_VIEWER_EXTENSIONS.join(', ')} files`)
          return
        }
        if (rest !== 'view' && rest !== 'page') {
          fail(404, 'unknown-route', `${PPTX_VIEWER_ROUTE}/${rest} is not a viewer route`)
          return
        }
        let rendered
        try {
          rendered = await ensurePages(file, { force })
        } catch (error) {
          fail(502, 'render-failed', error && error.message ? error.message : String(error))
          return
        }
        const pageUrl = (index) => `${PPTX_VIEWER_ROUTE}/page?path=${encodeURIComponent(file)}&index=${String(index)}${force ? '&refresh=1' : ''}`
        if (rest === 'page') {
          const index = Number(url.searchParams.get('index') ?? '1')
          if (!Number.isInteger(index) || !rendered.pages.includes(index)) {
            fail(404, 'unknown-page', `this deck has ${String(rendered.pages.length)} page(s); ${String(index)} is not one of them`)
            return
          }
          try {
            const bytes = await readFile(join(rendered.root, rendered.engine, `page-${String(index).padStart(4, '0')}.png`))
            send(200, { 'content-type': 'image/png', 'content-length': bytes.length, 'cache-control': 'no-store' }, bytes)
          } catch {
            fail(502, 'page-missing', `page ${String(index)} was not written by ${rendered.engine}; try refresh`)
          }
          return
        }
        const first = rendered.pages[0] ?? 1
        const strip = rendered.pages
          .map((index) => `<img data-page="${String(index)}" src="${pageUrl(index)}" alt="page ${String(index)}"${index === first ? ' class="on"' : ''}>`)
          .join('')
        const body = [
          `<header><b>${escapeHtml(basename(file))}</b><span>${String(rendered.pages.length)} page(s)</span>`,
          `<span>${escapeHtml(rendered.engine)}</span><span>sha256 ${rendered.digest.slice(0, 12)}…</span>`,
          `<button onclick="location.search='path=${encodeURIComponent(file)}&refresh=1'">Re-render</button>`,
          `<span style="margin-left:auto" id="counter">page ${String(first)} / ${String(rendered.pages.length)}</span></header>`,
          `<main><img class="page" id="page" src="${pageUrl(first)}" alt="page ${String(first)}"><nav id="strip">${strip}</nav></main>`,
          `<script>(function(){var page=document.getElementById('page');var counter=document.getElementById('counter');var total=${String(rendered.pages.length)};`,
          `function show(n){page.src=pageUrl(n);counter.textContent='page '+n+' / '+total;`,
          `[].forEach.call(document.querySelectorAll('#strip img'),function(th){th.className=th.getAttribute('data-page')===String(n)?'on':'';})}`,
          `function pageUrl(n){return ${JSON.stringify(PPTX_VIEWER_ROUTE + '/page')}+'?path='+encodeURIComponent(${JSON.stringify(file)})+'&index='+n${force ? "+'&refresh=1'" : ''};}`,
          `document.getElementById('strip').addEventListener('click',function(event){var th=event.target.closest('img');if(th)show(Number(th.getAttribute('data-page')));});`,
          `document.addEventListener('keydown',function(event){if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;`,
          `var current=Number((/page (\\d+)/.exec(counter.textContent)||[])[1]||1);var next=event.key==='ArrowRight'?Math.min(total,current+1):Math.max(1,current-1);show(next);});`,
          `})();</script>`,
        ].join('')
        const page = viewerPage(body, file)
        send(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) }, page)
      },
    })
  }

  return { registerRoute, ensurePages, isDeckPath }
}