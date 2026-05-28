import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ANVIL_RPC_URL, ANVIL_CHAIN_ID, ANVIL_TEST_ACCOUNTS, ANVIL_HOST } from "./anvil.js";
import { Mppx as MppxClient } from "mppx/client";
import { charge as chargeClient } from '../../src/client/index.js';
import * as defaults from '../../src/default.js';
import express from 'express'
import { Server } from "node:http";
import { createChallengeHash } from '../../src/utils.js';
import {
  fundAccounts,
  mppServerSetup,
  seedUsdc,
  seedUsdcAllowance,
  decodeResponse,
  rawFetchAndMakeDecodedCredential,
  encodeAndSendCredential,
  resignPermit2Credential,
  encodedCredentialToJson
} from "./utils.e2e.js"
import {
  clientAccount,
  serverAccount,
  anvilPublicClient,
  anvilTestClient,
  USDC_DEFAULT_SEEDED,
} from "./default.e2e.js"

const rpcMapping = new Map<number, string>();

rpcMapping.set(ANVIL_CHAIN_ID, ANVIL_RPC_URL);

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

  it("Fails with tampered signature", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // invalidate sig (must be same length or else a different check fails before signature validation)
    jsonCredential.payload.signature = "0x7c3a9f8e4b2d1e6f5a8c9b0d3e7f2a4c6b8d1e3f5a7c9b2d4e6f8a0c2b4d6e8f1a3c5e7f9b1d3e5f7a9c1b3d5e7f9a2c4b6d8e0f3a5c7b9d1e3f5a7c9b2d4e6f1b";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered permitted token", async () => {
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

  it("Fails with tampered permitted amount", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.permit.permitted[0].amount) / BigInt(2);
    jsonCredential.payload.permit.permitted[0].amount = falseValue.toString();
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount
    })
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered transfer recipient", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Redirect funds to an attacker-controlled address
    jsonCredential.payload.transferDetails[0].to = "0x000000000000000000000000000000000000bEEF";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered transfer requestedAmount", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.transferDetails[0].requestedAmount) / BigInt(2);
    jsonCredential.payload.transferDetails[0].requestedAmount = falseValue.toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with expired deadline", async () => {
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

  it("Fails with tampered deadline", async () => {
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

  it("Fails with tampered witness challengeHash", async () => {
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

  it("Fails with tampered split recipient", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    jsonCredential.payload.transferDetails[1].to = "0x000000000000000000000000000000000000bEEF";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with tampered split amount", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, SPLIT_FETCH_ENDPOINT);
    const falseValue = BigInt(jsonCredential.payload.transferDetails[1].requestedAmount) / BigInt(2);
    jsonCredential.payload.transferDetails[1].requestedAmount = falseValue.toString();
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })

  it("Fails with dropped split", async () => {
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

  it("Fails with reordered splits", async () => {
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

  it("Fails when primary recipient is moved out of the front", async () => {
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

  it("Fails with tampered primary amount", async () => {
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

  it("Fails with inflated total — splits sums match the new total", async () => {
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

  it("Fails with tampered source (did:pkh)", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    // Server uses the source to verify the signature with, if its tampered then
    // Signature check should throw
    jsonCredential.source = `did:pkh:eip155:${ANVIL_CHAIN_ID}:${serverAccount.address}`;
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

  it("Fails with signature on wrong chain", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: 1,
      signer: clientAccount,
    });
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

  it("Fails with phantom extra split appended", async () => {
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

  it("Fails with tampered challenge.id", async () => {
    let jsonCredential = await
      rawFetchAndMakeDecodedCredential<defaults.Permit2Payload>(clientMppx, NO_SPLIT_FETCH_ENDPOINT);

    (jsonCredential.challenge as { id: string }).id = "tampered-challenge-id";
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, NO_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })
  it("Fails when TD is tampered, resgined, and witness hash is tampered with TD", async () => {
    // Need to fetch manually since we need the challenge realm and ID
    const response = await clientMppx.rawFetch(THREE_SPLIT_FETCH_ENDPOINT);
    const challenge = clientMppx.transport.getChallenge(response);
    const { id, realm } = challenge;
    const encodedCredential = await clientMppx.createCredential(response);

    let jsonCredential = encodedCredentialToJson(encodedCredential);

    const permitted = jsonCredential.payload.permit.permitted;
    const tDetails = jsonCredential.payload.transferDetails;
    [permitted[1], permitted[2]] = [permitted[2]!, permitted[1]!];
    [tDetails[1], tDetails[2]] = [tDetails[2]!, tDetails[1]!];

    jsonCredential.payload.witness.challengeHash = createChallengeHash({
      id,
      realm,
      transferDetails: tDetails
    })
    await resignPermit2Credential(jsonCredential, {
      recipient: serverAccount.address,
      chainId: ANVIL_CHAIN_ID,
      signer: clientAccount
    })
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, THREE_SPLIT_FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get("payment-receipt")).toBeNull();
  })
})

