import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  keccak256,
  encodeAbiParameters,
  toHex,
  pad,
  createTestClient
} from "viem";
import type { Chain, Address, Hash, TestClient, Hex, Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { setStorageAt, setBalance } from "viem/actions";
import { ANVIL_RPC_URL, ANVIL_CHAIN_ID, ANVIL_TEST_ACCOUNTS, ANVIL_HOST } from "./anvil.js";
import { Mppx as MppxExpress } from 'mppx/express'
import { Mppx as MppxClient } from "mppx/client";
import { charge as chargeServer } from '../../src/server/index.js';
import { charge as chargeClient } from '../../src/client/index.js';
import * as defaults from '../../src/default.js';
import express from 'express'
import { Server } from "node:http";

const anvilChain = { id: ANVIL_CHAIN_ID, name: "anvil-fork" } as Chain;

const transport = http(ANVIL_RPC_URL);

const anvilPublicClient = createPublicClient({ chain: anvilChain, transport });

const anvilTestClient = createTestClient({ chain: anvilChain, mode: 'anvil', transport });

const serverAccount = privateKeyToAccount(ANVIL_TEST_ACCOUNTS.client.privateKey);

const clientAccount = privateKeyToAccount(ANVIL_TEST_ACCOUNTS.server.privateKey);

const USDC_BALANCES_SLOT = 9n; // FiatTokenV2_2 balanceAndBlacklistStates

const USDC_DEFAULT_SEEDED = 1000000n

const rpcMapping = new Map<number, string>();

rpcMapping.set(ANVIL_CHAIN_ID, ANVIL_RPC_URL);
function fundAccounts(accounts: Account[], client: TestClient) {
  for (const account of accounts) {
    setBalance(client, {
      address: account.address,
      value: parseEther('10000')
    })
  }
}
// ngl this might be really dumb but ill just remove it later I want this to work first
async function mppServerSetup(params: {
  recipient: Address,
  currency: Address,
  chainId: number,
  rpcUrls: Map<number, string>,
  privateKey: Hex
}) {
  const { recipient, currency, chainId, rpcUrls, privateKey } = params;
  return MppxExpress.create({
    methods: [chargeServer({
      recipient: recipient,
      currency: currency,
      methodDetails: {
        chainId: chainId,
      },
      account: privateKeyToAccount(privateKey),
      rpcUrls: rpcUrls
    })],
    secretKey: privateKey
  })
}

async function seedUsdc(
  testClient: TestClient,
  params: {
    token: Address;
    holder: Address;
    amount: bigint;
  }
) {
  const { token, holder, amount } = params;

  const slot = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, USDC_BALANCES_SLOT]
    )
  ) as Hash;

  await setStorageAt(testClient, {
    address: token,
    index: slot,
    value: pad(toHex(amount)),
  });
}

async function decodeResponse(response: Response) {
  const data = await response.json();
  const paymentReceipt = response.headers.get('payment-receipt')

  // it will be defined im just lazy to write an error
  if (paymentReceipt === undefined) {
    throw new Error("Should not hit for right now");
  }
  // I believe the general pattern is that the test will determine if data is missing
  // so I will not throw and error if info is undefined
  
  const decodedPaymentReceipt = JSON.parse(
    Buffer.from(paymentReceipt ?? "", 'base64').toString('utf8'));
  return { data, decodedPaymentReceipt }
}

// Both functions below are for manually editing the credential to make sure the server is
// properly ignoring credentials that are fraudulent
function encodedCredentialToJson(encodedCredential: string) {
  // the string "Payment " is at the beginning of the encoded credential and is not part of the 
  // encoding, so it needs to be removed so the encoding works properly
  const SLICE_INDEX = "Payment ".length
  const strippedCredential  = encodedCredential.slice(SLICE_INDEX);
  return JSON.parse(Buffer.from(strippedCredential, 'base64').toString('utf-8'));
}

function jsonToEncodedCredential(jsonCredential: any) {
  const reEncodedCredential = Buffer.from(JSON.stringify(jsonCredential)).toString('base64');
  // The string "Payment " is at the beginning of the encoded credential
  // so it needs to be re added 
  return `Payment ${reEncodedCredential}`;
}


describe("e2e: anvil scaffold", () => {
  beforeAll(async () => {
    const blockNumber = await anvilPublicClient.getBlockNumber();
    expect(blockNumber).toBeGreaterThan(0n);
    fundAccounts([clientAccount, serverAccount], anvilTestClient);
  });

  it("connects to the forked Arbitrum Sepolia chain", async () => {
    const chainId = await anvilPublicClient.getChainId();
    expect(chainId).toBe(ANVIL_CHAIN_ID);
  });

  it("anvil-prefunded account server has a non-zero balance", async () => {
    const balance = await anvilPublicClient.getBalance({
      address: serverAccount.address,
    });
    // Anvil funds each test account with 10_000 ETH by default.
    expect(balance).toBeGreaterThan(parseEther("100"));
  });

  it("submits an ETH transfer and the receipt is mined successfully", async () => {
    const recipientAddr =
      "0x000000000000000000000000000000000000bEEF" as const;

    const wallet = createWalletClient({
      account: serverAccount,
      chain: anvilChain,
      transport,
    });

    const value = parseEther("1");

    const recipientBalanceBefore = await anvilPublicClient.getBalance({
      address: recipientAddr,
      // Pin the block so we don't race against newly-mined blocks when
      // diffing balances against the post-tx read.
      blockTag: "latest",
    });

    const hash = await wallet.sendTransaction({
      to: recipientAddr,
      value,
    });

    const receipt = await anvilPublicClient.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe("success");
    expect(receipt.transactionHash).toBe(hash);

    const recipientBalanceAfter = await anvilPublicClient.getBalance({
      address: recipientAddr,
      blockNumber: receipt.blockNumber,
    });

    expect(recipientBalanceAfter - recipientBalanceBefore).toBe(value);
  });
});

describe("e2e: Authorization", async () => {
  const app = express();
  const PORT = 3001;
  const ENDPOINT = 'authE2eTest';
  const DATA = 'authorization e2e test worked!';
  const FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${ENDPOINT}`;
  let server: Server;

  const serverMppx = await mppServerSetup({
    recipient: serverAccount.address,
    currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
    chainId: anvilPublicClient.chain.id,
    rpcUrls: rpcMapping,
    privateKey: ANVIL_TEST_ACCOUNTS.server.privateKey
  });
  app.get(
    `/${ENDPOINT}`,
    //@ts-ignore
    serverMppx.charge({
      amount: '1000',
      description: "authe2eTest description",
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        permit2Address: defaults.PERMIT2_ADDRESS,
        credentialTypes: ["authorization"]
      }
    }),
    (req, res) => res.json({ data: DATA })
  );
  beforeAll(() => {
    server = app.listen(PORT);
    fundAccounts([clientAccount, serverAccount], anvilTestClient);
  })
  afterAll(() => { server.close() })
  const clientMppx = MppxClient.create({
    methods: [chargeClient({
      account: clientAccount,
      //@ts-ignore IDE doesnt recognize that its the client parameters and not the server parameters
      chainId: 421614,
      rpcUrls: rpcMapping
    })]
  })

  beforeEach(async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: USDC_DEFAULT_SEEDED
    })
  })
  afterAll(async () => {
    anvilTestClient.reset({jsonRpcUrl: ANVIL_RPC_URL});
  })

  it("Succeeds and gets data", async () => {
    const response = await clientMppx.fetch(FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(response);
    expect(data["data"]).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })
  
  it("decode and encode makes successful payment", async () => {
    // This is more of a sanity check to make sure that this process results in a successful 
    // payment, so we can edit the credential knowing that it will fail when it should
    const response = await clientMppx.rawFetch(FETCH_ENDPOINT);
    
    const encodedCredential = await clientMppx.createCredential(response);
    
    const jsonCredential = encodedCredentialToJson(encodedCredential);

    const reEncodedCredential = jsonToEncodedCredential(jsonCredential);

    const init = clientMppx.transport.setCredential({}, reEncodedCredential);

    const { data, decodedPaymentReceipt } = await decodeResponse(
      await clientMppx.rawFetch(FETCH_ENDPOINT, init));
    
    expect(data['data']).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })


  it("Fails with invalid signature", async () => {
    // gotta figure out the best way to manipulate the credential
    const response = await clientMppx.rawFetch(FETCH_ENDPOINT);
    const encodedCredential = await clientMppx.createCredential(response);
    let jsonCredential = encodedCredentialToJson(encodedCredential) as defaults.AuthorizationPayload;
    // make sig invalud
    jsonCredential.signature = `${jsonCredential.signature}1`;
  })
})

