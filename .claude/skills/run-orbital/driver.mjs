// REPL/scripted driver for the Orbital Electron app (Windows).
//
// Launches the BUILT app (out/ — run `npm run build` first) via playwright-core
// and exposes line-oriented commands, so an agent can drive the real UI:
//
//   node .claude/skills/run-orbital/driver.mjs              # interactive REPL
//   node .claude/skills/run-orbital/driver.mjs < cmds.txt   # scripted
//   node .claude/skills/run-orbital/driver.mjs <<'EOF'      # heredoc (bash)
//   launch
//   ss boot
//   quit
//   EOF
//
// Screenshots land in %TEMP%\orbital-shots (override with SCREENSHOT_DIR).
import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '../../..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'orbital-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

let app = null
let page = null
let shotNo = 0

function need() {
  if (!page) {
    console.log('ERROR: launch first')
    return false
  }
  return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    app = await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [APP_DIR],
      cwd: APP_DIR,
      timeout: 30_000
    })
    // node-pty's conpty agent prints "AttachConsole failed" to stderr when the
    // app runs without an attached console — harmless, PTYs still work. Keep
    // stderr drained but quiet.
    app.process().stderr?.on('data', () => {})
    page = await app.firstWindow()
    // Both rails are <aside>; the git panel lives in the right one (border-l).
    await page.waitForSelector('aside.border-l', { timeout: 20_000 })
    console.log('launched:', page.url())
  },

  async ss(name) {
    if (!need()) return
    const f = path.join(SHOT_DIR, `${String(++shotNo).padStart(2, '0')}-${name || 'shot'}.png`)
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // DOM click (not coordinates) so hover-revealed (opacity-0) buttons still work.
  // All click commands retry for 5s while the target is missing or disabled —
  // git-panel buttons disable while an operation is in flight, and the panel can
  // repaint (via a state broadcast) BEFORE the op's busy flag clears, so a click
  // straight after a wait can otherwise land on a still-disabled button.
  async click(sel) {
    if (!need()) return
    const r = await page.evaluate(async (s) => {
      const t0 = Date.now()
      for (;;) {
        const el = document.querySelector(s)
        if (el && !el.disabled) {
          el.click()
          return 'OK'
        }
        if (Date.now() - t0 > 5000) return el ? 'DISABLED_TIMEOUT' : 'NOT_FOUND'
        await new Promise((r) => setTimeout(r, 150))
      }
    }, sel)
    console.log('click', sel, '→', r)
  },

  // Click any button by its title attribute (exact, then prefix match).
  async 'click-title'(title) {
    if (!need()) return
    const r = await page.evaluate(async (t) => {
      const t0 = Date.now()
      for (;;) {
        const btn =
          document.querySelector(`button[title="${t}"]`) ??
          document.querySelector(`button[title^="${t}"]`)
        if (btn && !btn.disabled) {
          btn.click()
          return 'OK'
        }
        if (Date.now() - t0 > 5000) return btn ? 'DISABLED_TIMEOUT' : 'NOT_FOUND'
        await new Promise((r) => setTimeout(r, 150))
      }
    }, title)
    console.log('click-title', JSON.stringify(title), '→', r)
  },

  async 'click-text'(text) {
    if (!need()) return
    const r = await page.evaluate(async (t) => {
      const t0 = Date.now()
      for (;;) {
        const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
        const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
        if (el && !el.disabled) {
          el.click()
          return 'OK: ' + el.tagName
        }
        if (Date.now() - t0 > 5000) return el ? 'DISABLED_TIMEOUT' : 'NOT_FOUND'
        await new Promise((r) => setTimeout(r, 150))
      }
    }, text)
    console.log('click-text', JSON.stringify(text), '→', r)
  },

  // Git-panel row action: `row <path> <button title…>`. Finds the changed-file
  // row via its "Open diff — <path>" button, then clicks the titled button in it
  // (Stage / Unstage / Discard changes / Delete file / Confirm / Cancel).
  async row(rest) {
    if (!need()) return
    const sp = rest.indexOf(' ')
    if (sp === -1) return console.log('usage: row <path> <button title>')
    const fp = rest.slice(0, sp)
    const title = rest.slice(sp + 1)
    const r = await page.evaluate(
      ([p, t]) => {
        const open = document.querySelector(`button[title="Open diff — ${p}"]`)
        if (!open) return 'NO_ROW'
        const row = open.closest('.group') ?? open.parentElement
        const btn = row.querySelector(`button[title="${t}"]`) ?? row.querySelector(`button[title^="${t}"]`)
        if (!btn) return `NO_BTN (have: ${[...row.querySelectorAll('button')].map((b) => b.title).join(', ')})`
        btn.click()
        return 'OK'
      },
      [fp, title]
    )
    console.log('row', fp, JSON.stringify(title), '→', r)
  },

  // Print the right-rail (git panel + tasks) text — the quickest state check.
  async panel() {
    if (!need()) return
    console.log(await page.evaluate(() => document.querySelector('aside.border-l')?.innerText ?? '(no panel)'))
  },

  // Fill the commit-message textarea (\n escapes become newlines). Located by
  // element, NOT placeholder — the placeholder changes when Amend is toggled.
  async msg(text) {
    if (!need()) return
    await page.locator('aside.border-l textarea').fill(text.replace(/\\n/g, '\n'))
    console.log('msg set')
  },

  async type(text) {
    if (need()) await page.keyboard.type(text, { delay: 20 })
  },
  async press(key) {
    if (need()) await page.keyboard.press(key)
  },

  async wait(sel) {
    if (!need()) return
    try {
      await page.waitForSelector(sel, { timeout: 10_000 })
      console.log('found:', sel)
    } catch {
      console.log('TIMEOUT:', sel)
    }
  },

  // Poll until the page's innerText contains (or with a leading !, no longer
  // contains) the given substring. 15s budget.
  async waittext(rest) {
    if (!need()) return
    const negate = rest.startsWith('!')
    const needle = negate ? rest.slice(1) : rest
    const t0 = Date.now()
    for (;;) {
      const has = await page.evaluate((n) => document.body.innerText.includes(n), needle)
      if (negate ? !has : has) return console.log('ok:', rest)
      if (Date.now() - t0 > 15_000) return console.log('TIMEOUT waiting for', JSON.stringify(rest))
      await sleep(250)
    }
  },

  async eval(expr) {
    if (!need()) return
    try {
      console.log(JSON.stringify(await page.evaluate(expr)))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  },

  async text(sel) {
    if (!need()) return
    console.log(
      await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null)
    )
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  // Native window title (BrowserWindow.getTitle()) — NOT document.title, which
  // stays a static "Orbital"; the main process owns the workspace-aware title.
  async wtitle() {
    if (!app) return console.log('ERROR: launch first')
    console.log(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).join(' | '))
    )
  },

  async sleep(ms) {
    await sleep(parseInt(ms, 10) || 500)
  },

  async quit() {
    // app.close() can hang on Windows when PTY children (shells, Claude
    // sessions) linger — race it against a deadline, then hard-kill.
    if (app) {
      await Promise.race([app.close(), sleep(10_000)]).catch(() => {})
      try {
        app.process().kill()
      } catch {
        /* already gone */
      }
    }
    app = null
    page = null
  },

  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'driver> ' })
const interactive = process.stdin.isTTY

async function handleLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return
  const sp = trimmed.indexOf(' ')
  const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp)
  const rest = sp === -1 ? '' : trimmed.slice(sp + 1)
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log('unknown:', cmd, '— try: help')
  } else {
    try {
      await fn(rest)
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  }
  if (cmd === 'quit') process.exit(0)
  if (interactive) rl.prompt()
}

// readline fires 'line' without awaiting async handlers, which would let piped
// commands race past `launch`. Serialize everything through one promise chain.
let chain = Promise.resolve()
rl.on('line', (line) => {
  chain = chain.then(() => handleLine(line))
})
rl.on('close', () => {
  chain = chain.then(async () => {
    await COMMANDS.quit()
    process.exit(0)
  })
})

console.log('orbital driver — "help" for commands, "launch" to start')
if (interactive) rl.prompt()
