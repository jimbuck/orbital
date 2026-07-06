---
title: Installation
description: Install Orbital on Windows, or build it from source.
---

## Requirements

- **Windows 10/11.** Orbital is currently Windows-only (ConPTY terminals, taskbar
  badges, and the installer are all Windows-native).
- **git** on your `PATH`.
- Your coding agent's CLI (e.g. `claude`) installed and authenticated as usual.

## Install the app

1. Download the latest installer from the
   [GitHub releases page](https://github.com/jimbuck/orbital/releases/latest).
2. Run it. Orbital installs per-user; no admin rights needed.

### Auto-update

Packaged builds check GitHub releases in the background. When an update has
downloaded, a quiet **"Restart to update"** pill appears in the title bar —
click it whenever convenient. You can also check manually via
**Help → Check for Updates…**.

## Build from source

```sh
git clone https://github.com/jimbuck/orbital
cd orbital
npm install        # postinstall applies a small node-pty patch
npm run rebuild    # compile node-pty + better-sqlite3 against Electron's ABI
npm start          # build the CLI and launch in dev mode
```

`node-pty` and `better-sqlite3` are native modules, so you'll need the standard
node-gyp prerequisites: **MSVC C++ build tools** and Python. `npm run make`
produces a Windows installer.
