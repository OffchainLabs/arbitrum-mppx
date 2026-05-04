import express from 'express'
import { Mppx } from 'mppx/express'
import { arbitrum } from '../src/server';
import { config } from 'dotenv';
const PORT = 3000;

config()

const app = express()
/**
 * When creating an MPP instance with a method, certain values are required. One for instance
 * is the network/chainID, if you are going to use the same network for all transactions. Then you
 * can put that here first. If its going to be different for each 
 */


const mppx = Mppx.create({
  methods: [arbitrum.charge({
    recipient: "0x6Cdd1BBD6DeD546a52E9e46A1Cae4839d008eC38",
    currency: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    methodDetails: {
      permit2Address: "0x",
      chainId: 421614,
      decimals: 6,
      credentialTypes: ["authorization"]
    }
  })],
  secretKey: process.env.SERVER_PRIVATE_KEY
})

// Currently does not support decimals for human readable currency. may add it later but for now lets try this
app.get(
  '/favorite',
  mppx.charge({
    amount: '10000',
    description: "My favorite food",
  }),
  (req, res) => res.json({ data: 'I like burgers' })
)


app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`)
  console.log(`Direct Get: http://localhost:${PORT}/favorite`)
})