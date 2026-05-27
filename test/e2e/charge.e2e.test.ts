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
import { buildPermit2TypedData } from '../../src/utils.js';
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

// Re-sign a tampered authorization (ERC-3009) credential so the EIP-712 signature is
// valid for the *new* (tampered) data. Used to confirm the server's per-field checks
// hold even when an attacker controls a key that can produce a valid signature.
async function resignAuthorizationCredential(
  jsonCredential: any,
  params: { currency: Address, signer: Account }
) {
  const { currency, signer } = params;
  const tokenInfo = defaults.erc3009Tokens[currency.toLowerCase()];
  if (!tokenInfo) throw new Error(`No ERC-3009 token info for ${currency}`);

  const typedData = {
    domain: {
      name: tokenInfo.name,
      version: tokenInfo.version,
      chainId: tokenInfo.chainId,
      verifyingContract: currency,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: jsonCredential.payload.from as Address,
      to: jsonCredential.payload.to as Address,
      value: BigInt(jsonCredential.payload.value),
      validAfter: BigInt(jsonCredential.payload.validAfter),
      validBefore: BigInt(jsonCredential.payload.validBefore),
      nonce: jsonCredential.payload.nonce as Hex,
    },
  };
  jsonCredential.payload.signature = await (signer as any).signTypedData(typedData);
  return jsonCredential;
}

// Re-sign a tampered Permit2 credential so the EIP-712 signature is valid for the
// *new* (tampered) data. Without this, every signed-field tamper short-circuits at
// the server's signature check and never exercises the server's per-field validation.
// `recipient` must match request.recipient (the server account) because that becomes
// the `spender` field inside the signed message.
async function resignPermit2Credential(
  jsonCredential: any,
  params: { recipient: Address, chainId: number, signer: Account }
) {
  const { recipient, chainId, signer } = params;
  const typedData = buildPermit2TypedData({
    chainId,
    permitted: jsonCredential.payload.permit.permitted,
    recipient,
    nonce: BigInt(jsonCredential.payload.permit.nonce),
    deadline: BigInt(jsonCredential.payload.permit.deadline),
    Witness: jsonCredential.payload.witness,
  });
  // viem's account.signTypedData accepts the same shape buildPermit2TypedData returns;
  // cast to keep TS happy across the union of single/batch primary types.
  jsonCredential.payload.signature = await (signer as any).signTypedData(typedData);
  return jsonCredential;
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
  const EQUAL_SPLITS_ENDPOINT = 'permit2EqualSplits';
  const SPLIT_DATA = 'split permit2 e2e test worked!';
  const THREE_SPLIT_DATA = 'split permit2 with splits length 3 e2e test worked!';
  const NO_SPLIT_DATA = 'no split permit2 e2e test worked!';
  const EQUAL_SPLITS_DATA = 'permit2 equal-amount splits e2e test worked!';
  const SPLIT_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${SPLIT_ENDPOINT}`;
  const NO_SPLIT_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${NO_SPLIT_ENDPOINT}`;
  const THREE_SPLIT_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${THREE_SPLIT_ENDPOINT}`;
  const EQUAL_SPLITS_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${EQUAL_SPLITS_ENDPOINT}`;
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
    (req, res) => res.json({ data: THREE_SPLIT_DATA })
  );
  app.get(
    `/${EQUAL_SPLITS_ENDPOINT}`,
    //@ts-ignore
    serverMppx.charge({
      amount: '2000',
      description: "permit2 equal-amount splits description",
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        permit2Address: defaults.PERMIT2_ADDRESS,
        credentialTypes: ["permit2"],
        splits: [{
          recipient: ANVIL_TEST_ACCOUNTS.splits1.address,
          amount: "500"
        },
        {
          recipient: ANVIL_TEST_ACCOUNTS.splits2.address,
          amount: "500"
        }]
      }
    }),
    (req, res) => res.json({ data: EQUAL_SPLITS_DATA })
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
    const returnVal = await clientMppx.fetch(THREE_SPLIT_FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data["data"]).toEqual(THREE_SPLIT_DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })

  it("decode and encode makes successful payment", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);

    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal)

    expect(data['data']).toEqual(NO_SPLIT_DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  })

  it("Fails with tampered signature (payload.signature)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // invalidate sig (must be same length or else a different check fails before signature validation)
    jsonCredential.payload.signature = "0x7c3a9f8e4b2d1e6f5a8c9b0d3e7f2a4c6b8d1e3f5a7c9b2d4e6f8a0c2b4d6e8f1a3c5e7f9b1d3e5f7a9c1b3d5e7f9a2c4b6d8e0f3a5c7b9d1e3f5a7c9b2d4e6f1b";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered permitted token (payload.permit.permitted[0].token)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.permit.permitted[0].token = "0x000000000000000000000000000000000000bEEF";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered permitted amount (payload.permit.permitted[0].amount)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.permit.permitted[0].amount) / BigInt(2);
    jsonCredential.payload.permit.permitted[0].amount = falseValue.toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered transfer recipient (payload.transferDetails[0].to)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Redirect funds to an attacker-controlled address
    jsonCredential.payload.transferDetails[0].to = "0x000000000000000000000000000000000000bEEF";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered transfer requestedAmount (payload.transferDetails[0].requestedAmount)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.transferDetails[0].requestedAmount) / BigInt(2);
    jsonCredential.payload.transferDetails[0].requestedAmount = falseValue.toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered nonce (payload.permit.nonce)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Replace the challenge-bound nonce with an arbitrary value
    jsonCredential.payload.permit.nonce = (BigInt(jsonCredential.payload.permit.nonce) + 1n).toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with expired deadline (payload.permit.deadline)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Set deadline to a past timestamp
    jsonCredential.payload.permit.deadline = "1";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered deadline (payload.permit.deadline)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Bumping deadline still in the future invalidates the EIP-712 signature
    jsonCredential.payload.permit.deadline = (
      BigInt(jsonCredential.payload.permit.deadline) + BigInt(1)
    ).toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered witness challengeHash (payload.witness.challengeHash)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // The witness binds the challenge into the EIP-712 signature; changing it
    // either fails signature verification or fails challenge re-binding.
    jsonCredential.payload.witness.challengeHash = "0x" + "ab".repeat(32);
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with unknown payload type", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.type = "not-a-real-type";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with mismatched payload type (authorization)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Permit2 endpoint should reject a credential claiming to be of authorization type
    jsonCredential.payload.type = "authorization";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered split recipient (payload.transferDetails[1].to)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    // The split recipient is committed to by the server when issuing the challenge;
    // redirecting it to an attacker should be rejected.
    jsonCredential.payload.transferDetails[1].to = "0x000000000000000000000000000000000000bEEF";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered split amount (payload.transferDetails[1].requestedAmount)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.transferDetails[1].requestedAmount) / BigInt(2);
    jsonCredential.payload.transferDetails[1].requestedAmount = falseValue.toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with dropped split (transferDetails truncated)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, THREE_SPLIT_FETCH_ENDPOINT);
    // Drop one of the split recipients — server should detect the missing transfer
    jsonCredential.payload.transferDetails.pop();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, THREE_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with insufficient funds", async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: 0n
    })
    await expect(clientMppx.fetch(NO_SPLIT_FETCH_ENDPOINT)).rejects.toThrow('Insufficient funds');
  })

  it("Fails with insufficient funds after client signs with sufficient funds", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);

    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: BigInt(jsonCredential.payload.permit.permitted[0].amount) - 1n
    })

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with reordered splits (transferDetails/permitted permuted)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, THREE_SPLIT_FETCH_ENDPOINT);
    // Three-split endpoint produces arrays of length 4: [primary, split1, split2, split3].
    // Swap split1 (index 1) and split3 (index 3) in both permitted AND transferDetails so the
    // arrays remain internally consistent (p.amount === t.requestedAmount), forcing the failure
    // to come from the server's order check against request.splits rather than from the
    // internal consistency check.
    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[1], permitted[3]] = [permitted[3]!, permitted[1]!];
    [tDetails[1], tDetails[3]] = [tDetails[3]!, tDetails[1]!];
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, THREE_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails when primary recipient is moved out of the front of transferDetails/permitted", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    // Single-split endpoint produces arrays of length 2: [primary, split1]. Swap so the
    // primary is at index 1 and the split is at the front. Done in both arrays to keep them
    // internally consistent so the failure must come from the primary-recipient check.
    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[0], permitted[1]] = [permitted[1]!, permitted[0]!];
    [tDetails[0], tDetails[1]] = [tDetails[1]!, tDetails[0]!];
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with inflated total even when split sums match the new total", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    // Inflate the credential's effective total: bump the primary amount and a split amount.
    // We update both permitted[i].amount and transferDetails[i].requestedAmount so the
    // internal p.amount === t.requestedAmount check still passes — the failure has to come
    // from either the request.amount vs (primary + Σsplits) check or signature verification.
    const DELTA_PRIMARY = 100n;
    const DELTA_SPLIT = 50n;

    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;

    const newPrimary = (BigInt(permitted[0]!.amount) + DELTA_PRIMARY).toString();
    permitted[0]!.amount = newPrimary;
    tDetails[0]!.requestedAmount = newPrimary;

    const newSplit = (BigInt(permitted[1]!.amount) + DELTA_SPLIT).toString();
    permitted[1]!.amount = newSplit;
    tDetails[1]!.requestedAmount = newSplit;

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered source (did:pkh)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // The server parses `source` as did:pkh:eip155:<chainId>:<address> and uses the address
    // to recover the EIP-712 signer. Swapping in the server's address means signature
    // recovery for that address will not match the client's signed message.
    jsonCredential.source = `did:pkh:eip155:${ANVIL_CHAIN_ID}:${serverAccount.address}`;
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with insufficient permit2 allowance", async () => {
    // Zero the USDC->Permit2 allowance so the on-chain transferFrom inside
    // permitWitnessTransferFrom will revert.
    await seedUsdcAllowance(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      owner: clientAccount.address,
      spender: defaults.PERMIT2_ADDRESS,
      amount: 0n
    })
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with wrong chainId in source (did:pkh)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Swap only the chainId portion of did:pkh:eip155:<chainId>:<address>; address stays valid.
    // Server compares Number(chainIdStr) against methodDetails.chainId and must reject.
    jsonCredential.source = `did:pkh:eip155:1:${clientAccount.address}`;
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with malformed source string", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Not a did:pkh URI — fails the `parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'pkh'` guard.
    jsonCredential.source = "did:web:example.com";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with mismatched permitted/transferDetails lengths", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    // Pop only one side so permitted.length !== transferDetails.length — separate branch
    // from the "dropped split" case where both arrays are popped in lock-step.
    jsonCredential.payload.transferDetails.pop();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with reordered equal-amount splits (recipient check, not amount)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, EQUAL_SPLITS_FETCH_ENDPOINT);
    // Both splits configured with amount 500 to different recipients. Swap positions 1 and 2
    // in both arrays so internal consistency (p.amount === t.requestedAmount) still holds AND
    // the cross-position amounts are coincidentally equal — isolating the failure to the
    // recipient-order check against request.splits.
    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[1], permitted[2]] = [permitted[2]!, permitted[1]!];
    [tDetails[1], tDetails[2]] = [tDetails[2]!, tDetails[1]!];
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, EQUAL_SPLITS_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with witness challengeHash from a different challenge", async () => {
    // Pull a witness.challengeHash from an unrelated, separately-issued credential and splice
    // it into this one (keeping our own challenge.id / challenge.realm). The server recomputes
    // keccak256(challenge.id, challenge.realm) and compares against payload.witness.challengeHash,
    // so a hash bound to a different challenge must fail to match.
    const donor = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.witness.challengeHash = donor.payload.witness.challengeHash;
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails on replay of an already-consumed credential", async () => {
    // First submission should succeed and consume the permit2 nonce on-chain.
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    const first = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(first.status).toBe(200);

    // Top the client back up so balance/allowance can't be the reason a replay fails.
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

    // Resubmitting the same credential must fail — either MPP rejects the reused challenge,
    // or the on-chain simulation reverts because Permit2 has already marked the nonce used.
    const second = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(second.status).toBe(402);
    expect(second.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with phantom extra split appended to credential arrays", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    // SPLIT endpoint expects splits.length === 1 so credential arrays should be length 2.
    // Push an extra entry to both arrays — internal lengths stay equal, but
    // (permitted.length - 1 !== request.methodDetails.splits.length) must fail.
    jsonCredential.payload.permit.permitted.push({
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      amount: "100"
    });
    jsonCredential.payload.transferDetails.push({
      to: "0x000000000000000000000000000000000000bEEF",
      requestedAmount: "100"
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  // ---- Tamper-and-resign tests ------------------------------------------------
  // Each test below mutates a field that's inside the EIP-712 signed message AND
  // re-signs the credential with the client key so the signature is valid for the
  // tampered data. This isolates whether the *server's per-field check* catches
  // the manipulation — without re-signing, every one of these would short-circuit
  // at signature validation and never exercise the server's independent checks.

  it("Re-sign sanity: untouched credential re-signed by client still succeeds", async () => {
    // makes sure that resigning works
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data['data']).toEqual(NO_SPLIT_DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
  })

  it("Fails with tampered permitted token (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.permit.permitted[0]!.token = "0x000000000000000000000000000000000000bEEF";
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered primary amount (re-signed, consistent with transferDetails)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Halve both permitted.amount and transferDetails.requestedAmount so the credential
    // is internally consistent; the server must catch the mismatch against request.amount.
    const halved = (BigInt(jsonCredential.payload.permit.permitted[0]!.amount) / 2n).toString();
    jsonCredential.payload.permit.permitted[0]!.amount = halved;
    jsonCredential.payload.transferDetails[0]!.requestedAmount = halved;
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with expired deadline (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.permit.deadline = "1";
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered witness challengeHash (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.witness.challengeHash = "0x" + "ab".repeat(32);
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with witness challengeHash from a different challenge (re-signed)", async () => {
    const donor = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.witness.challengeHash = donor.payload.witness.challengeHash;
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with reordered splits (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, THREE_SPLIT_FETCH_ENDPOINT);
    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[1], permitted[3]] = [permitted[3]!, permitted[1]!];
    [tDetails[1], tDetails[3]] = [tDetails[3]!, tDetails[1]!];
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, THREE_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails when primary recipient is moved out of the front (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[0], permitted[1]] = [permitted[1]!, permitted[0]!];
    [tDetails[0], tDetails[1]] = [tDetails[1]!, tDetails[0]!];
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with inflated total — splits sums match the new total (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    const DELTA_PRIMARY = 100n;
    const DELTA_SPLIT = 50n;

    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;

    const newPrimary = (BigInt(permitted[0]!.amount) + DELTA_PRIMARY).toString();
    permitted[0]!.amount = newPrimary;
    tDetails[0]!.requestedAmount = newPrimary;

    const newSplit = (BigInt(permitted[1]!.amount) + DELTA_SPLIT).toString();
    permitted[1]!.amount = newSplit;
    tDetails[1]!.requestedAmount = newSplit;

    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with reordered equal-amount splits (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, EQUAL_SPLITS_FETCH_ENDPOINT);
    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[1], permitted[2]] = [permitted[2]!, permitted[1]!];
    [tDetails[1], tDetails[2]] = [tDetails[2]!, tDetails[1]!];
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, EQUAL_SPLITS_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with dropped split (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, THREE_SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.permit.permitted.pop();
    jsonCredential.payload.transferDetails.pop();
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, THREE_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with phantom extra split appended (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.permit.permitted.push({
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      amount: "100"
    });
    jsonCredential.payload.transferDetails.push({
      to: "0x000000000000000000000000000000000000bEEF",
      requestedAmount: "100"
    });
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered split token (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    // Server iterates splits and checks p.token === request.currency for each.
    jsonCredential.payload.permit.permitted[1]!.token = "0x000000000000000000000000000000000000bEEF";
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered challenge.id", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
   
    (jsonCredential.challenge as { id: string }).id = "tampered-challenge-id";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
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

  // ---- Tamper-and-resign tests ------------------------------------------------
  // Each test below mutates a field that's inside the EIP-712 signed message AND
  // re-signs the credential with the client key so the signature is valid for the
  // tampered data. For most authorization fields the server's per-field check fires
  // BEFORE signature recovery, so the non-resigned tests already exercise those
  // checks — but the resigned variants lock in that the server's checks survive
  // even when an attacker controls a key that can produce a valid signature.

  it("Re-sign sanity: untouched credential re-signed by client still succeeds", async () => {
    // Floor for the rest of the resigned suite: confirms the helper produces a
    // signature the server will accept on untouched data.
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data['data']).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
  })

  it("Fails with tampered recipient (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    jsonCredential.payload.to = "0x000000000000000000000000000000000000bEEF";
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered amount (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);

    jsonCredential.payload.value = (BigInt(jsonCredential.payload.value) / 2n).toString();
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered nonce (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);

    jsonCredential.payload.nonce = "0x" + "ab".repeat(32);
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with expired validBefore (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    jsonCredential.payload.validBefore = "1";
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  // TODO: ValidAfter is never checked by the server, meaning its only defense is eth_call
  // and the signature, but can be avoided if the signer signed the tampered credential
  it("Fails with tampered validAfter far in the future (re-signed)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(clientMppx, FETCH_ENDPOINT);
    // validAfter has no server-side independent check (only the on-chain ERC-3009 contract
    // enforces block.timestamp > validAfter). Push it an hour into the future so the
    // simulated transferWithAuthorization reverts at eth_call time.
    jsonCredential.payload.validAfter = (BigInt(Math.floor(Date.now() / 1000)) + 3600n).toString();
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })
})
