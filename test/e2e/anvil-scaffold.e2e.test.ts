import { describe, it, expect, beforeAll } from "vitest";
import { createWalletClient, parseEther } from "viem";
import { fundAccounts } from "./utils.e2e.js"
import { ANVIL_CHAIN_ID } from "./anvil.js"
import { 
  anvilChain,
  transport,
  clientAccount, 
  serverAccount, 
  anvilPublicClient, 
  anvilTestClient
} from "./default.e2e.js"

// just makes sure anvil is working with some basic tests
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
