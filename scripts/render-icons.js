/**
 * Rasterize the icon SVGs into the runtime PNGs under resources/icons/, which
 * AlertManager swaps onto the window at runtime (satellite-as-badge). Re-run
 * after editing build/icon.svg or build/icon-alert.svg:
 *
 *   npx electron scripts/render-icons.js
 *
 * Uses Electron's own Chromium (offscreen, transparent) so no extra deps.
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'resources', 'icons')
const SIZE = 256
const JOBS = [
  { src: join(ROOT, 'build', 'icon.svg'), out: join(OUT_DIR, 'icon.png') },
  { src: join(ROOT, 'build', 'icon-alert.svg'), out: join(OUT_DIR, 'icon-alert.png') }
]

async function render(win, { src, out }) {
  const svg = readFileSync(src, 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
  // Chromium is picky about long/utf-8 data: URLs, so stage a real file.
  const page = join(tmpdir(), `orbital-render-icon-${process.pid}-${out.length}.html`)
  writeFileSync(page, html, 'utf8')
  try {
    await win.loadFile(page)
    // One breath for the offscreen compositor to paint the loaded document.
    await new Promise((r) => setTimeout(r, 400))
    let img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
    if (img.getSize().width !== SIZE) img = img.resize({ width: SIZE, height: SIZE }) // display scale factor
    writeFileSync(out, img.toPNG())
    console.log(`wrote ${out} (${img.getSize().width}x${img.getSize().height})`)
  } finally {
    rmSync(page, { force: true })
  }
}

app
  .whenReady()
  .then(async () => {
    mkdirSync(OUT_DIR, { recursive: true })
    // One window reused for every job: tearing an offscreen window down and
    // spinning up a second one makes the next navigation fail with ERR_FAILED.
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true }
    })
    for (const job of JOBS) await render(win, job)
    win.destroy()
    app.quit()
  })
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
