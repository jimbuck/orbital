import { shell, webContents } from 'electron'
import { IPC } from '@shared/types'
import { runtime, repo } from '../runtime'
import { git } from '../services/git'
import { logger } from '../services/logger'
import { spawnExternalTerminal } from '../services/external-terminal'
import { createTabInWorktree } from '../tabs'
import { handle } from './handle'
import { projectRepoPath, worktreeRepoPath } from './resolve'

/** Hand-offs to the OS and the embedded browser: external links, webview popups, Explorer, external terminals. */
export function register(): void {
  const h = handle
  // ---- browser / window ----
  h(IPC.openExternal, (_e, url: string) => shell.openExternal(url))
  // A <webview>'s popups (Ctrl/Cmd-click, target=_blank, window.open) can only be
  // intercepted on the guest's webContents in main. Route them to a NEW internal
  // browser tab in the same worktree/pane and deny the real popup window.
  h(IPC.registerBrowserView, (_e, webContentsId: number, worktreeId: string, paneId: string) => {
    const wc = webContents.fromId(webContentsId)
    if (!wc) return
    wc.setWindowOpenHandler((details) => {
      const url = details.url
      if (/^https?:\/\//i.test(url) && repo.worktrees.get(worktreeId)) {
        createTabInWorktree(worktreeId, paneId, 'browser', { url })
        runtime.broadcastState()
      }
      return { action: 'deny' }
    })
  })
  /* ---- OS hand-offs ------------------------------------------------------
   *
   * These three used to take an absolute path straight from the renderer, so
   * `shell.openPath('C:\\evil.exe')` was one compromised-renderer message
   * away — the strongest of the three, since openPath LAUNCHES whatever it is
   * given with its registered application. They now take the same
   * `(worktreeId, path)` pair as every other file operation and do the
   * resolution here, so the absolute path handed to Electron is one main
   * derived itself from a checkout it knows about.
   *
   * The gate is the LEXICAL `resolveInRepo`, on all three, and that is a
   * decision rather than an oversight — so it is worth writing down what it
   * does not catch. A symlink or junction committed inside the checkout is a
   * directory entry like any other; the OS follows it, so `link/app.exe` (or
   * `link` itself) can resolve anywhere on the machine and still be handed to
   * `shell.openPath`. `resolveInRepoReal` was weighed for this and turned down:
   *
   *  - It would only half-close it. That gate resolves the ANCESTORS and leaves
   *    the final segment alone on purpose (so a link entry can be renamed and
   *    binned like the ordinary directory entry it is), which means the natural
   *    shape here — one committed symlink aimed at an executable, named
   *    directly — sails straight through it. Only a target NESTED under a
   *    linked directory would be refused. A leaf-resolving variant would close
   *    that, at the cost below, and it exists nowhere else in the codebase.
   *  - The cost is a false rejection of exactly what the user clicked. These
   *    three act on an entry the tree is showing, and some of those entries are
   *    links out of the checkout by design: a junction-backed folder someone
   *    dropped in the working copy, a package pulled in by `npm link` /
   *    `pnpm link --global`, a yarn `link:`/`portal:` dependency, or a monorepo
   *    workspace rooted ABOVE the checkout. (Not, note, an ordinary install:
   *    pnpm's default hoisted layout leaves no symlinks under `node_modules` at
   *    all, and even `node-linker=isolated` points its links back INTO the
   *    checkout, at `node_modules/.pnpm/…`. Its link to the global store is a
   *    HARDLINK, which `realpath` does not follow — so real-path containment
   *    would not have rejected a plain `pnpm install` tree. The escaping cases
   *    are real but narrower than "every node_modules".) Refusing to reveal a
   *    file the tree just drew is still a bug the user meets; the escape is one
   *    they have to be attacked with.
   *  - And it would not buy the guarantee it looks like it buys. Containment
   *    here is least-authority scoping — main never takes an absolute path from
   *    the renderer on faith — not an exploit barrier, because there isn't one
   *    to be had at this layer: a payload committed IN the checkout satisfies
   *    every containment gate there is, so real-path resolution changes which
   *    file can be launched, not whether one can be. And a renderer compromised
   *    enough to call these unattended already has `IPC.createTab` +
   *    `IPC.terminalInput`, i.e. arbitrary commands in a PTY, by design —
   *    Orbital is a terminal multiplexer. Nothing decided here narrows that.
   *
   * What the gate does earn is real: the renderer can only name entries in a
   * checkout main already knows about, `..` and absolute paths are refused with
   * a message, and every caller is an explicit click on a visible entry.
   *
   * An empty `path` means the checkout root, which is what a Worktree row's
   * "Open in Explorer" / "Open in External Terminal" want. A PROJECT header's
   * two equivalents do not come through here at all — see the project-scoped
   * pair below, which need no Worktree to exist.
   */
  const worktreePath = (worktreeId: string, path: string): string =>
    git.resolveInRepo(worktreeRepoPath(worktreeId), path)

  h(IPC.openPath, async (_e, worktreeId: string, path: string) => {
    // `shell.openPath` reports failure by RESOLVING with a message rather than
    // rejecting, so without this an unopenable file is a silent no-op — the
    // context menu closes and nothing happens. Rethrowing puts the OS's own
    // words in front of the user from the file context menu; the rail's
    // callers have no error line and route through `fireAndForget`, so there
    // the rejection lands in the app log (the handler wrapper logs it) instead.
    const err = await shell.openPath(worktreePath(worktreeId, path))
    if (err) throw new Error(err)
  })
  // showItemInFolder, not openPath: this opens the CONTAINING folder with the
  // item selected, which is what "Reveal in File Explorer" means for a file
  // (openPath on a file would launch its default application instead).
  h(IPC.revealPath, (_e, worktreeId: string, path: string) => {
    shell.showItemInFolder(worktreePath(worktreeId, path))
  })
  h(IPC.openLogFolder, async () => {
    // Reveal the rotating debug-log folder in Explorer so users can grab the file.
    // No containment check: the path is `logger.dir`, main's own, not the
    // renderer's — there is nothing here for a caller to influence.
    await shell.openPath(logger.dir)
  })
  h(IPC.openInTerminal, (_e, worktreeId: string, path: string) => {
    spawnExternalTerminal(worktreePath(worktreeId, path))
  })

  /* ---- Project-scoped hand-offs -------------------------------------------
   *
   * The rail's project header offers "Open in Explorer" and "Open in External
   * Terminal" too, and those cannot route through the pair above. Both of those
   * need a Worktree id, and a project does not always have one: the root row is
   * created by `reconcileProjectWorktrees`, which returns without touching the
   * stored rows when `git worktree list` fails — a directory that was never a
   * repo, or is no longer readable. That is a PERMANENT state, not a gap before
   * the first scan, and it is precisely the state in which a user reaches for
   * "open the folder and let me look at why".
   *
   * So these two take a project id and NOTHING else. The directory comes from
   * `project.repoPath`, which main stored when the user picked the folder — the
   * same provenance as `worktreeRepoPath`'s `w.path`, and equally not something
   * the renderer can influence. With no renderer-supplied path in the call
   * there is nothing to contain, which is why `resolveInRepo` is absent here
   * rather than skipped: it would be gating a string main wrote itself. The
   * alternative — letting the renderer pass the absolute path it can see in the
   * rail — is the exact shape this PR removed, and is not coming back.
   */
  h(IPC.openProjectPath, async (_e, projectId: string) => {
    // Same resolve-with-a-message quirk as `IPC.openPath` above; rethrowing is
    // what puts "the folder is gone" in front of a user whose repo moved.
    const err = await shell.openPath(projectRepoPath(projectId))
    if (err) throw new Error(err)
  })
  h(IPC.openProjectInTerminal, (_e, projectId: string) => {
    spawnExternalTerminal(projectRepoPath(projectId))
  })
}
