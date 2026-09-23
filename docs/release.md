# Release checklist (current: v0.2.0)

Everything below runs from the repository root. The local gates are already green
(`typecheck`, `lint`, `test`, `fixtures:verify`, `matrix:verify`, `compat:matrix`,
`prepack`); this page is the credentialed half. `v0.2.0` is a minor release (storyboard,
role→layout, budgets, narration auto-advance) and follows the same steps as `v0.1.0` with the
version, tag and asset names replaced throughout.

## 0. Identity

- npm package: `dsh-ppt-flashmade` — unscoped, because the account does not own the
  `@dsh-ppt` scope (ADR-056); "FlashMade" is the product name in prose
- repository: `https://github.com/Bingtang1019/` (repository name: the project uses
  `dsh-ppt-fusion`; change the remote if the repo is named differently)
- plugin/skill/CLI ids stay `dsh-ppt-fusion` / `dsh-ppt-fusion` / `dsh-ppt`

## 1. Publish to npm

```sh
# one-time auth (user-level ~/.npmrc; NEVER put the token in the tracked .npmrc)
npm login --registry https://registry.npmjs.org/

# the tracked .npmrc points at npmmirror, so every publish/ownership command overrides it
npm whoami --registry https://registry.npmjs.org/

# package.json must not be private
grep -n '"private"' package.json      # remove the line (or set it to false)

pnpm build && node scripts/check-pack.mjs
npm publish --registry https://registry.npmjs.org/
```

The name is unscoped, so there is no scope-ownership check and no `--access public`.
Verify the release from the registry, then hand-install it (section 3 uses the tarball;
this is the published-artifact check):

```sh
npm view dsh-ppt-flashmade version dist.tarball --registry https://registry.npmjs.org/
```

## 2. Push the repository

```sh
git remote -v                            # origin = https://github.com/Bingtang1019/<repo>.git
git push -u origin main
git push origin v<version>               # annotated tag on the release commit
```

The `github:` install path is verified (the package's `prepare` script builds `dist/`), and
the release tag must point at the release commit: `git tag -fa v<version> -m ... <commit>` then
`git push origin v<version> --force` after any post-tag release edit.

The repository must exist first (create it on GitHub; private or public). No credentials are
stored in this repository: use `gh auth login`, a Git credential manager, or an SSH remote.

## 2b. GitHub Release (the second channel, plan §8)

The release carries the same tarball the registry serves, so a GitHub-only consumer downloads a
byte-identical copy. Fetch the published tarball (verify `shasum` against `npm view`), create the
release on the existing tag, and upload the asset:

```sh
curl -sSL -o dsh-ppt-flashmade-<version>.tgz \
  https://registry.npmjs.org/dsh-ppt-flashmade/-/dsh-ppt-flashmade-<version>.tgz
sha1sum dsh-ppt-flashmade-<version>.tgz     # must equal `npm view ... dist.shasum`
# create the release via the API (tag_name: v<version>, body: that version's CHANGELOG section)
curl -sS --ssl-no-revoke -X POST \
  -H "Authorization: token <token>" -H "Content-Type: application/gzip" \
  --data-binary @dsh-ppt-flashmade-<version>.tgz \
  "https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=dsh-ppt-flashmade-<version>.tgz"
```

`--ssl-no-revoke` is required on this machine: Windows schannel cannot reach the certificate
revocation service for `uploads.github.com` (`0x80092013`). Verify the release by downloading the
asset back and comparing SHA-1 with the npm shasum; `GET /releases/tags/v<version>` must list the
asset and point `target_commitish` at the tagged commit. When a later patch supersedes a release
whose feature is broken, prepend a known-issue line to the older release's body (as `v0.1.0` now
does) instead of rewriting its notes.

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
dsh plugin --profile web remove -w dsh-ppt-flashmade
```

## 4. Post-release

- Update `docs/install.md`/README with the published version and the real install command.
- Record the release in `~/.dsh/CHANGELOG-dsh.md` and in `docs/decisions.md` if the process
  changed.
- If a later WPS/CI run fails, revert the T1 claim per ADR-051.