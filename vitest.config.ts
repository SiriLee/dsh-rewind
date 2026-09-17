import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // The real package's bundle imports shell-supplied heavyweights
      // (shiki, anser, …) that a plugin checkout does not install, so the whole
      // suite resolves it to a small stand-in with the same contract. Types
      // still come from the real package's declarations (see the stub's doc).
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/support/ui-primitives-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
