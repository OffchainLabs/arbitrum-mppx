import { Mppx } from 'mppx/client'
import { arbitrum } from '../src/client/index.js';
import { config } from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { exit } from 'node:process';
config();

if (process.env.CLIENT_PRIVATE_KEY == undefined) {
  throw new Error(`Client private key required`)
}

const privateKey = process.env.CLIENT_PRIVATE_KEY as `0x${string}`
const account = privateKeyToAccount(privateKey)

const mppx = Mppx.create({
  methods: [arbitrum.charge({
    account: account
  })]
})

const response = await mppx.fetch('http://localhost:3000/favorite');
const data = await response.json();
console.log(data);
const paymentReceipt = response.headers.get('payment-receipt')

//it will be defined im just lazy to write an error
if (paymentReceipt == undefined) exit();
console.log(Buffer.from(paymentReceipt, 'base64').toString('binary'));

