import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// vitest must resolve the same "@/..." alias Next.js uses, because some modules under test (e.g.
// lib/onboard/mapmatch.ts) import via "@/lib/...". fileURLToPath(new URL('.', import.meta.url)) is
// the cross-platform way to get this directory as an absolute path (works on Windows + POSIX).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
