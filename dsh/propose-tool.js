// DeepSeek Harness (DSH) plugin: the `dsh_ppt_propose` tool and its review card.
//
// The worktree commands (ADR-086) put a draft in `.dsh-ppt/versions/<id>/` and keep
// `out/` untouched until a person approves it. This tool is the in-conversation half
// of that: it runs `propose`, asks for the trunk-versus-draft diff, records one card
// payload under the plugin home, and returns a marker the client card reads.
//
// Three rules, learned from the preview card (see `preview-tool.js`):
//
//  - The model never approves. The tool has no approve parameter and never calls the
//    command; it prints the two commands the user runs. Approval is the one action
//    that changes what the deck *is*.
//  - What the card draws is one request; what it offers is another. The payload is
//    written to a stable path under the plugin home and the route serves it from
//    there, so reopening a transcript hours later still shows the diff the tool saw.
//  - A card that cannot read its payload says so. The route stamps every answer with
//    a header of its own, so the card can tell our 404 (the draft is gone) from a
//    proxy's (this deployment cannot reach the plugin).
//
// Plain dependency-free JS by design (node builtins only).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { runChild } from './spawnHidden.js'

/** Tool name the harness registers. */
export const PROPOSE_TOOL_NAME = 'dsh_ppt_propose'

/** Route prefix the card fetches from. */
export const PROPOSE_ROUTE = '/dsh-ppt-propose'

/** Header every answer from this route carries, success and failure alike. */
export const PROPOSE_ROUTE_HEADER = 'x-dsh-ppt-propose'

/** Value of {@link PROPOSE_ROUTE_HEADER}. */
export const PROPOSE_ROUTE_HEADER_VALUE = 'dsh-ppt-propose'

/** Schema version of a card payload. */
export const PROPOSE_PAYLOAD_SCHEMA_VERSION = 1

/** Page thumbnails one card may attach. */
export const PROPOSE_CARD_PAGES = 8

/** Findings one card payload carries per list. */
export const PROPOSE_CARD_FINDINGS = 8

/** @param value - candidate proposal id. @returns true when it is safe to use as a file name. */
export function isProposalId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value) && !value.includes('..')
}

/**
 * @param options.home - plugin home for card payloads.
 * @returns the directory payloads live in.
 */
function payloadDir(options) {
  return options.home ?? join(homedir(), '.dsh', 'ppt-fusion', 'proposals')
}

/**
 * @param cliPath - absolute path of the packaged CLI.
 * @param resolveNode - returns the Node executable to run it with.
 * @returns a runner resolving with stdout and rejecting with the CLI's own words.
 */
function createCliRunner(cliPath, resolveNode) {
  return (args, signal) =>
    runChild(resolveNode(), [cliPath, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal }).then(({ code, stdout, stderr }) => {
      if (code === 0) return { stdout, stderr }
      throw new Error(stderr.trim() || stdout.trim() || `dsh-ppt exited with code ${code}`)
    })
}

/** @param text - CLI stdout that should hold one JSON document. @returns the parsed document. */
function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`the CLI did not print a JSON result: ${text.trim().slice(0, 200)}`)
  return JSON.parse(text.slice(start, end + 1))
}

/** @param findings - audit findings. @returns at most {@link PROPOSE_CARD_FINDINGS} short entries. */
function summarizeFindings(findings) {
  if (!Array.isArray(findings)) return []
  return findings.slice(0, PROPOSE_CARD_FINDINGS).map((finding) => ({
    page: typeof finding?.page === 'number' ? finding.page : null,
    level: String(finding?.level ?? ''),
    rule: String(finding?.rule ?? ''),
    message: String(finding?.message ?? ''),
  }))
}

/**
 * @param diff - the `diff --json` result.
 * @returns the part of it a card shows, with the lists capped.
 */
function summarizeDiff(diff) {
  const semantic = diff?.semantic
  const audit = diff?.audit
  return {
    summary: String(diff?.summary ?? ''),
    semantic:
      semantic === undefined
        ? null
        : {
            summary: String(semantic.summary ?? ''),
            equal: semantic.equal === true,
            pages: (Array.isArray(semantic.pages) ? semantic.pages : [])
              .filter((page) => page.status !== 'same')
              .slice(0, PROPOSE_CARD_PAGES)
              .map((page) => ({ index: page.index, status: page.status, changedParts: (page.changedParts ?? []).slice(0, 6), notes: (page.notes ?? []).slice(0, 4) })),
            globalParts: (semantic.globalParts ?? []).slice(0, 6),
          },
    audit:
      audit === undefined
        ? null
        : {
            summary: String(audit.summary ?? ''),
            added: summarizeFindings(audit.added),
            removed: summarizeFindings(audit.removed),
          },
    skipped: Array.isArray(diff?.skipped) ? diff.skipped.map(String) : [],
  }
}

/**
 * Build the propose service for one plugin instance.
 *
 * @param cliPath - absolute path of the packaged CLI (`dsh-ppt`).
 * @param options - optional overrides for tests.
 * @param options.home - plugin home for card payloads.
 * @param options.resolveNode - returns the Node executable used for CLI children.
 * @returns the `dsh_ppt_propose` tool, its route registrar and the pure helpers.
 */
export function createProposeService(cliPath, options = {}) {
  const resolveNode = options.resolveNode ?? (() => process.env.npm_node_execpath || process.execPath)
  const runCli = options.runCli ?? createCliRunner(cliPath, resolveNode)
  const home = payloadDir(options)

  /** @param id - proposal id. @returns the absolute payload path. */
  function payloadPath(id) {
    return join(home, `${id}.json`)
  }

  const tool = {
    name: PROPOSE_TOOL_NAME,
    description:
      'Render this deck into an isolated draft version and show it as a review card (diff against the published trunk, page thumbnails, and the two commands a person runs). ' +
      '`out/` is untouched until the user approves; this tool never approves a draft and has no way to. ' +
      'Use it when a change should be reviewed before it becomes the deck.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Deck project directory (the same target the CLI takes).' },
        message: { type: 'string', description: 'Short note describing this draft, shown on the card.' },
        render: { type: 'boolean', description: `Also rasterise the draft pages for the card thumbnails (default true, at most ${String(PROPOSE_CARD_PAGES)} shown).` },
        engine: { type: 'string', enum: ['powerpoint', 'libreoffice', 'both'], description: 'Rasteriser used when render is on; defaults to both.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string' },
          deck: { type: 'string' },
          slides: { type: 'number' },
          sha256: { type: 'string' },
          summary: { type: 'string' },
          approveCommand: { type: 'string' },
          discardCommand: { type: 'string' },
          pruned: { type: 'array', items: { type: 'string' } },
          pages: { type: 'number' },
        },
        required: ['proposalId', 'deck', 'slides', 'sha256', 'summary', 'approveCommand', 'discardCommand'],
        additionalProperties: true,
      },
      render(_args, value) {
        const lines = [
          `draft ${value.proposalId} ready for ${value.deck}: ${String(value.slides)} slide(s), sha256 ${String(value.sha256).slice(0, 12)}… — out/ untouched`,
          `diff trunk -> ${value.proposalId}: ${value.summary}`,
          `approve (a person runs this): ${value.approveCommand}`,
          `discard: ${value.discardCommand}`,
          `dsh-ppt-propose:${value.proposalId}`,
        ]
        if (Array.isArray(value.pruned) && value.pruned.length > 0) lines.splice(4, 0, `pruned: ${value.pruned.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta(_args, value) {
        return { card: 'dsh-ppt-propose', proposeId: value.proposalId, payload: value.payload }
      },
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const target = String(args.target ?? '').trim()
      if (target === '') throw new Error('target must be a non-empty deck directory')
      const deckDir = resolve(target)
      const render = args.render !== false
      const proposeArgs = ['propose', deckDir, '--json', '--engine', String(args.engine ?? 'both')]
      if (render) proposeArgs.push('--render')
      if (typeof args.message === 'string' && args.message.trim() !== '') proposeArgs.push('--message', args.message.trim())
      const proposed = parseJson((await runCli(proposeArgs, exec?.signal)).stdout)
      const view = proposed?.view
      if (view === undefined || typeof view.id !== 'string') throw new Error('the CLI did not report a proposal id')
      const id = view.id
      const diff = parseJson((await runCli(['diff', deckDir, 'trunk', id, '--json'], exec?.signal)).stdout)
      let versions = { views: [], trunk: null }
      try {
        versions = parseJson((await runCli(['versions', deckDir, '--json'], exec?.signal)).stdout)
      } catch {
        // A deck with drafts always answers `versions`; a failure here must not cost
        // the card its diff, so the history list simply comes back empty.
      }
      const pages = (Array.isArray(proposed?.pages?.engines) ? proposed.pages.engines : [])
        .flatMap((engine) => (Array.isArray(engine?.pages) ? engine.pages : []).map((page) => ({ engine: engine.engine, index: page.index, file: page.file })))
        .slice(0, PROPOSE_CARD_PAGES)
        .map((page) => ({
          index: page.index,
          engine: page.engine,
          // The route serves this file directly, so it has to be the absolute path
          // the render step wrote: `<deck>/.dsh-ppt/versions/<id>/pages/<engine>/…`.
          path: join(deckDir, '.dsh-ppt', 'versions', id, 'pages', page.engine, page.file),
          url: `${PROPOSE_ROUTE}/${id}/page-${String(page.index)}.png`,
        }))
      const payload = {
        schemaVersion: PROPOSE_PAYLOAD_SCHEMA_VERSION,
        id,
        deck: deckDir,
        // The rendered package carries the deck's own name; the directory is just where it lives.
        deckName: deckNameOf(view.record?.source?.file) ?? basename(deckDir),
        message: view.record?.message ?? null,
        createdAt: view.record?.createdAt ?? null,
        slides: view.record?.source?.slides ?? 0,
        sha256: view.record?.source?.sha256 ?? '',
        pptx: view.record?.files?.pptx ?? '',
        trunk: versions?.trunk?.id ?? null,
        pruned: Array.isArray(proposed?.pruned) ? proposed.pruned : [],
        diff: summarizeDiff(diff),
        pages,
        commands: {
          approve: `dsh-ppt approve ${deckDir} ${id}`,
          discard: `dsh-ppt discard ${deckDir} ${id}`,
          diff: `dsh-ppt diff ${deckDir} trunk ${id}`,
        },
        history: (Array.isArray(versions?.views) ? versions.views : [])
          .filter((entry) => entry?.record?.createdAt !== undefined)
          .slice(0, 10)
          .map((entry) => ({ id: entry.id, status: entry.status?.status ?? 'draft', createdAt: entry.record.createdAt, message: entry.record.message ?? null })),
      }
      await mkdir(home, { recursive: true })
      await writeFile(payloadPath(id), `${JSON.stringify(payload, null, 2)}\n`)
      return {
        proposalId: id,
        deck: deckDir,
        slides: payload.slides,
        sha256: payload.sha256,
        // The card and the transcript both want the verdict rather than the tool's own
        // first line, so the summary is assembled from the modes that actually ran.
        summary: [payload.diff.semantic?.summary, payload.diff.audit?.summary].filter((part) => typeof part === 'string' && part !== '').join('; ') || 'no comparable change recorded',
        approveCommand: payload.commands.approve,
        discardCommand: payload.commands.discard,
        pruned: payload.pruned,
        pages: pages.length,
        payload,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Propose ${String(args.target)}`, kind: 'read', locations: [{ path: String(args.target) }] }
    },
  }

  /**
   * Serve card payloads and page thumbnails.
   *
   * @param ctx - a scope carrying the harness `webServer` service.
   */
  function registerRoute(ctx) {
    ctx.webServer.register({
      name: 'dsh-ppt-propose',
      kind: 'prefix',
      path: PROPOSE_ROUTE,
      handler: async (req, res) => {
        const rest = String(req.url || '').split('?')[0].slice(PROPOSE_ROUTE.length).replace(/^\/+/, '')
        const pageMatch = /^([A-Za-z0-9._-]{1,64})\/page-(\d+)\.png$/.exec(rest)
        const id = pageMatch === null ? rest : pageMatch[1]
        const send = (status, headers, body) => {
          res.writeHead(status, { ...headers, [PROPOSE_ROUTE_HEADER]: PROPOSE_ROUTE_HEADER_VALUE })
          res.end(body)
        }
        const fail = (status, code, message) => send(status, { 'content-type': 'application/json' }, JSON.stringify({ code, error: message }))
        if (!isProposalId(id)) {
          fail(400, 'invalid-id', 'a proposal id is letters, digits, dot, dash and underscore')
          return
        }
        let payload
        try {
          payload = JSON.parse(await readFile(payloadPath(id), 'utf8'))
        } catch {
          fail(404, 'unknown-proposal', `this deployment has no card payload for ${id}; run the tool again to rebuild it`)
          return
        }
        if (pageMatch === null) {
          const body = JSON.stringify(payload)
          send(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }, body)
          return
        }
        const index = Number(pageMatch[2])
        const page = (Array.isArray(payload.pages) ? payload.pages : []).find((entry) => entry.index === index)
        if (page === undefined) {
          fail(404, 'unknown-page', `the draft has no page ${String(index)}`)
          return
        }
        const file = normalizePagePath(page.path)
        if (file === null) {
          fail(500, 'damaged-payload', 'the card payload does not name a readable page file')
          return
        }
        try {
          const bytes = await readFile(file)
          send(200, { 'content-type': 'image/png', 'content-length': bytes.length, 'cache-control': 'no-store' }, bytes)
        } catch {
          fail(404, 'missing-page', `page ${String(index)} of ${id} is no longer on disk; re-run the tool to snapshot it again`)
        }
      },
    })
  }

  return { tool, registerRoute, summarizeDiff, isProposalId }
}

/**
 * @param value - a page path from a card payload.
 * @returns the path when it is a `.png` under a version directory, else null.
 */
function normalizePagePath(value) {
  if (typeof value !== 'string' || !value.toLowerCase().endsWith('.png')) return null
  const full = resolve(value)
  const marker = `${sep}.dsh-ppt${sep}versions${sep}`
  return full.includes(marker) ? full : null
}
/**
 * @param file - the proposal's deck-relative package path.
 * @returns the package's base name without its extension, or null.
 */
function deckNameOf(file) {
  if (typeof file !== 'string' || file === '') return null
  const base = file.split(/[\\/]/).pop() ?? ''
  const name = base.replace(/\.pptx$/i, '')
  return name === '' ? null : name
}
