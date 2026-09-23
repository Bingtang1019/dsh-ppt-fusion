/**
 * Model-eval harness for plan M6: run one scenario through the shipped headless
 * agent, then judge the produced workspace with `tests/eval/rubric.ts`.
 *
 * The harness owns process effects (staging, spawning the agent, reading the
 * session log, inspecting the package) and keeps the pass/fail rules in
 * `rubric.ts`. It is a development tool: nothing here is imported by the package.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import yaml from 'js-yaml'
import JSZip from 'jszip'
import { auditDeck } from '../../src/commands/audit.ts'
import { defaultDependencies } from '../../src/commands/context.ts'
import { CHECK_IDS, CHECK_SEVERITY, attemptPassed, evaluateRubric, type CheckId, type DeckObservation, type RubricCheckResult, type ScenarioSpec } from './rubric.ts'

/** Where an eval run keeps its workspaces and reports. */
export const EVAL_DIR = 'tmp/eval'

/** What the harness needs to know about one scenario's run. */
export interface ScenarioRun {
  readonly scenario: ScenarioSpec
  readonly passed: boolean
  readonly attempts: readonly AttemptResult[]
}

/** One agent attempt and its judgement. */
export interface AttemptResult {
  readonly attempt: number
  readonly passed: boolean
  readonly checks: readonly RubricCheckResult[]
  readonly observation: DeckObservation
  readonly metrics: SessionMetrics
  readonly wallTimeMs: number
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly workspace: string
  readonly deckDir: string
  readonly sessionFile: string | null
  /** Non-null when the harness never reached the model (quota, auth), so retrying is pointless. */
  readonly infrastructure: string | null
}

/** Process facts recovered from the headless session log. */
export interface SessionMetrics {
  readonly sessionFile: string | null
  readonly turns: number
  readonly toolCalls: number
  readonly toolCallsByName: Readonly<Record<string, number>>
  readonly failedToolCalls: number
  readonly gateFailures: number
  readonly skillLoads: number
  readonly checkpointCommands: number
  readonly startedAt: number | null
  readonly endedAt: number | null
}

/** Options that change how a scenario is run. */
export interface RunScenarioOptions {
  /** Cap on attempts, at most the scenario's own `maxAttempts`. */
  readonly maxAttempts?: number
  /** Keep the agent's stdout/stderr in the result (it is always kept on disk). */
  readonly keepOutput?: boolean
}

/** Absolute path of this checkout's root. */
export function repositoryRoot(moduleUrl: string): string {
  return resolve(dirname(new URL(moduleUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
}

/**
 * Load one scenario YAML and validate its shape.
 *
 * @param root - repository root.
 * @param name - scenario file stem, e.g. `topic-only`.
 * @returns the validated scenario.
 * @throws Error naming the field when the file is missing or malformed.
 */
export function loadScenario(root: string, name: string): ScenarioSpec {
  const file = join(root, 'fixtures', 'scenarios', `${name}.yaml`)
  if (!existsSync(file)) throw new Error(`unknown scenario ${name}: ${file} does not exist`)
  const raw = yaml.load(readFileSync(file, 'utf8')) as Partial<ScenarioSpec> | null
  if (raw === null || typeof raw !== 'object') throw new Error(`${file} is not a YAML mapping`)
  if (typeof raw.name !== 'string' || raw.name !== name) throw new Error(`${file}: name must be ${name}`)
  if (typeof raw.title !== 'string') throw new Error(`${file}: title must be a string`)
  if (typeof raw.maxAttempts !== 'number' || raw.maxAttempts < 1) throw new Error(`${file}: maxAttempts must be >= 1`)
  if (typeof raw.task !== 'string' || raw.task.trim() === '') throw new Error(`${file}: task must be a non-empty string`)
  const inputs = raw.inputs ?? []
  if (!Array.isArray(inputs)) throw new Error(`${file}: inputs must be a list`)
  const rubric = raw.rubric
  if (rubric === undefined) throw new Error(`${file}: rubric is required`)
  for (const key of ['minSlides', 'maxSlides'] as const) {
    if (typeof rubric[key] !== 'number') throw new Error(`${file}: rubric.${key} must be a number`)
  }
  if (rubric.minSlides < 1 || rubric.maxSlides < rubric.minSlides) throw new Error(`${file}: rubric.minSlides/maxSlides are inconsistent`)
  for (const key of ['requireTextShapes', 'requireNativeChart', 'requireNativeTable', 'requireAttribution', 'requireCheckpoint', 'requireBrandTheme'] as const) {
    if (typeof rubric[key] !== 'boolean') throw new Error(`${file}: rubric.${key} must be a boolean`)
  }
  if (rubric.requireDesignProfile !== undefined && typeof rubric.requireDesignProfile !== 'boolean') {
    throw new Error(`${file}: rubric.requireDesignProfile must be a boolean`)
  }
  return {
    name,
    title: raw.title,
    maxAttempts: raw.maxAttempts,
    task: raw.task,
    inputs: inputs.map((entry) => {
      if (typeof entry?.from !== 'string' || typeof entry?.to !== 'string') throw new Error(`${file}: each input needs from/to strings`)
      return { from: entry.from, to: entry.to }
    }),
    rubric: {
      minSlides: rubric.minSlides,
      maxSlides: rubric.maxSlides,
      requireTextShapes: rubric.requireTextShapes,
      requireNativeChart: rubric.requireNativeChart,
      requireNativeTable: rubric.requireNativeTable,
      requireAttribution: rubric.requireAttribution,
      requireCheckpoint: rubric.requireCheckpoint,
      requireBrandTheme: rubric.requireBrandTheme,
      requireDesignProfile: rubric.requireDesignProfile === true,
    },
  }
}

/** @returns every scenario stem under `fixtures/scenarios/`. */
export function listScenarios(root: string): string[] {
  return readdirSync(join(root, 'fixtures', 'scenarios'))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.replace(/\.yaml$/, ''))
    .sort()
}

/**
 * Run one scenario until it passes or its attempt budget is spent.
 *
 * @param root - repository root.
 * @param scenario - loaded scenario.
 * @param options - attempt cap.
 * @returns every attempt in order; `passed` is true when one of them passed.
 */
export async function runScenario(root: string, scenario: ScenarioSpec, options: RunScenarioOptions = {}): Promise<ScenarioRun> {
  const limit = Math.min(scenario.maxAttempts, options.maxAttempts ?? scenario.maxAttempts)
  const attempts: AttemptResult[] = []
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const result = await runAttempt(root, scenario, attempt)
    attempts.push(result)
    if (result.passed) break
    // An aborted boot (no balance, bad key) will not succeed on a retry.
    if (result.infrastructure !== null) break
  }
  return { scenario, passed: attempts.some((attempt) => attempt.passed), attempts }
}

/**
 * Run one agent attempt: stage the workspace, boot the headless profile, then judge.
 *
 * @param root - repository root.
 * @param scenario - loaded scenario.
 * @param attempt - 1-based attempt number, used as the workspace name.
 * @returns the attempt result, including the raw agent output.
 */
export async function runAttempt(root: string, scenario: ScenarioSpec, attempt: number): Promise<AttemptResult> {
  const attemptDir = join(root, EVAL_DIR, scenario.name, `attempt-${String(attempt)}`)
  const workspace = join(attemptDir, 'work')
  const home = join(attemptDir, 'home')
  rmSync(attemptDir, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home, { recursive: true })
  stageInputs(root, scenario, workspace)
  const shimDir = join(attemptDir, 'bin')
  writeShims(root, shimDir)
  const launcher = writeLauncher(attemptDir, root)
  const patch = writePatch(attemptDir, root)
  const deckDir = join(workspace, 'deck')
  const task = scenario.task.replaceAll('{{workspace}}', workspace).replaceAll('{{deck}}', deckDir)
  const launch = resolveAgentLaunch(root, launcher, patch, task, workspace, home, shimDir)
  const startedAt = Date.now()
  const spawned = spawnSync(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    encoding: 'utf8',
    timeout: 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  const wallTimeMs = Date.now() - startedAt
  const stdout = spawned.stdout ?? ''
  const stderr = spawned.stderr ?? (spawned.error === undefined ? '' : String(spawned.error))
  writeFileSync(join(attemptDir, 'agent.stdout.txt'), stdout, 'utf8')
  writeFileSync(join(attemptDir, 'agent.stderr.txt'), stderr, 'utf8')
  const metrics = readSessionMetrics(home)
  const observation = await observeDeck(workspace, deckDir)
  const checks = evaluateRubric(scenario.rubric, observation)
  const infrastructure = detectInfrastructure(stderr, metrics)
  return {
    attempt,
    passed: attemptPassed(checks),
    checks,
    observation,
    metrics,
    wallTimeMs,
    exitCode: spawned.status,
    stdout,
    stderr,
    workspace,
    deckDir,
    sessionFile: metrics.sessionFile,
    infrastructure,
  }
}

/**
 * @param stderr - agent stderr.
 * @param metrics - session metrics of the attempt.
 * @returns the vendor message when the boot never reached the model, else null.
 */
function detectInfrastructure(stderr: string, metrics: SessionMetrics): string | null {
  if (metrics.toolCalls > 0) return null
  const match = /(QUOTA:[^\n]*|Insufficient Balance|invalid api key|authentication[^\n]*)/i.exec(stderr)
  return match === null ? null : match[0].trim()
}

/** Copy the scenario's staged inputs into the workspace. */
function stageInputs(root: string, scenario: ScenarioSpec, workspace: string): void {
  for (const input of scenario.inputs) {
    const from = join(root, input.from)
    if (!existsSync(from)) throw new Error(`scenario ${scenario.name}: input ${input.from} does not exist`)
    const to = join(workspace, input.to)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
}

/**
 * Write the boot launcher the harness spawns.
 *
 * The launcher changes the process cwd to the scenario workspace before the app
 * loads, so the agent, the sandbox policy and the session log all use that
 * workspace while `tsx/esm` still resolves from the harness checkout.
 *
 * @param attemptDir - attempt directory.
 * @param root - repository root (kept for symmetry with the other writers).
 * @returns absolute launcher path.
 */
function writeLauncher(attemptDir: string, root: string): string {
  const harness = harnessRoot(root)
  const bin = pathToFileURL(join(harness, 'apps', 'cli', 'src', 'bin.ts')).href
  const path = join(attemptDir, 'dsh-launcher.mjs')
  writeFileSync(
    path,
    [
      '// Generated by tests/eval/harness.ts: pin the workspace, then boot the app.',
      'process.chdir(process.env.DSH_PPT_EVAL_CWD);',
      `await import(${JSON.stringify(bin)});`,
      '',
    ].join('\n'),
    'utf8',
  )
  return path
}

/** @returns the harness checkout the eval runs against. */
export function harnessRoot(root: string): string {
  return process.env.DSH_HARNESS_ROOT ?? join(dirname(root), 'deepseek-harness')
}

/** Write the patch overlay that mounts this checkout's skills. */
function writePatch(attemptDir: string, root: string): string {
  const path = join(attemptDir, 'headless.patch.yml')
  writeFileSync(
    path,
    [
      '# Generated by tests/eval/harness.ts: mount the fusion skills for the eval session.',
      '- id: skill-filesystem',
      '  config:',
      '    customSkillDirs:',
      `      - '${join(root, 'skills').replace(/\\/g, '/')}'`,
      '',
    ].join('\n'),
    'utf8',
  )
  return path
}

/** Everything `spawnSync` needs for one agent boot. */
interface AgentLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/**
 * Resolve the command that boots the shipped headless profile.
 *
 * `DSH_HARNESS_ROOT` selects a source checkout (booted through `tsx/esm`); with
 * no override an installed `dsh` command is used instead.
 */
function resolveAgentLaunch(root: string, launcher: string, patch: string, task: string, workspace: string, home: string, shimDir: string): AgentLaunch {
  const harness = harnessRoot(root)
  const fromSource = existsSync(join(harness, 'apps', 'cli', 'src', 'bin.ts'))
  const key = readApiKey(home)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_PPT_EVAL_CWD: workspace,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
    PATH: `${shimDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    ...key,
  }
  if (fromSource) {
    return {
      command: process.execPath,
      args: ['--import', 'tsx/esm', launcher, '--profile', 'headless', '--patch', patch, task],
      cwd: harness,
      env,
    }
  }
  return {
    command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: ['--profile', 'headless', '--patch', patch, task],
    cwd: workspace,
    env,
  }
}

/** @returns the credential environment the headless profile needs, when it is not already exported. */
function readApiKey(home: string): NodeJS.ProcessEnv {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '') return {}
  const candidates = [join(home, '.credentials.yaml'), join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const match = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(readFileSync(candidate, 'utf8'))
    if (match !== null) return { DEEPSEEK_API_KEY: match[1] }
  }
  throw new Error('DEEPSEEK_API_KEY is not set and no .credentials.yaml was found; the model eval needs a key')
}

/** Write the two `dsh-ppt` shims into the attempt's PATH directory. */
export function writeShims(root: string, shimDir: string): void {
  mkdirSync(shimDir, { recursive: true })
  const cli = join(root, 'dist', 'cli.js')
  if (!existsSync(cli)) throw new Error(`the eval runs the built CLI at ${cli}; run \`pnpm build\` first`)
  writeFileSync(join(shimDir, 'dsh-ppt.cmd'), `@echo off\r\nnode "${cli}" %*\r\n`, 'utf8')
  writeFileSync(join(shimDir, 'dsh-ppt'), `#!/bin/sh\nexec node "${cli}" "$@"\n`, 'utf8')
  writeFileSync(join(shimDir, 'dsh-ppt.ps1'), `#!/usr/bin/env pwsh\nnode "${cli}" @args\n`, 'utf8')
}

/**
 * Read the headless session log and recover process metrics.
 *
 * The CLI appends one zstd frame per event, so the file is read by splitting on
 * the frame magic and decompressing every frame; a missing log yields zeroes.
 *
 * @param home - the attempt's `$DSH_HOME`.
 * @returns the recovered metrics.
 */
export function readSessionMetrics(home: string): SessionMetrics {
  const file = findSessionLog(join(home, 'sessions'))
  if (file === null) {
    return emptyMetrics(null)
  }
  const events = decodeSessionEvents(readFileSync(file))
  const calls = new Map<string, string>()
  const byName: Record<string, number> = {}
  let failedToolCalls = 0
  let gateFailures = 0
  let skillLoads = 0
  let checkpointCommands = 0
  let turns = 0
  let startedAt: number | null = null
  let endedAt: number | null = null
  for (const event of events) {
    const record = event as { type?: string; time?: number; data?: { name?: string; arguments?: string; callId?: string; message?: unknown; turn?: number } }
    if (record.type === 'turn/start') {
      turns += 1
      if (startedAt === null) startedAt = record.time ?? null
    }
    if (record.type === 'turn/end') endedAt = record.time ?? endedAt
    if (record.type === 'tool/call') {
      const name = record.data?.name ?? 'unknown'
      byName[name] = (byName[name] ?? 0) + 1
      const callId = record.data?.callId ?? ''
      const args = record.data?.arguments ?? ''
      calls.set(callId, `${name} ${args}`)
      if (name === 'skill') skillLoads += 1
      if (/checkpoint|resume/i.test(args)) checkpointCommands += 1
    }
    if (record.type === 'tool/result') {
      const error = toolResultFailed(record.data?.message)
      const output = textOf(record.data?.message)
      const call = calls.get(extractCallId(record.data?.message) ?? '') ?? ''
      if (error) failedToolCalls += 1
      // A gate failure is a command that named `dsh-ppt` and answered with an error
      // marker, whether the shell reported it as an error or just printed the code.
      if ((error || /dsh-ppt: [A-Za-z]+|quality_gate=failed|audit failed|validate: failed/.test(output)) && /dsh-ppt/.test(call)) gateFailures += 1
    }
  }
  return {
    sessionFile: file,
    turns,
    toolCalls: Object.values(byName).reduce((sum, count) => sum + count, 0),
    toolCallsByName: byName,
    failedToolCalls,
    gateFailures,
    skillLoads,
    checkpointCommands,
    startedAt,
    endedAt,
  }
}

/** @returns the newest session log under `dir`, or null. */
function findSessionLog(dir: string): string | null {
  if (!existsSync(dir)) return null
  const found: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name === 'session.jsonl' || name === 'session.jsonl.zstd') found.push(path)
    }
  }
  walk(dir)
  found.sort()
  return found[found.length - 1] ?? null
}

/** @returns the decoded JSONL events of one session log. */
function decodeSessionEvents(bytes: Buffer): readonly unknown[] {
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    const offsets: number[] = []
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
      if (bytes[index] === 0x28 && bytes[index + 1] === 0xb5 && bytes[index + 2] === 0x2f && bytes[index + 3] === 0xfd) offsets.push(index)
    }
    const parts: Buffer[] = []
    for (let frame = 0; frame < offsets.length; frame += 1) {
      const end = frame + 1 < offsets.length ? offsets[frame + 1] : bytes.length
      try {
        parts.push(zstdDecompressSync(bytes.subarray(offsets[frame], end)))
      } catch {
        // A torn trailing frame is a killed session; the frames before it are the record.
      }
    }
    return parseJsonLines(Buffer.concat(parts).toString('utf8'))
  }
  return parseJsonLines(bytes.toString('utf8'))
}

/** @returns parsed JSON objects, skipping blank or unparsable lines. */
function parseJsonLines(text: string): unknown[] {
  const events: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as unknown)
    } catch {
      // A truncated line only happens after a kill; the remaining events are still usable.
    }
  }
  return events
}

/** @returns true when a `tool/result` payload carries `isError`. */
function toolResultFailed(message: unknown): boolean {
  const content = (message as { content?: { content?: { isError?: boolean }[] }[] } | undefined)?.content
  return Array.isArray(content) && content.some((part) => part?.content?.some((leaf) => leaf?.isError === true))
}

/** @returns the tool call id inside a `tool/result` payload. */
function extractCallId(message: unknown): string | null {
  const source = (message as { source?: { callId?: string } } | undefined)?.source
  return typeof source?.callId === 'string' ? source.callId : null
}

/** @returns all text inside a `tool/result` payload. */
function textOf(message: unknown): string {
  const content = (message as { content?: { content?: { text?: string }[] }[] } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => (part?.content ?? []).map((leaf) => leaf?.text ?? '')).join('\n')
}

/** @returns zeroed metrics when no session log exists. */
function emptyMetrics(sessionFile: string | null): SessionMetrics {
  return {
    sessionFile,
    turns: 0,
    toolCalls: 0,
    toolCallsByName: {},
    failedToolCalls: 0,
    gateFailures: 0,
    skillLoads: 0,
    checkpointCommands: 0,
    startedAt: null,
    endedAt: null,
  }
}

/**
 * Inspect the finished workspace: run the audit gate and read the package parts.
 *
 * @param workspace - scenario workspace.
 * @param deckDir - expected deck directory.
 * @returns one observation for the rubric.
 */
export async function observeDeck(workspace: string, deckDir: string): Promise<DeckObservation> {
  const manifest = readJson(join(deckDir, 'out', 'manifest.json')) as { slides?: unknown; file?: unknown } | null
  const deckManifest = readJson(join(deckDir, 'deck.fusion.json')) as { theme?: { file?: unknown }; chrome?: unknown; designProfile?: unknown } | null
  const themeFile = typeof deckManifest?.theme?.file === 'string' ? deckManifest.theme.file : null
  const themeFileExists = themeFile !== null && existsSync(join(deckDir, themeFile))
  const checkpoint = readJson(join(deckDir, '.dsh-ppt', 'checkpoint.json')) as { phase?: unknown } | null
  const phase = checkpoint?.phase
  const checkpointPhase = typeof phase === 'string' || typeof phase === 'number' ? String(phase) : null
  const slides = typeof manifest?.slides === 'number' ? manifest.slides : null
  const artifact = typeof manifest?.file === 'string' ? join(deckDir, manifest.file) : null

  const parts = artifact !== null && existsSync(artifact) ? await readPackageParts(artifact) : null
  const attribution = readAttribution(join(deckDir, 'assets', 'image_sources.json'))

  let auditOk: boolean | null = null
  let auditErrorCount = 0
  let auditSkipped: string[] = []
  let auditFindings: readonly { level: string; source: string; rule: string; message: string }[] = []
  if (existsSync(deckDir)) {
    try {
      const report = await auditDeck({ dir: deckDir, strict: false, pixels: false, deps: defaultDependencies({ cwd: workspace }) })
      auditOk = report.ok
      auditErrorCount = report.findings.filter((finding) => finding.level === 'error').length
      auditSkipped = [...report.skipped]
      auditFindings = report.findings
    } catch (error) {
      writeFileSync(join(deckDir, '.dsh-ppt', 'eval-audit-error.txt'), String(error), 'utf8')
    }
  }
  // The audit merges the validate gate's findings, so the storyboard and chrome
  // rows can be derived from one report (V6 WP2 / V7 A1).
  const errors = auditFindings.filter((finding) => finding.level === 'error')
  const describe = (finding: { rule: string; message: string }): string => `${finding.rule}: ${finding.message}`
  const storyboardErrors = errors.filter((finding) => finding.source === 'storyboard')
  const chromeDeclared = deckManifest?.chrome !== undefined

  // V7.2 B5/S26: when the deck declares a profile, re-run the audit with it and
  // keep only the design-source errors; the profile is the quality bar the deck
  // must reproduce inside the tolerances.
  let designProfileOk: boolean | null = null
  let designProfileProblems: string[] = []
  const profileFile =
    typeof deckManifest?.designProfile === 'string' && deckManifest.designProfile !== ''
      ? deckManifest.designProfile
      : existsSync(join(deckDir, 'design-profile.json'))
        ? 'design-profile.json'
        : null
  if (profileFile !== null && existsSync(deckDir)) {
    try {
      const report = await auditDeck({ dir: deckDir, strict: false, pixels: false, profile: profileFile, deps: defaultDependencies({ cwd: workspace }) })
      const designErrors = report.findings.filter((finding) => finding.source === 'design' && finding.level === 'error')
      designProfileOk = designErrors.length === 0
      designProfileProblems = designErrors.map(describe)
    } catch (error) {
      designProfileOk = false
      designProfileProblems = [error instanceof Error ? error.message : String(error)]
    }
  }

  return {
    auditOk,
    auditErrorCount,
    auditSkipped,
    slides,
    slidesWithTextShapes: parts?.slidesWithTextShapes ?? null,
    masterCount: parts?.masterCount ?? null,
    chartParts: parts?.chartParts ?? [],
    hasTable: parts?.hasTable ?? false,
    attributionProblems: attribution.problems,
    attributionPresent: attribution.present,
    checkpointPhase,
    themeFile,
    themeFileExists,
    storyboardPresent: existsSync(join(deckDir, 'deck.storyboard.json')),
    storyboardProblems: storyboardErrors.filter((finding) => finding.rule !== 'storyboard-layout' && finding.rule !== 'budget-exceeded').map(describe),
    layoutProblems: storyboardErrors.filter((finding) => finding.rule === 'storyboard-layout').map(describe),
    budgetProblems: storyboardErrors.filter((finding) => finding.rule === 'budget-exceeded').map(describe),
    chromeProblems: errors.filter((finding) => finding.rule.startsWith('chrome-')).map(describe),
    chromeDeclared,
    designProfileOk,
    designProfileProblems,
  }
}

/** Package facts read straight out of the pptx. */
interface PackageParts {
  readonly slidesWithTextShapes: number
  readonly masterCount: number
  readonly chartParts: readonly string[]
  readonly hasTable: boolean
}

/** Read slide/master/chart parts from a pptx. */
async function readPackageParts(file: string): Promise<PackageParts | null> {
  try {
    const zip = await JSZip.loadAsync(readFileSync(file))
    const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    let slidesWithTextShapes = 0
    let hasTable = false
    for (const name of slideNames) {
      const xml = (await zip.file(name)?.async('string')) ?? ''
      if (/<p:sp[ >]/.test(xml)) slidesWithTextShapes += 1
      if (xml.includes('<a:tbl>') || xml.includes('<a:tbl ')) hasTable = true
    }
    const masterCount = Object.keys(zip.files).filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length
    const chartParts: string[] = []
    for (const name of Object.keys(zip.files).filter((entry) => /^ppt\/charts\/chart\d+\.xml$/.test(entry))) {
      const xml = (await zip.file(name)?.async('string')) ?? ''
      if (xml.includes('<c:chartSpace')) chartParts.push(name)
    }
    return { slidesWithTextShapes, masterCount, chartParts, hasTable }
  } catch {
    return null
  }
}

/** @returns whether `assets/image_sources.json` exists and meets the attribution rules. */
function readAttribution(file: string): { present: boolean; problems: string[] } {
  const raw = readJson(file)
  if (raw === null) return { present: false, problems: [] }
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return { present: true, problems: ['image_sources.json has no items list'] }
  const problems: string[] = []
  items.forEach((item, index) => {
    const entry = item as { filename?: unknown; license_name?: unknown; licenseName?: unknown; author?: unknown; attribution_required?: unknown; attribution_text?: unknown }
    const licence = typeof entry.license_name === 'string' ? entry.license_name : entry.licenseName
    if (typeof licence !== 'string' || licence.trim() === '') problems.push(`item ${String(index)} has no licence`)
    if (typeof entry.author !== 'string' || entry.author.trim() === '') problems.push(`item ${String(index)} has no author`)
    if (entry.attribution_required === true && (typeof entry.attribution_text !== 'string' || entry.attribution_text.trim() === '')) {
      problems.push(`item ${String(index)} requires attribution but records none`)
    }
  })
  return { present: true, problems }
}

/** @returns parsed JSON, or null when the file is absent or unreadable. */
function readJson(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * Write the aggregate eval report as JSON and Markdown.
 *
 * @param root - repository root.
 * @param runs - finished scenario runs.
 * @returns the two written paths.
 */
export function writeEvalReport(root: string, runs: readonly ScenarioRun[]): { json: string; markdown: string } {
  const previous = readPreviousReport(join(root, EVAL_DIR, 'report.json'))
  const byName = new Map(previous.map((entry) => [entry.name as string, entry]))
  for (const run of runs) byName.set(run.scenario.name, scenarioEntry(run))
  return persistReport(root, [...byName.values()])
}

/**
 * Recompute every recorded attempt's verdict from its stored checks and rewrite
 * both report files.
 *
 * This keeps the evidence machine-derived when the pass rule or a check severity
 * changes after a run; it never touches the workspaces or the session logs.
 *
 * @param root - repository root.
 * @returns the written paths plus the recomputed summary.
 */
export function rejudgeReport(root: string): { json: string; markdown: string; scenarios: number; passed: number } {
  const scenarios = readPreviousReport(join(root, EVAL_DIR, 'report.json')).map((entry) => {
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : []
    const normalized = attempts.map((attempt) => {
      const record = attempt as { attempt?: number; checks?: readonly RubricCheckResult[]; infrastructure?: unknown; metrics?: SessionMetrics }
      const checks = (record.checks ?? []).map((check) => ({ ...check, level: check.level ?? CHECK_SEVERITY[check.id as CheckId] ?? 'error' }))
      const stderrFile = join(root, EVAL_DIR, String(entry.name), `attempt-${String(record.attempt ?? 0)}`, 'agent.stderr.txt')
      const infrastructure =
        typeof record.infrastructure === 'string'
          ? record.infrastructure
          : detectInfrastructure(existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '', record.metrics ?? emptyMetrics(null))
      return { ...record, checks, infrastructure, passed: attemptPassed(checks) }
    })
    return { ...entry, attempts: normalized, passed: normalized.some((attempt) => attempt.passed) }
  })
  const written = persistReport(root, scenarios)
  return { ...written, scenarios: scenarios.length, passed: scenarios.filter((entry) => entry.passed === true).length }
}

/**
 * @param root - repository root.
 * @param scenarios - serializable scenario entries.
 * @returns the two written paths.
 */
function persistReport(root: string, scenarios: Record<string, unknown>[]): { json: string; markdown: string } {
  const dir = join(root, EVAL_DIR)
  mkdirSync(dir, { recursive: true })
  const jsonPath = join(dir, 'report.json')
  const markdownPath = join(dir, 'report.md')
  const summary = {
    scenarios: scenarios.length,
    passed: scenarios.filter((entry) => entry.passed === true).length,
    attempts: scenarios.reduce((sum, entry) => sum + (Array.isArray(entry.attempts) ? entry.attempts.length : 0), 0),
  }
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), checkIds: CHECK_IDS, summary, scenarios }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(markdownPath, renderReportMarkdown(scenarios, summary), 'utf8')
  return { json: jsonPath, markdown: markdownPath }
}

/** @returns the markdown rendering of the report. */
function renderReportMarkdown(scenarios: readonly Record<string, unknown>[], summary: { scenarios: number; passed: number; attempts: number }): string {
  const lines = [
    '# M6 model evaluation',
    '',
    `- scenarios: ${String(summary.scenarios)}, passed: ${String(summary.passed)}, attempts: ${String(summary.attempts)}`,
    '',
  ]
  for (const entry of scenarios) {
    const run = entry as {
      name: string
      title: string
      passed?: boolean
      attempts?: readonly { attempt: number; passed?: boolean; exitCode?: number | null; wallTimeMs?: number; metrics?: SessionMetrics; checks?: readonly RubricCheckResult[]; infrastructure?: string | null }[]
    }
    lines.push(`## ${run.name} — ${run.passed === true ? 'PASS' : 'FAIL'}`, '', `> ${run.title}`, '')
    for (const attempt of run.attempts ?? []) {
      const metrics = attempt.metrics
      lines.push(
        `- attempt ${String(attempt.attempt)}: ${attempt.passed === true ? 'pass' : 'fail'}, exit ${String(attempt.exitCode)}, wall ${String(Math.round((attempt.wallTimeMs ?? 0) / 1000))}s, ` +
          `turns ${String(metrics?.turns ?? 0)}, tools ${String(metrics?.toolCalls ?? 0)} (${String(metrics?.failedToolCalls ?? 0)} failed, ${String(metrics?.gateFailures ?? 0)} gate), ` +
          `skill loads ${String(metrics?.skillLoads ?? 0)}, checkpoints ${String(metrics?.checkpointCommands ?? 0)}` +
          `${attempt.infrastructure === undefined || attempt.infrastructure === null ? '' : `, infrastructure: ${attempt.infrastructure}`}`,
      )
      for (const check of (attempt.checks ?? []).filter((entry) => !entry.passed)) {
        lines.push(`  - ${check.level === 'warning' ? 'WARN' : 'FAIL'} ${check.id}: ${check.message}`)
      }
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** @returns one serializable scenario entry for the report. */
function scenarioEntry(run: ScenarioRun) {
  return {
    name: run.scenario.name,
    title: run.scenario.title,
    passed: run.passed,
    attempts: run.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      passed: attempt.passed,
      exitCode: attempt.exitCode,
      wallTimeMs: attempt.wallTimeMs,
      metrics: attempt.metrics,
      observation: attempt.observation,
      checks: attempt.checks,
      infrastructure: attempt.infrastructure,
      workspace: relative(process.cwd(), attempt.workspace).replace(/\\/g, '/'),
      sessionFile: attempt.sessionFile === null ? null : relative(process.cwd(), attempt.sessionFile).replace(/\\/g, '/'),
    })),
  }
}

/** @returns the scenarios already recorded in `report.json`, or none. */
function readPreviousReport(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { scenarios?: unknown }
    return Array.isArray(parsed.scenarios) ? (parsed.scenarios as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}
