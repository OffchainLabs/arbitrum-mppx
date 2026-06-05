import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import { resolveClients, buildPermit2TypedData } from "../src/utils.js";
import * as defaults from "../src/default.js";

const TOKEN_A = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831".toLowerCase() as Address;
const TOKEN_B = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d".toLowerCase() as Address;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as Address;
const CHALLENGE_HASH =
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex;

describe("resolveClients", () => {
  it("returns default arbitrum-one and arbitrum-sepolia clients when rpcUrls is undefined", () => {
    const clients = resolveClients(undefined);

    expect(clients.size).toBe(2);
    expect(clients.has(defaults.chainId.arbitrumOne)).toBe(true);
    expect(clients.has(defaults.chainId.arbitrumSepolia)).toBe(true);

    const arbOne = clients.get(defaults.chainId.arbitrumOne);
    expect(arbOne?.chain?.id).toBe(defaults.chainId.arbitrumOne);

    const arbSepolia = clients.get(defaults.chainId.arbitrumSepolia);
    expect(arbSepolia?.chain?.id).toBe(defaults.chainId.arbitrumSepolia);
  });

  it("creates a client for every entry in the provided map", () => {
    const rpcUrls = new Map<number, string>([
      [1, "https://eth.example/rpc"],
      [10, "https://opt.example/rpc"],
      [42161, "https://arb.example/rpc"],
    ]);

    const clients = resolveClients(rpcUrls);

    expect(clients.size).toBe(3);
    for (const id of rpcUrls.keys()) {
      expect(clients.get(id)?.chain?.id).toBe(id);
    }
  });

  it("returns an empty map when given an empty map (does not fall back to defaults)", () => {
    const clients = resolveClients(new Map());
    expect(clients.size).toBe(0);
  });
});

describe("buildPermit2TypedData", () => {
  const baseDomain = {
    name: "Permit2",
    chainId: defaults.chainId.arbitrumSepolia,
    verifyingContract: defaults.PERMIT2_ADDRESS,
  };

  it("builds a single-permit typed data when only one token is permitted", () => {
    const typedData = buildPermit2TypedData({
      chainId: defaults.chainId.arbitrumSepolia,
      permitted: [{ token: TOKEN_A, amount: "1000" }],
      recipient: RECIPIENT,
      nonce: 7n,
      deadline: 1234567890n,
      Witness: { challengeHash: CHALLENGE_HASH },
    });

    expect(typedData.domain).toEqual(baseDomain);
    expect(typedData.primaryType).toBe("PermitWitnessTransferFrom");
    expect(typedData.types).toHaveProperty("PermitWitnessTransferFrom");
    expect(typedData.types).not.toHaveProperty("PermitBatchWitnessTransferFrom");

    const permittedField = typedData.types.PermitWitnessTransferFrom![0];
    expect(permittedField).toEqual({ name: "permitted", type: "TokenPermissions" });

    expect(typedData.message.permitted).toEqual({
      token: TOKEN_A,
      amount: 1000n,
    });
    expect(typedData.message.spender).toBe(RECIPIENT);
    expect(typedData.message.nonce).toBe(7n);
    expect(typedData.message.deadline).toBe(1234567890n);
    expect(typedData.message.witness).toEqual({ challengeHash: CHALLENGE_HASH });
  });

  it("builds a batch-permit typed data when multiple tokens are permitted", () => {
    const typedData = buildPermit2TypedData({
      chainId: defaults.chainId.arbitrumOne,
      permitted: [
        { token: TOKEN_A, amount: "500" },
        { token: TOKEN_B, amount: "250" },
      ],
      recipient: RECIPIENT,
      nonce: 1n,
      deadline: 1n,
      Witness: { challengeHash: CHALLENGE_HASH },
    });

    expect(typedData.domain.chainId).toBe(defaults.chainId.arbitrumOne);
    expect(typedData.primaryType).toBe("PermitBatchWitnessTransferFrom");
    expect(typedData.types).toHaveProperty("PermitBatchWitnessTransferFrom");
    expect(typedData.types).not.toHaveProperty("PermitWitnessTransferFrom");

    const permittedField = typedData.types.PermitBatchWitnessTransferFrom![0];
    expect(permittedField).toEqual({ name: "permitted", type: "TokenPermissions[]" });

    expect(typedData.message.permitted).toEqual([
      { token: TOKEN_A, amount: 500n },
      { token: TOKEN_B, amount: 250n },
    ]);
  });

  it("coerces numeric string amounts/nonce/deadline into bigints", () => {
    const typedData = buildPermit2TypedData({
      chainId: 1,
      permitted: [{ token: TOKEN_A, amount: "42" }],
      recipient: RECIPIENT,
      nonce: BigInt("99999999999999999999"),
      deadline: BigInt("88888888888888888888"),
      Witness: { challengeHash: CHALLENGE_HASH },
    });

    expect(typedData.message.permitted).toEqual({ token: TOKEN_A, amount: 42n });
    expect(typedData.message.nonce).toBe(BigInt("99999999999999999999"));
    expect(typedData.message.deadline).toBe(BigInt("88888888888888888888"));
  });

  it("always uses the canonical PERMIT2 verifying contract address", () => {
    const typedData = buildPermit2TypedData({
      chainId: 1,
      permitted: [{ token: TOKEN_A, amount: "1" }],
      recipient: RECIPIENT,
      nonce: 0n,
      deadline: 0n,
      Witness: { challengeHash: CHALLENGE_HASH },
    });

    expect(typedData.domain.verifyingContract).toBe(defaults.PERMIT2_ADDRESS);
    expect(typedData.domain.name).toBe("Permit2");
  });

  it("includes the standard TokenPermissions and PaymentWitness type definitions", () => {
    const typedData = buildPermit2TypedData({
      chainId: 1,
      permitted: [{ token: TOKEN_A, amount: "1" }],
      recipient: RECIPIENT,
      nonce: 0n,
      deadline: 0n,
      Witness: { challengeHash: CHALLENGE_HASH },
    });

    expect(typedData.types.TokenPermissions).toEqual(defaults.tokenPermissionsType);
    expect(typedData.types.PaymentWitness).toEqual(defaults.PaymentWitness);
  });
});
