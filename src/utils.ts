import type { Client, Chain, Address, Hex } from "viem";
import * as defaults from "./default.js";
import { createClient, http } from "viem";

export function resolveClients(
  rpcUrls: Map<number, string> | undefined
): Map<number, Client> {
  const clientsMap = new Map<number, Client>();
  if (rpcUrls === undefined) {
    const arbSepoliaClient = createClient({
      chain: { id: defaults.chainId.arbitrumSepolia } as Chain,
      transport: http(defaults.rpcUrl[defaults.chainId.arbitrumSepolia])
    });
    clientsMap.set(arbSepoliaClient.chain.id, arbSepoliaClient);

    const arbOneClient = createClient({
      chain: { id: defaults.chainId.arbitrumOne } as Chain,
      transport: http(defaults.rpcUrl[defaults.chainId.arbitrumOne])
    });
    clientsMap.set(arbOneClient.chain.id, arbOneClient);
  }
  else {
    for (const [id, url] of rpcUrls) {
      const newClient = createClient({ chain: { id } as Chain, transport: http(url) });
      clientsMap.set(id, newClient);
    }
  }
  return clientsMap;
}

export function buildPermit2TypedData(params: {
  chainId: number;
  permitted: defaults.Permit2Payload["permit"]["permitted"];
  recipient: Address;
  nonce: bigint;
  deadline: bigint;
  Witness: defaults.Permit2Payload["witness"];
  isBatchPermit: boolean;
}) {
  const { chainId, permitted, recipient, nonce, deadline, Witness, isBatchPermit } = params

  const permittedMessage = isBatchPermit ?
    permitted.map(p => ({ token: p.token as Address, amount: BigInt(p.amount) })) :
    { token: permitted[0]!.token as Address, amount: BigInt(permitted[0]!.amount) }

  // Theres a single and batch version for PermitWitnessTransferFrom
  const typedData = {
    domain: {
      name: "Permit2",
      chainId: Number(chainId),
      verifyingContract: defaults.PERMIT2_ADDRESS,
    },
    types: {
      [isBatchPermit ? "PermitBatchWitnessTransferFrom" : "PermitWitnessTransferFrom"]: [
        { name: "permitted", type: isBatchPermit ? "TokenPermissions[]" : "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "PaymentWitness" },
      ],
      TokenPermissions: defaults.tokenPermissionsType,
      PaymentWitness: defaults.PaymentWitness,
    },
    primaryType: isBatchPermit ? "PermitBatchWitnessTransferFrom" : "PermitWitnessTransferFrom",
    message: {
      permitted: permittedMessage,
      spender: recipient as Address,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      witness: Witness,
    }
  };

  return typedData;
}