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

// Offscreen rendering delivers software-bitmap paint frames only without GPU
// compositing; with it on, `paint` images come back empty.
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'resources', 'icons')
const SIZE = 256
const JOBS = [
  { src: join(ROOT, 'build', 'icon.svg'), out: join(OUT_DIR, 'icon.png') },
  { src: join(ROOT, 'build', 'icon-alert.svg'), out: join(OUT_DIR, 'icon-alert.png') }
]

/** Fraction of pixels in the BGRA bitmap with non-zero alpha. */
function inkFraction(image) {
  const bmp = image.toBitmap()
  let ink = 0
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] !== 0) ink++
  return ink / (bmp.length / 4)
}

async function render({ src, out }) {
  const svg = readFileSync(src, 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
  // Chromium is picky about long/utf-8 data: URLs, so stage a real file.
  const page = join(tmpdir(), `orbital-render-icon-${process.pid}-${out.length}.html`)
  writeFileSync(page, html, 'utf8')
  // One window per document: a reused window can hand `paint` a stale frame of
  // the previous document. Windows stay open until the app quits — destroying
  // one before creating the next makes that next navigation fail (ERR_FAILED).
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  try {
    await win.loadFile(page)
    // Capture by verification, not by sleeping: the compositor emits blank or
    // near-blank warm-up frames for a while after load (so a fixed delay — or
    // even the `paint` event — is unreliable), but the finished icon's tile
    // covers most of the canvas. Poll until a frame is mostly inked.
    const deadline = Date.now() + 10_000
    let img
    for (;;) {
      img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
      if (!img.isEmpty() && inkFraction(img) > 0.5) break
      if (Date.now() > deadline) throw new Error(`page never painted for ${src}`)
      await new Promise((r) => setTimeout(r, 100))
    }
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
    for (const job of JOBS) await render(job)
    app.quit()
  })
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
