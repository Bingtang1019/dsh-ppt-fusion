import { defineConfig } from 'vitest/config'

// Unit tests never touch the network, the engine venv, or PowerPoint: every
// process boundary is injected (see tests/support/fake-runner.ts), so both CI
// platforms run the same suite.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
})
