import { describe, expect, it } from 'vitest'

/** One tool registration, as the plugin hands it to `ctx.tools.register`. */
interface ToolRegistration {
  readonly name: string
  readonly description?: string
}

/** One skill registration, as the plugin hands it to `ctx.skills.register`. */
interface SkillRegistration {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly source?: string
  readonly resourceBase?: { readonly kind: string; readonly path: string }
}

/** The plugin module surface the tests exercise. */
interface PluginModule {
  readonly name: string
  readonly inject: readonly string[]
  readonly SKILL_NAME: string
  readonly PREVIEW_TOOL_NAME: string
  readonly apply: (ctx: FakeContext) => void
  readonly parseSkillMarkdown: (raw: string) => { description: string; body: string }
  readonly dshRuntimePreamble: (cliPath: string, docsDir: string, packageDir: string) => string
}

/** A recording Cordis context. */
interface FakeContext {
  readonly tools: { register: (tool: ToolRegistration) => void }
  readonly skills: { register: (skill: SkillRegistration) => void }
  readonly injected: string[][]
  inject: (services: readonly string[], closure: (scope: object) => void) => void
}

/** @returns the plugin module plus the registrations a fake context captured. */
async function loadPlugin(): Promise<{ plugin: PluginModule; tools: ToolRegistration[]; skills: SkillRegistration[]; injected: string[][] }> {
  const plugin = (await import(new URL('../../dsh/index.js', import.meta.url).href)) as PluginModule
  const tools: ToolRegistration[] = []
  const skills: SkillRegistration[] = []
  const injected: string[][] = []
  const ctx: FakeContext = {
    tools: { register: (tool) => tools.push(tool) },
    skills: { register: (skill) => skills.push(skill) },
    injected,
    inject: (services, closure) => {
      injected.push([...services])
      // The webServer closure runs against the real service in DSH; a bare object
      // exercises the plugin's failure degradation instead. The attachments scope
      // gets a registration surface, which is where the review tool must appear.
      if (services.includes('attachments')) {
        closure({ tools: { register: (tool: ToolRegistration) => tools.push(tool) }, get: () => undefined })
        return
      }
      closure({})
    },
  }
  plugin.apply(ctx)
  return { plugin, tools, skills, injected }
}

describe('dsh plugin entry', () => {
  it('registers the preview and review tools plus the fusion skill', async () => {
    const { plugin, tools, skills, injected } = await loadPlugin()

    expect(plugin.name).toBe('dsh-ppt-fusion')
    expect(plugin.inject).toEqual(['skills', 'tools'])
    expect(tools.map((tool) => tool.name)).toEqual(['dsh_ppt_preview', 'dsh_ppt_review'])
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('dsh-ppt-fusion')
    expect(skills[0]?.source).toBe('bundled')
    expect(skills[0]?.resourceBase?.kind).toBe('directory')
    expect(injected).toEqual([['webServer'], ['attachments']])
  })

  it('injects the CLI mapping and the vendored docs base into the skill body', async () => {
    const { skills } = await loadPlugin()
    const content = skills[0]?.content ?? ''

    expect(content).toContain('node "')
    expect(content).toMatch(/dist[\\/]cli\.js/)
    expect(content).toMatch(/python-assets[\\/]vendor[\\/]ppt-master[\\/]docs/)
    expect(content).toContain('# dsh-ppt-fusion 工作流')
    expect(content).not.toContain('name: dsh-ppt-fusion')
  })

  it('parses the shipped skill frontmatter', async () => {
    const { plugin, skills } = await loadPlugin()
    expect(skills[0]?.description.length ?? 0).toBeGreaterThan(0)
    expect(() => plugin.parseSkillMarkdown('# no frontmatter')).toThrowError(/frontmatter/)
  })
})
