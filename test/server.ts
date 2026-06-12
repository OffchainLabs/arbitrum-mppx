import { config } from 'dotenv';
import express from 'express';
import { Mppx, discovery } from 'mppx/express';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import * as defaults from '../src/default.js';
import { charge } from '../src/server/index.js';

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

console.log(account.address);

const mppx = Mppx.create({
  methods: [
    charge({
      recipient: account.address,
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      methodDetails: {
        chainId: 421614,
        decimals: 6,
      },
      account: account,
    }),
  ],
  secretKey: process.env.SERVER_PRIVATE_KEY,
});

// Currently does not support decimals for human readable currency.
// may add it later but for now lets try this

const auth = mppx.charge({
  amount: '1000',
  description: 'My favorite food',
  methodDetails: {
    chainId: 421614,
    permit2Address: defaults.PERMIT2_ADDRESS,
    credentialTypes: ['authorization'],
  },
});

const permit2 = mppx.charge({
  amount: '1000',
  description: 'Testing permit2',
  methodDetails: {
    chainId: 421614,
    permit2Address: defaults.PERMIT2_ADDRESS,
    credentialTypes: ['permit2'],
  },
});

const permit2Split = mppx.charge({
  amount: '1150',
  description: 'Testing permit2',
  methodDetails: {
    chainId: 421614,
    permit2Address: defaults.PERMIT2_ADDRESS,
    credentialTypes: ['permit2'],
    splits: [
      {
        recipient: '0x6Cdd1BBD6DeD546a52E9e46A1Cae4839d008eC38',
        amount: '50',
        memo: 'This emits second',
      },
      {
        recipient: '0xB022b539C3bB7a1E6Cc73F6e78d3B4c39b73b0d3',
        amount: '100',
        memo: 'This emits third',
      },
    ],
  },
});

app.get('/authorization', auth, (req, res) =>
  res.json({
    data: `authorization worked!, Also I 
    really like this sushi called the angry lobster roll at this all you can eat sushi
    restaurant, i ordered it 3 times`,
  }),
);

app.get('/permit2SignatureTest', permit2, (req, res) =>
  res.json({ data: 'permit2 no splits worked!' }),
);

app.get('/permit2SignatureTestSplit', permit2Split, (req, res) =>
  res.json({ data: 'Splits worked!' }),
);

// Claude says MPPX is bugged so you have to manually pass in the summaries
discovery(app, mppx, {
  info: { title: 'Demo API', version: '1.0.0' },
  routes: [
    { handler: auth, method: 'get', path: '/authorization', summary: 'My favorite food' },
    { handler: permit2, method: 'get', path: '/permit2SignatureTest', summary: 'permit2Endpoint' },
    {
      handler: permit2Split,
      method: 'get',
      path: '/permit2SignatureTestSplit',
      summary: 'Permit2SplitsEndpoint',
    },
  ],
});

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
