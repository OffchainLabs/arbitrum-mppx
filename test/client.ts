import { Mppx } from 'mppx/client'
import { arbitrum } from '../src/client';
import { config } from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
config();

if (process.env.CLIENT_PRIVATE_KEY == undefined) {
  throw new Error(`Client private key required`)
}

const privateKey = process.env.CLIENT_PRIVATE_KEY as `0x${string}`
const account = privateKeyToAccount(privateKey)

console.log(account.address);

const mppx = Mppx.create({
  methods: [arbitrum.charge({
    account: account
  })]
})

const response = await mppx.fetch('http://localhost:3000/favorite') 


