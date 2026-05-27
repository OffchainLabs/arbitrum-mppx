import {
  keccak256,
  encodeAbiParameters,
  toHex,
  pad,
  parseEther
} from "viem";
import type { Address, Hash, TestClient, Hex, Account } from "viem";
import { setStorageAt, setBalance } from "viem/actions";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx as MppxClient } from "mppx/client";
import { charge as chargeServer } from "../../src/server/index.js"
import { Mppx as MppxExpress} from "mppx/express"
import * as defaults from '../../src/default.js';
import { buildPermit2TypedData } from '../../src/utils.js';
import {
  USDC_BALANCES_SLOT,
  USDC_ALLOWED_SLOT,
} from "./default.e2e.js"

// Funds accounts with eth since using the default accounts have the potential to be contract
// EOA's or whatever they are called
export function fundAccounts(accounts: Account[], client: TestClient) {
  for (const account of accounts) {
    setBalance(client, {
      address: account.address,
      value: parseEther('10000')
    })
  }
}

export async function mppServerSetup(params: {
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

export async function seedUsdc(
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

export async function seedUsdcAllowance(
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

export async function decodeResponse(response: Response) {
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

// this just makes it so the process of rawFetch and getting the proper credential is much easier
// createCredential still exists and is not just a part of this function incase we need it
export async function rawFetchAndMakeDecodedCredential<T>(clientMppx: MppxClient.Mppx, fetchEndpoint: string):
  Promise<{ challenge: unknown, payload: T, source?: string }> {
  const response = await clientMppx.rawFetch(fetchEndpoint);
  const encodedCredential = await clientMppx.createCredential(response);
  return encodedCredentialToJson(encodedCredential);
}

export async function encodeAndSendCredential(clientMppx: MppxClient.Mppx, jsonCredential: any, fetchEndpoint: string) {
  const reEncodedCredential = jsonToEncodedCredential(jsonCredential);
  const init = clientMppx.transport.setCredential({}, reEncodedCredential);
  return await clientMppx.rawFetch(fetchEndpoint, init);
}

// Both functions below are for manually editing the credential to make sure the server is
// properly ignoring credentials that are fraudulent
export function encodedCredentialToJson(encodedCredential: string) {
  // the string "Payment " is at the beginning of the encoded credential and is not part of the 
  // encoding, so it needs to be removed so the encoding works properly
  const SLICE_INDEX = "Payment ".length
  const strippedCredential = encodedCredential.slice(SLICE_INDEX);
  return JSON.parse(Buffer.from(strippedCredential, 'base64').toString('utf-8'));
}

export function jsonToEncodedCredential(jsonCredential: any) {
  const reEncodedCredential = Buffer.from(JSON.stringify(jsonCredential)).toString('base64');
  // The string "Payment " is at the beginning of the encoded credential
  // so it needs to be re added
  return `Payment ${reEncodedCredential}`;
}

// both resigning functions are meant for signing tampered data, so we can test the server
// for checking both the individual values of the payload AND the signature validity.
export async function resignAuthorizationCredential(
  jsonCredential: any,
  params: {
    currency: Address, signer: Account, domain?: {
      name?: string,
      version?: string,
      chainId?: number,
      verifyingContract?: Address
    }
  }
) {
  const { currency, signer, domain } = params;
  const tokenInfo = defaults.erc3009Tokens[currency.toLowerCase()];
  if (!tokenInfo) throw new Error(`No ERC-3009 token info for ${currency}`);

  const typedData = {
    domain: {
      name: domain?.name ?? tokenInfo.name,
      version: domain?.version ?? tokenInfo.version,
      chainId: domain?.chainId ?? tokenInfo.chainId,
      verifyingContract: domain?.verifyingContract ?? currency,
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

export async function resignPermit2Credential(
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
