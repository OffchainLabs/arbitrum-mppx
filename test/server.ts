import express from 'express'
import { Mppx } from 'mppx/express'
import { arbitrum } from '../src/server/index.js';
import { config } from 'dotenv';
import * as defaults from "../src/default.js"
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
const PORT = 3000;

config()

const app = express()
/**
 * When creating an MPP instance with a method, certain values are required. One for instance
 * is the network/chainID, if you are going to use the same network for all transactions. Then you
 * can put that here first. If its going to be different for each 
 */

if (process.env.SERVER_PRIVATE_KEY == undefined) throw new Error(`Server private key required`);

const account = privateKeyToAccount(process.env.SERVER_PRIVATE_KEY as Hex)

const mppx = Mppx.create({
  methods: [arbitrum.charge({
    recipient: account.address,
    currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
    methodDetails: {
      chainId: 421614,
      decimals: 6,
    },
    account: account
  })],
  secretKey: process.env.SERVER_PRIVATE_KEY
})

// Currently does not support decimals for human readable currency. 
// may add it later but for now lets try this
app.get(
  '/favorite',
  mppx.charge({
    amount: '1000',
    description: "My favorite food",
    methodDetails: {
      chainId: 421614,
      permit2Address: defaults.PERMIT2_ADDRESS,
      credentialTypes: ["authorization"]
    }
  }),
  (req, res) => res.json({ data: 'I like burgers' })
)

app.get(
  '/permit2SignatureTest',
  mppx.charge({
    amount: '1000',
    description: "Testing permit2",
    methodDetails: {
      chainId: 421614,
      permit2Address: defaults.PERMIT2_ADDRESS,
      credentialTypes: ["permit2"]
    }
  }),
  (req, res) => res.json({ data: 'The only thing that matters is the signature validity right now' })
)

app.get(
  '/permit2SignatureTestSplit',
  mppx.charge({
    amount: '1150',
    description: "Testing permit2",
    methodDetails: {
      chainId: 421614,
      permit2Address: defaults.PERMIT2_ADDRESS,
      credentialTypes: ["permit2"],
      splits: [{
        recipient: "0x6Cdd1BBD6DeD546a52E9e46A1Cae4839d008eC38",
        amount: "50",
        memo: "This emits second"
      },
      {
        recipient: "0xB022b539C3bB7a1E6Cc73F6e78d3B4c39b73b0d3",
        amount: "100",
        memo: "This emits third"

      }]
    }
  }),
  (req, res) => res.json({ data: 'Splits worked!' })
)

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`)
  console.log(`Direct Get: http://localhost:${PORT}/favorite`)
})