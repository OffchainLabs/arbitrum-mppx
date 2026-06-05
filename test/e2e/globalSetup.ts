import { createAnvil } from '@viem/anvil';

import { ANVIL_HOST, ANVIL_PORT, FORK_URL } from './anvil.js';

export default async function setup() {
  const anvil = createAnvil({
    host: ANVIL_HOST,
    port: ANVIL_PORT,
    forkUrl: FORK_URL,
  });

  await anvil.start();

  return async () => {
    await anvil.stop();
  };
}
