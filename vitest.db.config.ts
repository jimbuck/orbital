import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The SQLite-backed suites (`*.electron.test.ts`). better-sqlite3 is built for
// Electron's ABI, so these run on Electron-as-Node — `npm run test:db` — and
// are excluded from the plain `npm test` run by the default config's include.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.electron.test.ts'],
    // One process: the native addon and Electron's event loop do not need
    // worker fan-out, and a single fork keeps ELECTRON_RUN_AS_NODE simple.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
