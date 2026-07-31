import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    reporters: ['default'],
    // The default 'forks' pool spawns workers via child_process.fork(), which
    // relies on process.execPath pointing at the real node binary. Some dev
    // environments run node through a dynamic-linker shim (e.g. to bridge an
    // older system glibc) that leaves process.execPath pointing at the linker
    // itself, silently breaking 'forks'. 'threads' uses worker_threads instead,
    // which stays in-process and is unaffected.
    pool: 'threads'
  }
});
