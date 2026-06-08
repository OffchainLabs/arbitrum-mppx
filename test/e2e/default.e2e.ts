import { createPublicClient, createTestClient, http } from 'viem';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ANVIL_CHAIN_ID, ANVIL_RPC_URL, ANVIL_TEST_ACCOUNTS } from './anvil';

export const anvilChain = { id: ANVIL_CHAIN_ID, name: 'anvil-fork' } as Chain;

export const transport = http(ANVIL_RPC_URL);

// Creating the clients here might be silly, but since I use them in both files
// I put them here
export const anvilPublicClient = createPublicClient({ chain: anvilChain, transport });

export const anvilTestClient = createTestClient({ chain: anvilChain, mode: 'anvil', transport });

export const clientAccount = privateKeyToAccount(ANVIL_TEST_ACCOUNTS.client.privateKey);

export const serverAccount = privateKeyToAccount(ANVIL_TEST_ACCOUNTS.server.privateKey);

export const USDC_BALANCES_SLOT = 9n; // FiatTokenV2_2 balanceAndBlacklistStates
export const USDC_ALLOWED_SLOT = 10n; // FiatTokenV2_2 allowed mapping

export const USDC_DEFAULT_SEEDED = 1000000n;
