import type { Client, Chain } from "viem";
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
  }
  else {
    for (let entry of rpcUrls) {
      const id = entry[0];
      const url = entry[1];
      const newClient = createClient({ chain: { id } as Chain, transport: http(url) });
      clientsMap.set(id, newClient);
    }
  }
  return clientsMap;
}