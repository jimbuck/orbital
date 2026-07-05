# Releasing Orbital

Releases are fully automated from conventional commits — no manual version
bumps, tags, or installer uploads.

## Commit messages (conventional commits)

Every commit on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add split-pane drag handles          -> minor bump (1.1.0 -> 1.2.0)
fix: keep PTY alive across renderer reload -> patch bump (1.1.0 -> 1.1.1)
feat!: rework the control-channel protocol -> major bump (1.1.0 -> 2.0.0)
chore/docs/refactor/perf/test/ci: ...      -> no release on their own
```

A `commit-msg` hook (husky + commitlint, config in `commitlint.config.mjs`)
rejects non-conforming messages locally. Hooks install automatically via the
`prepare` script on `npm install`.

## Release flow

1. Push (or merge) conventional commits to `main`.
2. The `Release` workflow (`.github/workflows/release.yml`) runs
   **release-please**, which opens/updates a *release PR* that accumulates
   pending changes into a `package.json` bump + `CHANGELOG.md` entry.
3. Merge the release PR when you want to ship. release-please tags `vX.Y.Z`
   and publishes a GitHub release with the changelog as notes.
4. The same workflow then builds the Windows installer on a `windows-latest`
   runner and uploads to that release:
   - `Orbital-X.Y.Z-setup.exe` — the NSIS installer
   - `Orbital-X.Y.Z-setup.exe.blockmap` — enables differential downloads
   - `latest.yml` — the update feed electron-updater polls

Version state lives in `.release-please-manifest.json` (current released
version) and `release-please-config.json` (changelog sections etc.).

## Auto-updates in the app

Packaged builds check GitHub releases on startup and every 4 hours
(`src/main/services/updater.ts`), download updates in the background, and show
a **Restart to update** pill in the title bar when one is ready. Installing is
silent and relaunches the app; a downloaded update is also applied on normal
quit. Help ▸ "Check for Updates…" triggers a manual check (status shows in the
About dialog). Dev runs (`npm start`) report auto-update as disabled.

The update feed location is the `publish` block in `electron-builder.yml`
(baked into the build as `resources/app-update.yml`).

> **Note:** the repo is currently **private**. In-app update checks hit the
> release assets anonymously, which GitHub only allows on public repos — so
> auto-update will start working once the repo is made public. (CI publishing
> works either way; the workflow uses the built-in `GITHUB_TOKEN`.)
