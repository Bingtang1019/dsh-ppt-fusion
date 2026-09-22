# Release checklist (v0.1.0)

Everything below runs from the repository root. The local gates are already green
(`typecheck`, `lint`, `test` 314, `fixtures:verify`, `matrix:verify`, `compat:matrix`,
`prepack`); this page is the credentialed half.

## 0. Identity

- npm package: `@dsh-ppt/dsh-ppt-flashmade` (npm rejects uppercase; "FlashMade" is the product
  name in prose)
- repository: `https://github.com/Bingtang1019/` (repository name: the project uses
  `dsh-ppt-fusion`; change the remote if the repo is named differently)
- plugin/skill/CLI ids stay `dsh-ppt-fusion` / `dsh-ppt-fusion` / `dsh-ppt`

## 1. Publish to npm

```sh
# one-time auth (user-level ~/.npmrc; NEVER put the token in the tracked .npmrc)
npm login --registry https://registry.npmjs.org/

# the tracked .npmrc points at npmmirror, so every publish/ownership command overrides it
npm whoami --registry https://registry.npmjs.org/
npm org ls @dsh-ppt --registry https://registry.npmjs.org/   # must list your account

# package.json must not be private
grep -n '"private"' package.json      # remove the line (or set it to false)

pnpm build && node scripts/check-pack.mjs
npm publish --registry https://registry.npmjs.org/ --access public
```

If the `@dsh-ppt` scope is not owned by the account, either create the org or publish unscoped:

```sh
# package.json name -> "dsh-ppt-flashmade" (no scope), then
npm publish --registry https://registry.npmjs.org/
```

## 2. Push the repository

```sh
git remote -v                            # origin = https://github.com/Bingtang1019/<repo>.git
git push -u origin main
git push origin v0.1.0                   # annotated tag created in M9 prep
```

The repository must exist first (create it on GitHub; private or public). No credentials are
stored in this repository: use `gh auth login`, a Git credential manager, or an SSH remote.

## 3. Install into the real `web` profile (ops discipline)

Back up first, then one change:

```sh
# backup three files (see ~/.dsh/skills/dsh-ops-discipline)
copy %USERPROFILE%\.dsh\cordis.patch.yml             <backup>\
copy %USERPROFILE%\.dsh\profiles\web\package.json    <backup>\
copy C:\Users\<user>\Desktop\Dsh-Web-UI.bat          <backup>\

dsh plugin --profile web add -w <repo-or-tarball>
dsh --profile web --dump-config | findstr /C:"dsh-ppt-flashmade"
```

Then restart the web app from the launcher (this ends any running session), and verify:

1. `%TEMP%\dsh-web.log` contains no `Error`;
2. the browser shows no "Failed to load plugins" banner;
3. the skill catalogue lists `dsh-ppt-fusion`;
4. calling `dsh_ppt_preview` shows the preview card;
5. append the change + rollback line to `~/.dsh/CHANGELOG-dsh.md`.

Rollback:

```sh
dsh plugin --profile web remove -w @dsh-ppt/dsh-ppt-flashmade
```

## 4. Post-release

- Update `docs/install.md`/README with the published version and the real install command.
- Record the release in `~/.dsh/CHANGELOG-dsh.md` and in `docs/decisions.md` if the process
  changed.
- If a later WPS/CI run fails, revert the T1 claim per ADR-051.