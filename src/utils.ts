import type { Address, Chain, Client, Hex } from 'viem';
import { createClient, encodePacked, http, keccak256 } from 'viem';

import * as defaults from './default.js';

export function resolveClients(rpcUrls: Map<number, string> | undefined): Map<number, Client> {
  const clientsMap = new Map<number, Client>();
  if (rpcUrls === undefined) {
    const arbSepoliaClient = createClient({
      chain: { id: defaults.chainId.arbitrumSepolia } as Chain,
      transport: http(defaults.rpcUrl[defaults.chainId.arbitrumSepolia]),
    });
    clientsMap.set(arbSepoliaClient.chain.id, arbSepoliaClient);

    const arbOneClient = createClient({
      chain: { id: defaults.chainId.arbitrumOne } as Chain,
      transport: http(defaults.rpcUrl[defaults.chainId.arbitrumOne]),
    });
    clientsMap.set(arbOneClient.chain.id, arbOneClient);
  } else {
    for (const [id, url] of rpcUrls) {
      if (!defaults.isSupportedChainId(id)) {
        throw new Error(
          `Unsupported chainId: ${id}. Only Arbitrum One (${defaults.chainId.arbitrumOne}) and Arbitrum Sepolia (${defaults.chainId.arbitrumSepolia}) are supported`,
        );
      }
      const newClient = createClient({ chain: { id } as Chain, transport: http(url) });
      clientsMap.set(id, newClient);
    }
  }
  return clientsMap;
}

export function buildPermit2TypedData(params: {
  chainId: number;
  permitted: defaults.Permit2Payload['permit']['permitted'];
  recipient: Address;
  nonce: bigint;
  deadline: bigint;
  Witness: defaults.Permit2Payload['witness'];
}) {
  const { chainId, permitted, recipient, nonce, deadline, Witness } = params;

  // if there is more than 1 entry in permitted then we need to call the
  // batch version of permitWitnessTransferFrom which is the same function name but takes arrays
  const isBatchPermit = permitted.length > 1;

  const permittedMessage = isBatchPermit
    ? permitted.map((p) => ({ token: p.token as Address, amount: BigInt(p.amount) }))
    : { token: permitted[0]!.token as Address, amount: BigInt(permitted[0]!.amount) };

  // Theres a single and batch version for PermitWitnessTransferFrom
  const typedData = {
    domain: {
      name: 'Permit2',
      chainId: Number(chainId),
      verifyingContract: defaults.PERMIT2_ADDRESS,
    },
    types: {
      [isBatchPermit ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom']: [
        { name: 'permitted', type: isBatchPermit ? 'TokenPermissions[]' : 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'PaymentWitness' },
      ],
      TokenPermissions: defaults.tokenPermissionsType,
      PaymentWitness: defaults.PaymentWitness,
    },
    primaryType: isBatchPermit ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom',
    message: {
      permitted: permittedMessage,
      spender: recipient as Address,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      witness: Witness,
    },
  };

  return typedData;
}

export function createChallengeHash(params: {
  id: string;
  realm: string;
  transferDetails?: Array<{ to: string; requestedAmount: string }>;
}): Hex {
  const { id, realm, transferDetails } = params;
  if (transferDetails === undefined) {
    return keccak256(encodePacked(['string', 'string'], [id, realm]));
  }
  const tos = transferDetails.map((td) => td.to);
  const amounts = transferDetails.map((td) => BigInt(td.requestedAmount));
  return keccak256(
    encodePacked(['string', 'string', 'string[]', 'uint256[]'], [id, realm, tos, amounts]),
  );
}
