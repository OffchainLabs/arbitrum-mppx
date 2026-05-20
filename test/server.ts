import express from 'express';
import { Mppx } from 'mppx/express';
import { charge } from '../src/server/index.js';
import { config } from 'dotenv';
import * as defaults from '../src/default.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
const PORT = 3000;

config();

const app = express();
/**
 * When creating an MPP instance with a method, certain values are required. One for instance
 * is the network/chainID, if you are going to use the same network for all transactions. Then you
 * can put that here first. If its going to be different for each
 */

if (process.env.SERVER_PRIVATE_KEY == undefined) throw new Error(`Server private key required`);

const account = privateKeyToAccount(process.env.SERVER_PRIVATE_KEY as Hex);

const mppx = Mppx.create({
  methods: [
    charge({
      recipient: account.address,
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      methodDetails: {
        // When permit2 is implemented will make it the real address
        permit2Address: '0x',
        chainId: 421614,
        decimals: 6,
        credentialTypes: ['authorization'],
      },
      account: account,
    }),
  ],
  secretKey: process.env.SERVER_PRIVATE_KEY,
});

// Currently does not support decimals for human readable currency.
// may add it later but for now lets try this
app.get(
  '/favorite',

  mppx.charge({
    amount: '1000',
    description: 'My favorite food',
  }),
  (req, res) => res.json({ data: 'I like burgers' }),
);

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
  console.log(`Direct Get: http://localhost:${PORT}/favorite`);
});
