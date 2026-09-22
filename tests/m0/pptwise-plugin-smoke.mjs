// M0 smoke test: import an installed pptwise DSH plugin and run `apply()`
// against a stub Cordis context, so registration behavior is verified without
// booting (and restarting) the live DSH web service.
//
// Usage: node tests/m0/pptwise-plugin-smoke.mjs <path-to-pptwise-package-dir>
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const packageDir = resolve(process.argv[2] ?? '')
if (!packageDir) {
  console.error('usage: node pptwise-plugin-smoke.mjs <pptwise-package-dir>')
  process.exit(2)
}

const entry = join(packageDir, 'dsh', 'index.js')
const mod = await import(pathToFileURL(entry).href)

const calls = { skills: [], tools: [], injects: [] }
const ctx = {
  skills: { register: (registration) => calls.skills.push(registration) },
  tools: { register: (tool) => calls.tools.push(tool) },
  inject: (deps, closure) => calls.injects.push({ deps, closure }),
}

mod.apply(ctx)

const skill = calls.skills[0]
const report = {
  pluginName: mod.name,
  inject: mod.inject,
  skill: skill && {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    path: skill.path,
    resourceBase: skill.resourceBase,
    contentBytes: Buffer.byteLength(skill.content, 'utf8'),
    hasPreamble: skill.content.includes('node "'),
  },
  tool: calls.tools[0] && {
    name: calls.tools[0].name,
    hasHandler: typeof calls.tools[0].execute === 'function' || typeof calls.tools[0].handler === 'function',
    keys: Object.keys(calls.tools[0]).sort(),
  },
  injects: calls.injects.map((entry) => ({ deps: entry.deps, closureKind: typeof entry.closure })),
}
console.log(JSON.stringify(report, null, 2))
