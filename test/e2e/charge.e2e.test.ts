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

const clientAccount = privateKeyToAccount(ANVIL_TEST_ACCOUNTS.client.privateKey);

const serverAccount = privateKeyToAccount(ANVIL_TEST_ACCOUNTS.server.privateKey);

const USDC_BALANCES_SLOT = 9n; // FiatTokenV2_2 balanceAndBlacklistStates
const USDC_ALLOWED_SLOT = 10n; // FiatTokenV2_2 allowed mapping

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

async function seedUsdcAllowance(
  testClient: TestClient,
  params: {
    token: Address;
    owner: Address;
    spender: Address;
    amount: bigint;
  }
) {
  const { token, owner, spender, amount } = params;

  const innerSlot = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [owner, USDC_ALLOWED_SLOT]
    )
  ) as Hash;
  const slot = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [spender, innerSlot]
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
// any is bad but im not sure how to give it the correct type
// this just makes it so the process of rawFetch and getting the proper credential is much easier
// createCredential still exists and is not just a part of this function incase we need it
async function rawFetchAndMakeDecodedCredential<T>(clientMppx: MppxClient.Mppx, fetchEndpoint: string):
  Promise<{ challenge: unknown, payload: T, source?: string }> {
  const response = await clientMppx.rawFetch(fetchEndpoint);
  const encodedCredential = await clientMppx.createCredential(response);
  return encodedCredentialToJson(encodedCredential);
}

async function encodeAndSendCredential(clientMppx: MppxClient.Mppx, jsonCredential: any, fetchEndpoint: string) {
  const reEncodedCredential = jsonToEncodedCredential(jsonCredential);
  const init = clientMppx.transport.setCredential({}, reEncodedCredential);
  return await clientMppx.rawFetch(fetchEndpoint, init);
}

// Both functions below are for manually editing the credential to make sure the server is
// properly ignoring credentials that are fraudulent
function encodedCredentialToJson(encodedCredential: string) {
  // the string "Payment " is at the beginning of the encoded credential and is not part of the 
  // encoding, so it needs to be removed so the encoding works properly
  const SLICE_INDEX = "Payment ".length
  const strippedCredential = encodedCredential.slice(SLICE_INDEX);
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

describe("e2e Permit2", async () => {
  const app = express();
  const PORT = 3002;
  const SPLIT_ENDPOINT = 'permit2Split';
  const NO_SPLIT_ENDPOINT = 'permit2NoSplit';
  const THREE_SPLIT_ENDPOINT = 'permit2ThreeSplit';
  const SPLIT_DATA = 'split permit2 e2e test worked!';
  const NO_SPLIT_DATA = 'no split permit2 e2e test worked!';
  const SPLIT_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${SPLIT_ENDPOINT}`;
  const NO_SPLIT_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${NO_SPLIT_ENDPOINT}`;
  const THREE_SPLIT_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${THREE_SPLIT_ENDPOINT}`;
  let server: Server;

  const serverMppx = await mppServerSetup({
    recipient: serverAccount.address,
    currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
    chainId: anvilPublicClient.chain.id,
    rpcUrls: rpcMapping,
    privateKey: ANVIL_TEST_ACCOUNTS.server.privateKey
  });

  app.get(
    `/${NO_SPLIT_ENDPOINT}`,
    //@ts-ignore
    serverMppx.charge({
      amount: '1000',
      description: "permit2 no splits description",
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        permit2Address: defaults.PERMIT2_ADDRESS,
        credentialTypes: ["permit2"]
      }
    }),
    (req, res) => res.json({ data: NO_SPLIT_DATA })
  );
  app.get(
    `/${SPLIT_ENDPOINT}`,
    //@ts-ignore
    serverMppx.charge({
      amount: '1500',
      description: "permit2 splits description",
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        permit2Address: defaults.PERMIT2_ADDRESS,
        credentialTypes: ["permit2"],
        splits: [{
          recipient: ANVIL_TEST_ACCOUNTS.splits1.address,
          amount: "500"
        }]
      }
    }),
    (req, res) => res.json({ data: SPLIT_DATA })
  );
  app.get(
    `/${THREE_SPLIT_ENDPOINT}`,
    //@ts-ignore
    serverMppx.charge({
      amount: '2500',
      description: "permit2 splits description",
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        permit2Address: defaults.PERMIT2_ADDRESS,
        credentialTypes: ["permit2"],
        splits: [{
          recipient: ANVIL_TEST_ACCOUNTS.splits1.address,
          amount: "700"
        },
        {
          recipient: ANVIL_TEST_ACCOUNTS.splits2.address,
          amount: "450"
        }, 
        {
          recipient: ANVIL_TEST_ACCOUNTS.splits3.address,
          amount: "200"
        }]
      }
    }),
    (req, res) => res.json({ data: SPLIT_DATA })
  );

  const clientMppx = MppxClient.create({
    methods: [chargeClient({
      account: clientAccount,
      //@ts-ignore IDE doesnt recognize that its the client parameters and not the server parameters
      chainId: 421614,
      rpcUrls: rpcMapping
    })],
    polyfill: false
  })

  beforeEach(async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: USDC_DEFAULT_SEEDED
    })
    await seedUsdcAllowance(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      owner: clientAccount.address,
      spender: defaults.PERMIT2_ADDRESS,
      amount: USDC_DEFAULT_SEEDED,
    })
  })

  beforeAll(() => {
    server = app.listen(PORT);
    fundAccounts([clientAccount, serverAccount], anvilTestClient);
  })

  afterAll(() => {
    server.close();
    // anvilTestClient.reset({ jsonRpcUrl: ANVIL_RPC_URL });
  })

  it("Succeeds with no splits", async () => {
    const returnVal = await clientMppx.fetch(NO_SPLIT_FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data["data"]).toEqual(NO_SPLIT_DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })

  it("Succeeds with splits length 1", async () => {
    const returnVal = await clientMppx.fetch(SPLIT_FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data["data"]).toEqual(SPLIT_DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })

  it("Succeeds with splits length 3", async () => {
    const returnVal = await clientMppx.fetch(SPLIT_FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data["data"]).toEqual(SPLIT_DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })
})

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

  const clientMppx = MppxClient.create({
    methods: [chargeClient({
      account: clientAccount,
      //@ts-ignore IDE doesnt recognize that its the client parameters and not the server parameters
      chainId: 421614,
      rpcUrls: rpcMapping
    })],
    polyfill: false
  })

  beforeEach(async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: USDC_DEFAULT_SEEDED
    })
  })

  beforeAll(() => {
    server = app.listen(PORT);
    fundAccounts([clientAccount, serverAccount], anvilTestClient);
  })

  afterAll(() => {
    server.close();
  })

  it("Succeeds and gets data", async () => {
    const returnVal = await clientMppx.fetch(FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data["data"]).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })

  it("decode and encode makes successful payment", async () => {
    // This is more of a sanity check to make sure that this process results in a successful 
    // payment, so we can edit the credential knowing that if it fails its not due to this process
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);

    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal)

    expect(data['data']).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })


  it("Fails with tampered signature (payload.signature)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // invalidate sig (must be same length or else a different check fails before signature validation)
    jsonCredential.payload.signature = "0x7c3a9f8e4b2d1e6f5a8c9b0d3e7f2a4c6b8d1e3f5a7c9b2d4e6f8a0c2b4d6e8f1a3c5e7f9b1d3e5f7a9c1b3d5e7f9a2c4b6d8e0f3a5c7b9d1e3f5a7c9b2d4e6f1b";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT)
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered amount (payload.amount)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.value) / BigInt(2);
    jsonCredential.payload.value = falseValue.toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered recipient (payload.to)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // Redirect funds to an attacker-controlled address
    jsonCredential.payload.to = "0x000000000000000000000000000000000000bEEF";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered sender (payload.from)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // Pretend a different account is paying — signature recovery will not match
    jsonCredential.payload.from = serverAccount.address;
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered nonce", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // Replace the challenge-bound nonce with an arbitrary 32-byte value
    jsonCredential.payload.nonce = "0x" + "ab".repeat(32);
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with expired validBefore", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // Set validBefore to a past timestamp
    jsonCredential.payload.validBefore = "1";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered validAfter", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // Bumping validAfter invalidates the EIP-712 signature
    jsonCredential.payload.validAfter = (
      BigInt(jsonCredential.payload.validAfter) + BigInt(1)
    ).toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with unknown payload type", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    jsonCredential.payload.type = "not-a-real-type";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with insufficient funds", async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: 0n
    })
    await expect(clientMppx.fetch(FETCH_ENDPOINT)).rejects.toThrow('Insufficient funds');
  })

  it("Fails with insufficient funds after client signs with sufficient funds", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);

    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: BigInt(jsonCredential.payload.value) - 1n
    })

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })
})
