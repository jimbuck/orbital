/**
 * Clipboard-image paste support for terminals.
 *
 * xterm.js can only paste text, and agent CLIs (Claude Code) attach an image
 * when a file path to one is pasted into the prompt — so when the clipboard
 * holds an image instead of text, we save it as a PNG under Orbital's own
 * app-data dir (zero git footprint) and paste its path. Files are swept by
 * age at startup so screenshots never accumulate.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, clipboard } from 'electron'

function imageDir(): string {
  return join(app.getPath('userData'), 'pasted-images')
}

/** Save the clipboard image as a PNG; returns its absolute path, or null when the clipboard holds no image. */
export function savePastedImage(): string | null {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const dir = imageDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `paste-${randomUUID().slice(0, 8)}.png`)
  writeFileSync(file, image.toPNG())
  return file
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Startup sweep: drop pasted images old enough that no live prompt still references them. */
export function prunePastedImages(): void {
  let files: string[]
  try {
    files = readdirSync(imageDir())
  } catch {
    return // dir not created yet — nothing to prune
  }
  const cutoff = Date.now() - MAX_AGE_MS
  for (const f of files) {
    const path = join(imageDir(), f)
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    } catch {
      /* ignore */
    }
  }
}
