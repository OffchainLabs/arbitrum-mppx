/**
 * Shared constants & helpers for anvil-backed e2e tests.
 *
 * The global setup (`./globalSetup.ts`) spins up a single anvil instance
 * forked from Arbitrum Sepolia. Tests import `ANVIL_RPC_URL` / `ANVIL_CHAIN_ID`
 * from here to create viem clients pointed at that node.
 */

import * as defaults from "../../src/default.js";

// Port chosen to avoid collisions with common dev defaults (anvil default is 8545).
export const ANVIL_PORT = 8645;

export const ANVIL_HOST = "127.0.0.1";

export const ANVIL_RPC_URL = `http://${ANVIL_HOST}:${ANVIL_PORT}`;

export const FORK_URL =
  process.env["FORK_URL"] ?? defaults.rpcUrl[defaults.chainId.arbitrumSepolia]!;

export const ANVIL_CHAIN_ID = defaults.chainId.arbitrumSepolia;

// These were taken from anvils mnemonic test test test test test test test test test test test junk
// BUG ALERT: make sure the onchain address for these accounts do not have delegated contracts attached to them
// it causes EIP-3009 to cause a weird signature error. the error that will be given claims the signature is 
// invalid, while in reality what may have happened is what I just described
export const ANVIL_TEST_ACCOUNTS = {
  server: {
    address: "0x0Ae8AD869F38E24403b546Bea23a5735F9aBaECD" as const,
    privateKey:
      "0xc1acab0b3f734a64c96a87078b379778cce6a0d441291ae66082dae55b1bd675" as const,
  },
  client: {
    address: "0xB37a9B65c2e71C4A312aC837d0781de2F08abAbC" as const,
    privateKey:
      "0x3312c2e3b5ae954fcb6db2cfa5930a84cc4ff7e8b0a1ac07ed88487de1b033f0" as const,
  },
  splits1: {
    address: "0xbe42916AA0CD2Ecc7358Be03E59d4B35fd2CB1e8" as const,
    privateKey: "0xa56ca1b4b7f63ecab0f1222e5cbcc847cf471c2b974a88cb69dc760a461e82ec" as const,
  },
  splits2: {
    address: "0x677C808f267C5f9477f120c28b57135Ff6a5B856",
    privateKey: "0x358eb6cb1c388fd03cbc55bb8bf794df034174f9da93978efe8281d97fe4357d"
  },
  splits3: {
    address: "0x828DA46e6c8552FE0A43aa9756ed1Bc3172bc139",
    privateKey: "189e7f02112025a0b340f056d2c4cbceda03330158fbb26885f0ab8e48743801"
  }
} as const;
