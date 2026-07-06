# Releasing Orbital

Releases are **fully automatic** and driven by
[Conventional Commits](https://www.conventionalcommits.org) — the same model as
casewright. You never choose a version number, push a tag, or merge a release
PR; you write good commit messages and push to `main`.

## How it works

Every push to `main` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. **[semantic-release](https://semantic-release.gitbook.io)** reads every commit
   since the last `v*` tag and decides whether a release is due and what the
   version is:

   | Commit type                                | Bump              | `1.2.1` → |
   | ------------------------------------------ | ----------------- | --------- |
   | `fix:` / `perf:` / `refactor:`             | patch             | `1.2.2`   |
   | `feat:`                                    | minor             | `1.3.0`   |
   | `feat!:` / any `BREAKING CHANGE:`          | major             | `2.0.0`   |
   | `chore:` `docs:` `style:` `test:` `ci:`    | none — no release | —         |

   When a release is due it updates [`CHANGELOG.md`](../CHANGELOG.md) and the
   `package.json`/`package-lock.json` versions, commits that as
   `chore(release): vX.Y.Z [skip ci]`, and pushes the `vX.Y.Z` tag. It does
   **not** create the GitHub Release yet.

2. If a version was cut,
   [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml)
   builds the Windows installer and **publishes the GitHub Release with the
   assets attached** — `Orbital-X.Y.Z-setup.exe`, its `.blockmap`, and
   `latest.yml`.

The two-step ordering is deliberate: the Release only becomes visible once the
installer is present, so **electron-updater inside installed apps never sees a
release it can't download**. The version flows from the tag's `package.json`
(bumped by semantic-release before tagging), which is exactly what
electron-builder stamps into the installer and `latest.yml`.

## What you do

Nothing release-specific. Write conventional commits (enforced locally by the
husky + commitlint `commit-msg` hook, config in `commitlint.config.mjs`):

```text
feat(git): add per-file stage from the diff view
fix(terminal): stop dropping bracketed-paste on Windows
feat!: require git 2.40+

BREAKING CHANGE: worktree pruning now uses `git worktree remove --force`.
```

Push to `main`. If anything releasable landed, a new version ships a few
minutes later; if not, nothing happens.

## Manual / fallback release

To rebuild and republish a specific version by hand — e.g. the build failed
*after* the tag was already created, so re-running won't help — run **Build
desktop release** from the **Actions** tab and supply the version (e.g.
`1.3.0`). It checks out that version's tag, rebuilds, and updates the existing
Release's assets.

## One-time setup caveat — protected `main`

semantic-release pushes the release commit and tag using the built-in
`GITHUB_TOKEN`. If `main` ever becomes a **protected branch**, allow the GitHub
Actions bot to bypass the rule (Settings → Rules → Rulesets → bypass list), or
supply a PAT with push rights as the workflow's token. While `main` is
unprotected (the default), no setup is needed.

## Notes

- The release commit carries `[skip ci]` and is authored by `GITHUB_TOKEN`, so
  it never re-triggers the release workflow (no loops).
- `CHANGELOG.md` is generated — don't hand-edit it.
- semantic-release and its plugins aren't project dependencies; the workflow
  installs them ephemerally, keeping the lockfile lean.
- Auto-update inside the app polls the `latest.yml` of the newest published
  release (provider configured in
  [`electron-builder.yml`](../electron-builder.yml)); see
  `src/main/services/updater.ts` for the in-app side.
