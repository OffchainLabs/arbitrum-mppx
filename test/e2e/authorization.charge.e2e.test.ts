import express from 'express';
import { Mppx as MppxClient } from 'mppx/client';
import { Server } from 'node:http';
import { getAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { charge as chargeClient } from '../../src/client/index.js';
import * as defaults from '../../src/default.js';
import { ANVIL_CHAIN_ID, ANVIL_HOST, ANVIL_RPC_URL, ANVIL_TEST_ACCOUNTS } from './anvil.js';
import {
  USDC_DEFAULT_SEEDED,
  anvilPublicClient,
  anvilTestClient,
  clientAccount,
  serverAccount,
} from './default.e2e.js';
import {
  decodeResponse,
  encodeAndSendCredential,
  fundAccounts,
  mppServerSetup,
  rawFetchAndMakeDecodedCredential,
  resignAuthorizationCredential,
  seedUsdc,
} from './utils.e2e.js';

const rpcMapping = new Map<number, string>();

rpcMapping.set(ANVIL_CHAIN_ID, ANVIL_RPC_URL);

describe('e2e: Authorization', async () => {
  const app = express();
  const PORT = 3001;
  const ENDPOINT = 'authE2eTest';
  const DATA = 'authorization e2e test worked!';
  const FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${ENDPOINT}`;
  const CHECKSUMMED_ENDPOINT = 'authChecksummedTest';
  const CHECKSUMMED_FETCH_ENDPOINT = `http://${ANVIL_HOST}:${PORT}/${CHECKSUMMED_ENDPOINT}`;
  const CHECKSUMMED_USDC = getAddress(defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA);
  let server: Server;

  const serverMppx = await mppServerSetup({
    recipient: serverAccount.address,
    currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
    chainId: anvilPublicClient.chain.id,
    rpcUrls: rpcMapping,
    privateKey: ANVIL_TEST_ACCOUNTS.server.privateKey,
  });
  app.get(
    `/${ENDPOINT}`,
    serverMppx.charge({
      amount: '1000',
      description: 'authe2eTest description',
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        credentialTypes: ['authorization'],
      },
    }),
    (req, res) => res.json({ data: DATA }),
  );

  // Same flow as the endpoint above, but the route-level currency override is checksummed
  // instead of lowercased. Regression guard: the server used to look up erc3009Tokens with the
  // currency exactly as configured while the registry keys are lowercased, so this configuration
  // made the client sign fine but the server reject with "Token contract is not verified to
  // have EIP3009"
  app.get(
    `/${CHECKSUMMED_ENDPOINT}`,
    serverMppx.charge({
      amount: '1000',
      currency: CHECKSUMMED_USDC,
      description: 'checksummed currency test',
      methodDetails: {
        chainId: ANVIL_CHAIN_ID,
        credentialTypes: ['authorization'],
      },
    }),
    (req, res) => res.json({ data: DATA }),
  );

  const clientMppx = MppxClient.create({
    methods: [
      chargeClient({
        account: clientAccount,
        chainId: 421614,
        rpcUrls: rpcMapping,
      }),
    ],
    polyfill: false,
  });

  beforeEach(async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: USDC_DEFAULT_SEEDED,
    });
  });

  beforeAll(() => {
    server = app.listen(PORT);
    fundAccounts([clientAccount, serverAccount], anvilTestClient);
  });

  afterAll(() => {
    server.close();
  });

  it('Succeeds and gets data', async () => {
    const returnVal = await clientMppx.fetch(FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data['data']).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  });

  it('Succeeds when the configured currency is checksummed instead of lowercased', async () => {
    // guard: if this ever holds, the test no longer exercises mixed casing
    expect(CHECKSUMMED_USDC).not.toEqual(defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA);

    const returnVal = await clientMppx.fetch(CHECKSUMMED_FETCH_ENDPOINT);
    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);
    expect(data['data']).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  });

  it('decode and encode makes successful payment', async () => {
    // sanity check for decode and encode making successful payment
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);

    const { data, decodedPaymentReceipt } = await decodeResponse(returnVal);

    expect(data['data']).toEqual(DATA);
    expect(decodedPaymentReceipt['status']).toEqual('success');
    expect(decodedPaymentReceipt['method']).toEqual('arbitrum');
  });

  it('Fails with tampered signature', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );
    // invalidate sig (must be same length or else a different check fails before signature validation)
    jsonCredential.payload.signature =
      '0x7c3a9f8e4b2d1e6f5a8c9b0d3e7f2a4c6b8d1e3f5a7c9b2d4e6f8a0c2b4d6e8f1a3c5e7f9b1d3e5f7a9c1b3d5e7f9a2c4b6d8e0f3a5c7b9d1e3f5a7c9b2d4e6f1b';
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with tampered amount', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );

    jsonCredential.payload.value = (BigInt(jsonCredential.payload.value) / 2n).toString();
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with tampered recipient', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );
    jsonCredential.payload.to = '0x000000000000000000000000000000000000bEEF';
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with tampered nonce', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );

    jsonCredential.payload.nonce = '0x' + 'ab'.repeat(32);
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with expired validBefore', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );
    jsonCredential.payload.validBefore = '1';
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with signature on wrong chain', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
      domain: { chainId: 1 },
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with signature on wrong domain', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );

    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
      domain: { name: 'USD', version: '1' },
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with tampered validAfter far in the future', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );
    jsonCredential.payload.validAfter = (BigInt(Math.floor(Date.now() / 1000)) + 3600n).toString();
    await resignAuthorizationCredential(jsonCredential, {
      currency: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      signer: clientAccount,
    });
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with unknown payload type', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );
    jsonCredential.payload.type = 'not-a-real-type';
    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });

  it('Fails with insufficient funds', async () => {
    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: 0n,
    });
    await expect(clientMppx.fetch(FETCH_ENDPOINT)).rejects.toThrow('Insufficient funds');
  });

  it('Fails with insufficient funds after client signs with sufficient funds', async () => {
    const jsonCredential = await rawFetchAndMakeDecodedCredential<defaults.AuthorizationPayload>(
      clientMppx,
      FETCH_ENDPOINT,
    );

    await seedUsdc(anvilTestClient, {
      token: defaults.TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA,
      holder: clientAccount.address,
      amount: BigInt(jsonCredential.payload.value) - 1n,
    });

    const returnVal = await encodeAndSendCredential(clientMppx, jsonCredential, FETCH_ENDPOINT);
    expect(returnVal.status).toBe(402);
    expect(returnVal.headers.get('payment-receipt')).toBeNull();
  });
});
