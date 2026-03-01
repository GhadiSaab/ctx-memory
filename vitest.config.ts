// vitest.config.ts  (at root, next to package.json)
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Point all workers at an in-memory DB so tests never touch disk
    env: {
      LLM_MEMORY_DB_PATH: ':memory:',
    },
    // Serialize test files — the db singleton is shared within a process,
    // so concurrent files would corrupt each other's state.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
})