// DeepSeek Harness (DSH) plugin for dsh-ppt-fusion: registers the fusion SKILL
// and the deck preview tool + route.
//
// Structure follows @liustack/pptwise's dsh/index.js (MIT; see NOTICE): the
// skill body is registered as content with a runtime preamble that maps
// `dsh-ppt <args>` onto this package's own CLI, because the bin is not on PATH
// inside a DSH session, and the playbook's vendored reference paths resolve
// against the package root rather than the session's working directory.
//
// Plain dependency-free JS by design (node builtins only): no build step, no
// dsh type imports, resilient to rc surface drift.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPreviewService, TOOL_NAME } from './preview-tool.js'
import { REVIEW_TOOL_NAME, createReviewService } from './review-tool.js'

const SKILL_FILE_URL = new URL('../skills/dsh-ppt-fusion/SKILL.md', import.meta.url)
const SKILL_DIR = fileURLToPath(new URL('../skills/dsh-ppt-fusion/', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const DOCS_DIR = fileURLToPath(new URL('../python-assets/vendor/ppt-master/docs/', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

export const name = 'dsh-ppt-fusion'
export const inject = ['skills', 'tools']

export const SKILL_NAME = 'dsh-ppt-fusion'
export const PREVIEW_TOOL_NAME = TOOL_NAME
export { REVIEW_TOOL_NAME }

/**
 * Split SKILL.md into { description, body }.
 *
 * DSH's runtime registry does not parse frontmatter (that is the filesystem
 * provider's job), so the `---` block must come off here and the description
 * travels as its own registration field.
 *
 * @param raw - SKILL.md contents.
 * @returns the description and the body without frontmatter.
 */
export function parseSkillMarkdown(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!fm) {
    throw new Error('SKILL.md has no frontmatter block')
  }
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!description) {
    throw new Error('SKILL.md frontmatter has no description field')
  }
  const body = raw.slice(fm[0].length).trim()
  if (body === '') {
    throw new Error('SKILL.md has an empty body')
  }
  return { description, body }
}

/**
 * The DSH-specific note prepended to the skill body.
 *
 * Kept as a function of its paths so tests can pin the contract without
 * touching the module constants.
 *
 * @param cliPath - absolute path of this package's built CLI.
 * @param docsDir - absolute path of the vendored ppt-master docs.
 * @param packageDir - absolute path of this package's root.
 * @returns the markdown preamble.
 */
export function dshRuntimePreamble(cliPath, docsDir, packageDir) {
  return [
    '## DSH runtime note (injected by the dsh-ppt-fusion DSH plugin)',
    '',
    'The `dsh-ppt` bin is not on PATH in this environment. Whenever this playbook says `dsh-ppt <args>`, run this in the terminal instead:',
    '',
    '```bash',
    `node "${cliPath}" <args>`,
    '```',
    '',
    `The playbook's reference documents ship inside this plugin: its \`python-assets/vendor/ppt-master/docs/<file>\` paths resolve against \`${docsDir}\`, and this plugin's root is \`${packageDir}\`.`,
  ].join('\n')
}

/**
 * Register the skill and the preview tool/route on the plugin's context.
 *
 * Failures degrade to one console line each: a skill or tool that cannot
 * register must not take the plugin's host scope down, and the two halves are
 * independent so a tool failure never costs the skill.
 *
 * @param ctx - the Cordis context (services `skills` and `tools`, optional `webServer`).
 */
export function apply(ctx) {
  let skill
  try {
    skill = parseSkillMarkdown(readFileSync(SKILL_FILE_URL, 'utf8'))
  } catch (error) {
    console.error(`[dsh-ppt-fusion] skill registration skipped (cannot read ${fileURLToPath(SKILL_FILE_URL)}): ${error}`)
    return
  }

  // One service per apply(), and the tool and route below are its two halves:
  // they must agree on the same CLI path and the same previews, and a second
  // apply() (plugin reload, a second profile) must get its own pair rather than
  // reaching into the first one's.
  const preview = createPreviewService(CLI_PATH)
  try {
    ctx.tools.register(preview.tool)
  } catch (error) {
    console.error(`[dsh-ppt-fusion] preview tool registration skipped: ${error}`)
  }

  // The route the preview card fetches a rendered deck from. `webServer` exists
  // only under the web profile and this cordis has no optional-inject form, so
  // it rides a scoped `ctx.inject`: the closure runs when the service appears
  // and never runs where it does not, leaving headless untouched.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        preview.registerRoute(scope)
      } catch (error) {
        console.error(`[dsh-ppt-fusion] preview route skipped: ${error}`)
      }
    })
    // The review tool exists only where the deployment can show images to the
    // model: it rides a scoped `attachments` inject, so a headless or
    // text-only profile never advertises a tool it could not honour (ADR-083).
    ctx.inject(['attachments'], (scope) => {
      const review = createReviewService(CLI_PATH, { ctx: scope })
      try {
        scope.tools.register(review.tool)
      } catch (error) {
        console.error(`[dsh-ppt-fusion] review tool registration skipped: ${error}`)
      }
    })
  }

  try {
    // The returned disposer is intentionally unused: register() wires itself as
    // a Cordis effect on the calling context, so disposing this plugin's fiber
    // (plugin remove / reload) unregisters the skill.
    ctx.skills.register({
      name: SKILL_NAME,
      description: skill.description,
      source: 'bundled',
      content: `${dshRuntimePreamble(CLI_PATH, DOCS_DIR, PACKAGE_DIR)}\n\n${skill.body}`,
      path: fileURLToPath(SKILL_FILE_URL),
      resourceBase: { kind: 'directory', path: PACKAGE_DIR },
    })
  } catch (error) {
    console.error(`[dsh-ppt-fusion] skill registration skipped: ${error}`)
  }
}

// Re-exported so the skill directory stays reachable for tooling that wants to
// read the shipped markdown without importing the plugin loader.
export { SKILL_DIR }
