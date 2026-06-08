import type { Address } from 'viem';

export const chainId = {
  arbitrumOne: 42161,
  arbitrumSepolia: 421614,
} as const;

export type ChainId = (typeof chainId)[keyof typeof chainId];

export const USDCdecimals = 6;

export const TOKEN_CONTRACTS = {
  USDC_ARBITRUM_ONE: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase() as Address,
  USDC_ARBITRUM_SEPOLIA: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'.toLowerCase() as Address,
} as const;

export const rpcUrl: Record<number, string> = {
  [chainId.arbitrumOne]: 'https://arb1.arbitrum.io/rpc',
  [chainId.arbitrumSepolia]: 'https://sepolia-rollup.arbitrum.io/rpc',
};

export const erc3009Abi = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'receiveWithAuthorization',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'name',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'version',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const;

export const erc3009Tokens: Record<string, { name: string; version: string; chainId: ChainId }> = {
  [TOKEN_CONTRACTS.USDC_ARBITRUM_ONE]: {
    name: 'USD Coin',
    version: '2',
    chainId: chainId.arbitrumOne,
  },
  [TOKEN_CONTRACTS.USDC_ARBITRUM_SEPOLIA]: {
    name: 'USD Coin',
    version: '2',
    chainId: chainId.arbitrumSepolia,
  },
};

export const PERMIT2_ADDRESS =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3'.toLowerCase() as Address;

export const tokenPermissionsType = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;

export const PaymentWitness = [{ name: 'challengeHash', type: 'bytes32' }] as const;

export const PERMIT2_WITNESS_TYPE_STRING =
  'PaymentWitness witness)PaymentWitness(bytes32 challengeHash)TokenPermissions(address token,uint256 amount)';

export const PERMIT2_SINGLE_ABI = [
  {
    type: 'function',
    name: 'permitWitnessTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        name: 'transferDetails',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'requestedAmount', type: 'uint256' },
        ],
      },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export const PERMIT2_BATCH_ABI = [
  {
    type: 'function',
    name: 'permitWitnessTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        name: 'transferDetails',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'requestedAmount', type: 'uint256' },
        ],
      },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export type Permit2Payload = {
  type: string;
  permit: {
    permitted: { token: string; amount: string }[];
    nonce: string;
    deadline: string;
  };
  transferDetails: { to: string; requestedAmount: string }[];
  witness: { challengeHash: string };
  signature: string;
};

export type AuthorizationPayload = {
  type: string;
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
};
