import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit + e2e tests in the same `test/` directory.
    include: ['test/**/*.test.ts'],
    // Anvil fork RPC, transaction confirmations and on-chain reads can be slow.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Globals from the e2e setup (anvil pool, fork URL, port) live here.
    globalSetup: ['./test/e2e/globalSetup.ts'],
    // Test sometimes fail since they are using the same chain and same addresses due to
    // Changing the seeded USDC values and such, so files must not run in parallel
    fileParallelism: false,
  },
});
