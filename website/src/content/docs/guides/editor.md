---
title: The editor
description: File tree, syntax-highlighted source and diffs, previews, images, and quick edits.
---

An **editor tab** shows the active worktree's files: a tree on the left, the
selected file on the right with a mode toggle in the header.

## The file tree

- Tracked and untracked files, directories first.
- Gitignored files and directories appear dimmed. A fully-ignored directory
  (`node_modules`, `dist`, …) loads its contents on first expand, so huge
  ignored trees cost nothing until you open them.
- Changed files carry their git badge (`M`, `A`, `D`, `?`, …); collapsed
  directories containing changes get an amber dot.
- The tree follows the repo live — agent edits and commits re-badge it
  automatically.

## File mode

Source renders with **syntax highlighting** (Shiki, the same engine as VS Code
grammars) across TypeScript, Python, Rust, Go, CSS, YAML, Dockerfile, and dozens
more. Very large files fall back to plain text to stay snappy.

Files are editable in place — just type. **Save** and **Cancel** light up in the
header once the buffer differs from disk; a save writes straight to the
worktree's working tree, and unsaved edits survive a peek at Diff or Preview.
It's for config tweaks and small fixes, not a replacement for your IDE.

### Images

Image files (`png`, `jpg`, `gif`, `webp`, `avif`, `bmp`, `ico`) render directly —
centered on a checkerboard so transparency reads, with the natural dimensions
below:

![An SVG logo rendered in the editor's preview mode](../../../assets/screenshots/08-editor-image.png)

## Diff mode

Files with changes get a **Diff** toggle: unified diff with old/new line
numbers, green/red row tinting, and full syntax highlighting on the code. Files
opened from the git panel land here directly.

![A highlighted diff of ProductCard.tsx in nebula-shop](../../../assets/screenshots/07-diff-view.png)

## Preview mode

- **Markdown** renders with theme-matched styles.
- **HTML** renders in a sandboxed frame (no scripts, no app access — repo
  content can never reach Orbital's internals).
- **SVG** renders as an image, with the source still available in File mode.
