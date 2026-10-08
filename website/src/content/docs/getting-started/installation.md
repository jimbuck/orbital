---
title: Installation
description: Install Orbital on Windows, macOS or Linux, or build it from source.
---

## Requirements

- **Windows 10/11, macOS on Apple Silicon, or 64-bit Linux.**
- **git** on your `PATH`.
- Your coding agent's CLI installed and signed in as usual. Orbital launches
  **Claude Code**, **Codex** and **Cursor** as agent tabs, and any interactive
  CLI runs fine in a plain worktree terminal.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in, to clone
  or create GitHub repositories from the Add Project dialog.

## Install the app

Download the build for your OS from the
[GitHub releases page](https://github.com/jimbuck/orbital/releases/latest).

- **Windows:** run `Orbital-<version>-setup.exe`. It installs per-user, so you
  don't need admin rights.
- **macOS:** open `Orbital-<version>-arm64.dmg` and drag Orbital into
  Applications. The build isn't signed yet, so macOS will refuse to open it the
  first time. Clear the quarantine flag once and it opens normally after that:
  `xattr -cr /Applications/Orbital.app`.
- **Linux:** use `Orbital-<version>-x64.AppImage` (`chmod +x` it, then run
  it) or install `Orbital-<version>-x64.deb` with `sudo apt install ./Orbital-<version>-x64.deb`.

### Auto-update

Packaged builds check GitHub releases in the background. When an update has
downloaded, a quiet **"Update"** pill appears in the title bar. Click it
whenever convenient: Orbital closes and relaunches on the new version. If other
workspaces are open in their own windows, it lists them and asks before closing
them too. You can also check manually via
**Help → Check for Updates…**.

Windows and the Linux AppImage update this way. The `.deb` updates through the
same pill but asks for your password to install. On macOS, auto-update only works
for signed builds, so until releases are signed, download each new version
yourself.

## Build from source

```sh
git clone https://github.com/jimbuck/orbital
cd orbital
npm install        # postinstall applies a small node-pty patch
npm run rebuild    # compile node-pty + better-sqlite3 against Electron's ABI
npm start          # build the CLI and launch in dev mode
```

`node-pty` and `better-sqlite3` are native modules, so you'll need the standard
node-gyp prerequisites: Python plus a C++ toolchain (the **MSVC build tools** on
Windows, the Xcode Command Line Tools on macOS, `build-essential` on Linux).
`npm run make` packages an installer for the OS you run it on.
