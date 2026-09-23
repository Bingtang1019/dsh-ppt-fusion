# Installing the dsh-ppt-fusion plugin

The package is one DSH plugin bundle: `dsh/index.js` registers the
`dsh-ppt-fusion` skill and the `dsh_ppt_preview` tool, `dsh/client.js` draws the
preview card, and `cordis.patch.yml` is the bundle layer DSH composes.

## Prerequisites

- Node `>=22.19` and a DSH runtime (`0.1.2-rc.1` or newer) that supports
  `dsh.bundle` packages.
- The engine bootstrap is local: the first run needs
  `dsh-ppt doctor --repair` (uv + pinned Python + `python-assets/requirements.lock`).
  The plugin's own commands do not install anything globally.

## Install

From npm (v0.2.0):

```sh
dsh plugin --profile <profile> add -w dsh-ppt-flashmade@0.2.0
```

From the GitHub Release (the attached tarball is byte-identical to the npm package, shasum
`a92eda11e73e3531333455f8296d3d435eaa957a`): download `dsh-ppt-flashmade-0.2.0.tgz` from
`https://github.com/Bingtang1019/dsh-ppt-fusion/releases/tag/v0.2.0`, then

```sh
dsh plugin --profile <profile> add -w <downloads>/dsh-ppt-flashmade-0.2.0.tgz
```

From a checkout, build first so the linked package has `dist/cli.js`:

```sh
cd /path/to/dsh-ppt-fusion
pnpm install
pnpm build
dsh plugin --profile <profile> add -w ./
```

From a published repository:

```sh
dsh plugin --profile <profile> add -w github:<owner>/dsh-ppt-fusion
```

`-w` is required because a profile directory is a pnpm workspace root. DSH adds
the package to the profile's `dependencies` **and** to `dsh.profile.bundles`, so
the plugin loads on the next start.

The `github:` form was verified on 2026-09-23 against
`github:Bingtang1019/dsh-ppt-fusion` in the scratch profile: npm/pnpm runs the package's
`prepare` script (`pnpm build`), so the installed copy carries `dist/cli.js`, and
`--dump-config` composes the `dsh-ppt-flashmade` layer.

## What the plugin adds

| Surface | Name |
|---|---|
| Skill | `dsh-ppt-fusion` (the seven-phase workflow; the preamble maps `dsh-ppt <args>` to `node <package>/dist/cli.js <args>` and points the vendored reference paths at the package root) |
| Tool | `dsh_ppt_preview` — renders a fusion deck (standard pages through pptwise, deep pages from their authored SVGs) and shows it as a card |
| Route | `/dsh-ppt/preview/<id>` (web profile only; answers with `x-dsh-ppt-preview: 1`) |
| Client | the preview card in `dsh/client.js` |

## First run

```sh
node <package>/dist/cli.js doctor --repair
```

That builds the engine venv under `~/.dsh/ppt-fusion/venvs/` from the ship-locked
requirements. Inside a DSH session this is simply the mapped `dsh-ppt` command.

## Verify an install

```sh
dsh --profile <profile> --dump-config | grep -A1 'dsh-ppt-fusion'
```

The composed tree shows the `# == dsh-ppt-flashmade` layer. With the web
app running, the skill appears in the skill catalog and the preview card shows
filmstrip pages; the route answers for any unknown id with
`{"code":"preview_unknown"}` and the `x-dsh-ppt-preview: 1` header.

## Uninstall

```sh
dsh plugin --profile <profile> remove -w dsh-ppt-flashmade
```

DSH removes both the dependency and the bundle entry. The skill, tool and route
are registrations on the plugin's context, so they disappear with the plugin;
`node_modules` keeps no `@dsh-ppt` directory, and the linked checkout is
untouched.

## The M7.5 scratch-profile rehearsal

The install/uninstall path was rehearsed on this machine in an isolated profile
(`~/.dsh/profiles/ppt-eval`, base + web-app bundles only):

```sh
node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile ppt-eval add -w link:C:/Users/dell/Desktop/dsh-ppt-fusion
node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile ppt-eval --dump-config   # layer present
node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile ppt-eval --no-open --port 3098
# GET http://127.0.0.1:3098/dsh-ppt/preview/does-not-exist -> 404, x-dsh-ppt-preview: 1, preview_unknown
node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile ppt-eval remove -w dsh-ppt-flashmade
```

The browser card was verified by the user on 2026-09-22 in the scratch profile:
no red banner, the skill appears in the catalogue, and the preview card renders. Delete `~/.dsh/profiles/ppt-eval` to roll the rehearsal back; the `web`
profile was never touched.
