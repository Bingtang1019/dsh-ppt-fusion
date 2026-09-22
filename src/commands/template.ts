import { basename, join, resolve } from 'node:path'
import { DshPptFailure } from '../engine/errors.ts'
import { toWorkspaceRelative, type TemplateKind, type TemplateRegistryKind } from '../engine/contracts.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'

/** The record `deep template create` leaves inside a template workspace. */
export interface TemplateManifest {
  readonly schema: 'dsh-ppt-fusion.template-manifest.v1'
  readonly kind: TemplateKind
  /** Workspace-relative pptx the template was materialised from. */
  readonly source: string
  /** Workspace-relative import workspace (the round-trip output). */
  readonly importWorkspace: string
  readonly createdAt: string
}

/** Parameters for `dsh-ppt deep template create`. */
export interface TemplateCreateOptions {
  readonly dir: string
  readonly file: string
  /** Template workspace to write, deck-relative. */
  readonly output: string
  readonly kind?: TemplateKind
  readonly deps: CommandDependencies
}

/** What one template creation produced. */
export interface TemplateCreateResult {
  readonly file: string
  readonly importDir: string
  readonly templateDir: string
  readonly kind: TemplateKind
  readonly slides: readonly string[]
  readonly stdout: string
}

/**
 * Materialise a deterministic mirror template from a pptx.
 *
 * Step 1 is the native round-trip import (ADR-038); step 2 is the engine's
 * `mirror-template-materialize`, which writes the factual Design Spec skeleton. The
 * manifest written beside it records where the template came from, so
 * `deep template apply` can name the kind without guessing.
 *
 * @param options - workspace, source pptx, template directory and kind.
 * @returns the import and template directories plus the imported slide list.
 * @throws DshPptFailure when the import or the materialisation fails.
 */
export function deepTemplateCreate(options: TemplateCreateOptions): TemplateCreateResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  const source = toWorkspaceRelative(dir, options.file)
  const stem = basename(source).replace(/\.pptx$/i, '')
  const importDir = toWorkspaceRelative(dir, join(dir, '.dsh-ppt', 'import', stem))
  const templateDir = toWorkspaceRelative(dir, resolve(dir, options.output))
  if (templateDir === '' || templateDir === '.') {
    throw new DshPptFailure('UsageError', 'deep template create needs an output directory inside the deck', { detail: { output: options.output } })
  }
  // Materialisation publishes from a pptx-template-import reference workspace; the
  // source-preserving round trip (pptx-to-svg --roundtrip) is a different output and
  // is consumed directly by apply-template instead (ADR-038).
  engineFor(dir, options.deps).templateImport({ file: source, output: importDir, inheritanceMode: 'both' })
  const slides = listImportedSvgs(options.deps, dir, importDir)
  if (slides.length === 0) {
    throw new DshPptFailure('OutputMissing', `pptx-template-import reported success but wrote no SVG under ${importDir}`, { detail: { importDir } })
  }
  const kind = options.kind ?? 'deck'
  const call = engineFor(dir, options.deps).mirrorTemplateMaterialize({ importWorkspace: importDir, templateWorkspace: templateDir, kind })
  const manifest: TemplateManifest = {
    schema: 'dsh-ppt-fusion.template-manifest.v1',
    kind,
    source,
    importWorkspace: importDir,
    createdAt: new Date().toISOString(),
  }
  fs.writeText(resolve(dir, templateDir, 'template-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { file: source, importDir, templateDir, kind, slides, stdout: call.result.stdout }
}

/** Parameters for `dsh-ppt deep template apply`. */
export interface TemplateApplyOptions {
  readonly dir: string
  /** Initialized project root that receives the templates, deck-relative. */
  readonly project: string
  /** Template workspace roots, deck-relative; at most one per kind. */
  readonly templates: readonly string[]
  readonly dryRun?: boolean
  readonly deps: CommandDependencies
}

/** What one template application produced. */
export interface TemplateApplyResult {
  readonly projectDir: string
  readonly roots: readonly string[]
  readonly kinds: readonly (TemplateKind | null)[]
  readonly stdout: string
}

/**
 * Install template workspace roots into a project (`apply-template`).
 *
 * A root that carries the manifest `deep template create` wrote is typed; two roots
 * of the same kind are refused before the engine runs, because the engine installs
 * one root per kind.
 *
 * @param options - workspace, project root, template roots and dry-run flag.
 * @returns the project and roots that were handed to the engine.
 * @throws DshPptFailure when a path is outside the deck, a root is missing, or two
 *   roots claim the same kind.
 */
export function deepTemplateApply(options: TemplateApplyOptions): TemplateApplyResult {
  const dir = resolveDeckDir(options.deps, options.dir)
  const fs = options.deps.fs
  if (options.templates.length === 0) {
    throw new DshPptFailure('UsageError', 'deep template apply needs at least one --template root', { detail: {} })
  }
  const projectDir = toWorkspaceRelative(dir, options.project)
  if (!fs.isDirectory(resolve(dir, projectDir))) {
    throw new DshPptFailure('OutputMissing', `project directory ${projectDir} does not exist`, { detail: { projectDir } })
  }
  const roots = options.templates.map((template) => toWorkspaceRelative(dir, template))
  for (const root of roots) {
    if (!fs.isDirectory(resolve(dir, root))) {
      throw new DshPptFailure('OutputMissing', `template root ${root} does not exist`, { detail: { root } })
    }
  }
  const kinds = roots.map((root) => readTemplateKind(options.deps, resolve(dir, root)))
  const typed = kinds.filter((kind): kind is TemplateKind => kind !== null)
  const duplicate = typed.find((kind, index) => typed.indexOf(kind) !== index)
  if (duplicate !== undefined) {
    throw new DshPptFailure('ContractViolation', `two template roots claim kind ${duplicate}; apply-template installs one root per kind`, { detail: { kinds } })
  }
  const call = engineFor(dir, options.deps).applyTemplate({
    projectDir,
    roots,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  })
  return { projectDir, roots, kinds, stdout: call.result.stdout }
}

/**
 * Register a template directory in the engine's template index.
 *
 * @param options.kind - template kind the index stores it under.
 * @returns the engine's stdout.
 */
export function templateRegister(options: { dir: string; kind: TemplateRegistryKind; templateId?: string; rebuildAll?: boolean; dryRun?: boolean; deps: CommandDependencies }): string {
  const dir = resolveDeckDir(options.deps, options.dir)
  const call = engineFor(dir, options.deps).registerTemplate({
    kind: options.kind,
    ...(options.templateId === undefined ? {} : { templateId: options.templateId }),
    ...(options.rebuildAll === true ? { rebuildAll: true } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  })
  return call.result.stdout
}

/** @returns the layered import workspace's slide SVGs, workspace-relative. */
function listImportedSvgs(deps: CommandDependencies, dir: string, importDir: string): string[] {
  for (const candidate of ['svg', 'svg-flat']) {
    const path = resolve(dir, importDir, candidate)
    if (!deps.fs.isDirectory(path)) continue
    const files = deps.fs.listDir(path).filter((name) => name.toLowerCase().endsWith('.svg')).sort()
    if (files.length > 0) return files.map((name) => `${importDir}/${candidate}/${name}`)
  }
  return []
}

/** @returns the kind recorded in `<root>/template-manifest.json`, when it has one. */
function readTemplateKind(deps: CommandDependencies, root: string): TemplateKind | null {
  const text = deps.fs.readText(join(root, 'template-manifest.json'))
  if (text === null) return null
  try {
    const raw = JSON.parse(text) as { kind?: unknown }
    return raw.kind === 'deck' || raw.kind === 'layout' ? raw.kind : null
  } catch {
    return null
  }
}
