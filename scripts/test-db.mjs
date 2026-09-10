// Run the SQLite-backed test suites on Electron's own Node (same ABI as the
// rebuilt better-sqlite3), since plain `node` cannot load the addon.
//
//   npm run test:db            # all *.electron.test.ts
//   npm run test:db -- -t seq  # any extra vitest args pass through
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron') // the binary's path when required from Node
const vitest = resolve('node_modules/vitest/vitest.mjs')

const result = spawnSync(electron, [vitest, 'run', '--config', 'vitest.db.config.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(result.status ?? 1)
