/* eslint-disable */
/**
 * State-store benchmark: better-sqlite3 (the REAL repositories, bundled) vs a
 * modeled JSON store (in-memory maps + debounced tmp+rename flushes) — the two
 * candidates for Orbital's per-workspace state. Informs the "drop SQLite for a
 * JSON state file?" decision (draft task): the pivot keeps SQLite unless JSON
 * improves RUNTIME PERFORMANCE, so this measures the app's actual hot paths:
 *
 *  1. appState() hydration — runs on every coalesced broadcast (50ms bursts
 *     while agents work). SQLite re-queries + re-hydrates; JSON returns memory.
 *  2. Status-write bursts — Claude hooks fire per tool call: a tab status
 *     update + worktree aggregate recompute each time.
 *  3. Layout drags — rapid setRatio writes while resizing panes.
 *  4. Boot load — one full read at startup.
 *
 * Run:  ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe bench/state-store-bench.cjs
 * (Electron's binary so better-sqlite3 loads with the app's ABI.)
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const REPO = path.resolve(__dirname, '..')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-bench-'))

// Bundle the real DB layer once (same pattern as the verify harnesses). The
// bundle must live INSIDE the repo tree so `better-sqlite3` resolves.
const bundle = path.join(__dirname, '.repos.bundle.tmp.cjs')
require(path.join(REPO, 'node_modules', 'esbuild')).buildSync({
  entryPoints: [path.join(REPO, 'bench', 'repos-entry.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'],
  alias: { '@shared/types': path.join(REPO, 'src', 'shared', 'types.ts') },
  outfile: bundle
})
const real = require(bundle)

/* ---- timing helpers ------------------------------------------------------ */

function bench(fn, iters) {
  const times = []
  for (let i = 0; i < Math.min(iters, 10); i++) fn() // warmup
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint()
    fn()
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  return {
    median: times[Math.floor(times.length / 2)],
    p95: times[Math.floor(times.length * 0.95)],
    total: times.reduce((a, b) => a + b, 0)
  }
}
const ms = (n) => `${n.toFixed(3)}ms`

/* ---- dataset shapes ------------------------------------------------------ */

const SCALES = {
  'realistic (today)': { projects: 11, worktreesPer: 2, tabsPerWorktree: 3, tasks: 40 },
  'heavy user (5x)': { projects: 25, worktreesPer: 4, tabsPerWorktree: 4, tasks: 200 },
  'stress (20x)': { projects: 50, worktreesPer: 10, tabsPerWorktree: 5, tasks: 1000 }
}

/* ---- the modeled JSON store ---------------------------------------------- */
// What a real replacement would look like: whole state in memory with Map
// indexes, mutations touch memory, a debounced flush serializes the WHOLE
// state to disk via tmp+rename. appState() returns the in-memory object.
class JsonStore {
  constructor(file) {
    this.file = file
    this.state = { workspaces: [], projects: [], worktrees: [], tasks: [], settings: {} }
    this.tabIndex = new Map() // tabId -> tab
    this.wtIndex = new Map() // worktreeId -> worktree
    this.flushTimer = null
    this.flushCount = 0
  }
  reindex() {
    this.tabIndex.clear()
    this.wtIndex.clear()
    for (const w of this.state.worktrees) {
      this.wtIndex.set(w.id, w)
      for (const p of w.panes) for (const t of p.tabs) this.tabIndex.set(t.id, t)
    }
  }
  load() {
    this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    this.reindex()
  }
  appState() {
    return this.state
  }
  updateTabStatus(tabId, status) {
    const tab = this.tabIndex.get(tabId)
    if (!tab) return
    tab.status = status
    const wt = this.wtIndex.get(tab.worktreeId)
    // aggregate recompute, same precedence logic as the app
    const order = ['needs_attention', 'error', 'working', 'idle', 'done']
    const statuses = []
    for (const p of wt.panes) for (const t of p.tabs) if (t.status) statuses.push(t.status)
    wt.status = order.find((s) => statuses.includes(s)) ?? 'idle'
    this.scheduleFlush()
  }
  setRatio(worktreeId, ratio) {
    const wt = this.wtIndex.get(worktreeId)
    if (wt.layout && wt.layout.type === 'split') wt.layout.ratio = ratio
    this.scheduleFlush()
  }
  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, 50) // mirror the app's broadcast coalescing window
  }
  flushNow() {
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state))
    fs.renameSync(tmp, this.file)
    this.flushCount++
  }
}

/* ---- run one scale -------------------------------------------------------- */

async function runScale(label, shape) {
  const dir = path.join(workDir, label.replace(/[^a-z0-9]/gi, '-'))
  fs.mkdirSync(dir, { recursive: true })

  // --- seed SQLite through the real repositories (also times the write path)
  real.initDb(dir)
  real.getDb()
  const ws = real.workspaces.list()[0] ?? real.workspaces.create('Bench')
  real.setActiveWorkspaceId(ws.id)
  const t0 = process.hrtime.bigint()
  for (let p = 0; p < shape.projects; p++) {
    const project = real.projects.create({ name: `proj-${p}`, repoPath: `C:/repos/proj-${p}` })
    for (let w = 0; w < shape.worktreesPer; w++) {
      const wt = real.worktrees.create({
        projectId: project.id,
        kind: w === 0 ? 'root' : 'linked',
        name: w === 0 ? 'main' : `wt-${w}`,
        path: w === 0 ? `C:/repos/proj-${p}` : `C:/repos/wt/proj-${p}-${w}`,
        branch: w === 0 ? 'main' : `feat/${w}`
      })
      const paneId = wt.panes[0].id
      for (let t = 0; t < shape.tabsPerWorktree; t++) {
        real.tabs.create({ worktreeId: wt.id, paneId, type: t % 2 === 0 ? 'terminal' : 'agent', status: 'idle' })
      }
    }
  }
  for (let t = 0; t < shape.tasks; t++) {
    const projects = real.projects.list()
    real.tasks.create({ projectId: projects[t % projects.length].id, title: `task-${t}` })
  }
  const seedMs = Number(process.hrtime.bigint() - t0) / 1e6

  const state = { ...real.getAppState(), workspaces: [ws], settings: {} }
  const counts = `${state.projects.length} projects, ${state.worktrees.length} worktrees, ${state.worktrees.reduce((a, w) => a + w.panes.reduce((b, p) => b + p.tabs.length, 0), 0)} tabs, ${state.tasks.length} tasks`

  // --- seed the JSON store with the identical state
  const jsonFile = path.join(dir, 'state.json')
  const json = new JsonStore(jsonFile)
  json.state = JSON.parse(JSON.stringify(state))
  json.reindex()
  json.flushNow()

  const allTabs = []
  for (const w of state.worktrees) for (const p of w.panes) for (const t of p.tabs) allTabs.push(t)

  // --- 1) appState hydration (the broadcast hot path)
  const sqliteRead = bench(() => real.getAppState(), 200)
  const jsonRead = bench(() => json.appState(), 200)
  // JSON with a defensive deep clone (if we ever hand out copies instead of refs)
  const jsonReadClone = bench(() => JSON.parse(JSON.stringify(json.appState())), 200)

  // --- 2) status-write burst: 500 hook events (update + aggregate recompute)
  const sqliteBurst = bench(() => {
    const tab = allTabs[Math.floor(Math.random() * allTabs.length)]
    real.tabs.updateStatus(tab.id, 'working')
    real.worktrees.recomputeStatus(tab.worktreeId)
  }, 500)
  const jsonBurst = bench(() => {
    const tab = allTabs[Math.floor(Math.random() * allTabs.length)]
    json.updateTabStatus(tab.id, 'working')
  }, 500)

  // --- 3) layout drag: 200 rapid ratio writes on one worktree
  const dragWt = state.worktrees[0]
  const sqliteDrag = bench(() => {
    real.worktrees.setLayout(dragWt.id, dragWt.layout)
  }, 200)
  const jsonDrag = bench(() => json.setRatio(dragWt.id, Math.random()), 200)

  // --- 4) the JSON store's real write cost: one full flush (what the debounce pays)
  const jsonFlush = bench(() => json.flushNow(), 50)

  // --- 5) boot load
  real.closeDb()
  const sqliteBoot = bench(() => {
    real.initDb(dir)
    real.getDb()
    real.setActiveWorkspaceId(ws.id)
    real.getAppState()
    real.closeDb()
  }, 20)
  const jsonBoot = bench(() => json.load(), 20)

  const dbSize = fs.statSync(path.join(dir, 'orbital.db')).size
  const jsonSize = fs.statSync(jsonFile).size

  console.log(`\n=== ${label} — ${counts} ===`)
  console.log(`  seed (sqlite, real create() calls):    ${ms(seedMs)} total`)
  console.log(`  sizes: sqlite ${(dbSize / 1024).toFixed(0)}KB, json ${(jsonSize / 1024).toFixed(0)}KB`)
  console.log(`  1) appState hydration  sqlite ${ms(sqliteRead.median)} | json(ref) ${ms(jsonRead.median)} | json(clone) ${ms(jsonReadClone.median)}   (median)`)
  console.log(`  2) status event        sqlite ${ms(sqliteBurst.median)} | json(mem) ${ms(jsonBurst.median)}   (median; json defers cost to flush)`)
  console.log(`  3) layout-drag write   sqlite ${ms(sqliteDrag.median)} | json(mem) ${ms(jsonDrag.median)}   (median)`)
  console.log(`  4) json full flush     ${ms(jsonFlush.median)} median / ${ms(jsonFlush.p95)} p95  (whole-state serialize+write, debounced at 50ms)`)
  console.log(`  5) boot load           sqlite ${ms(sqliteBoot.median)} | json ${ms(jsonBoot.median)}   (median)`)

  // broadcast-storm composite: 100 status events + a broadcast read after each
  real.initDb(dir); real.getDb(); real.setActiveWorkspaceId(ws.id)
  const sqliteStorm = bench(() => {
    const tab = allTabs[Math.floor(Math.random() * allTabs.length)]
    real.tabs.updateStatus(tab.id, 'working')
    real.worktrees.recomputeStatus(tab.worktreeId)
    real.getAppState()
  }, 100)
  const jsonStorm = bench(() => {
    const tab = allTabs[Math.floor(Math.random() * allTabs.length)]
    json.updateTabStatus(tab.id, 'working')
    json.appState()
  }, 100)
  console.log(`  6) storm (write+read)  sqlite ${ms(sqliteStorm.median)} | json ${ms(jsonStorm.median)}   (median per event incl. state rebuild)`)
  real.closeDb()

  if (json.flushTimer) clearTimeout(json.flushTimer)
}

async function main() {
  console.log('Orbital state-store benchmark — real repositories vs modeled JSON store')
  for (const [label, shape] of Object.entries(SCALES)) {
    await runScale(label, shape)
  }
  console.log('\nInterpretation guide:')
  console.log('- Row 1/6 are the broadcast hot path (fires up to every 50ms under agent load).')
  console.log('- JSON "flush" (row 4) is its ONLY real write cost, paid at most once per 50ms;')
  console.log('  compare it to 50ms of sqlite row-writes (rows 2-3 × events in the window).')
  console.log('- Boot (row 5) happens once per instance.')
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(bundle, { force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
