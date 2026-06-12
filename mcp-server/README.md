# Arbitrum MPP — MCP Server

An MCP (Model Context Protocol) server that lets Claude pay [MPP](https://mpp.dev/protocol)
(Machine Payments Protocol) endpoints on your behalf using the
[`@arbitrum/mpp`](../) SDK. It exposes a single tool, `pay_endpoint`, which takes an
MPP endpoint URL, pays the challenge it returns, and hands the response back to Claude.

(I will probably make better endpoints that check how much its worth
what it gives you etc etc but this works for now)

## Prerequisites

- A funded wallet on **Arbitrum Sepolia**:
  - **USDC** on Arbitrum Sepolia — this is the token used to pay endpoints. Make sure
    you hold enough USDC for whatever you're buying.
- The private key for that wallet.

## Setup

### 1. Build the server

From this directory, install dependencies (if you haven't already) and build:

```bash
pnpm install
pnpm build
```

This compiles `src/index.ts` to `dist/index.js`. Note the absolute path to that file —
you'll need it next:

```bash
echo "$(pwd)/dist/index.js"
```

### 2. Register the server in Claude's MCP config

Add the server to your Claude MCP config file (`claude_desktop_config.json`).

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add an entry under `mcpServers` pointing at the built file from step 1 along with your PRIVATE_KEY:

```json
{
  "mcpServers": {
    "arbitrum-mpp": {
      "command": "node",
      "args": ["/absolute/path/to/arbitrum-mppx/mcp-server/dist/index.js"],
      "env": {
        "PRIVATE_KEY": "0xYOUR_PRIVATE_KEY"
      }
    }
  }
}
```

### 3. Restart Claude

Fully quit and reopen Claude so it picks up the new MCP server. Once it restarts you
should see the `pay_endpoint` tool available.

### 4. Run an MPP server

Spin up an MPP server that accepts payments on **Arbitrum Sepolia**. The repo includes
an example you can run from the project root:

```bash
pnpm server
```

Take note of the endpoint URL it hosts.
NOTE: you will need to provide a SERVER_PRIVATE_KEY if you do this, and it MUST be funded
with testnet eth (server private key is put into the env file in the root folder of this repo)

### 5. Ask Claude about Arbitrum MPP

I recommend first asking claude about the discoverable resources at the host you set the server 
up at (Probably localhost:3000), it will then tell you about the different options

You can then tell claude which one you want to pay, or all of them, doesn't matter

## Notes

- **Hold USDC on the right chain.** The payment is made in USDC on Arbitrum Sepolia.
  If the wallet doesn't have enough USDC on that chain, the payment will fail.
- **Permit2 allowance.** If the endpoint accepts payment via **Permit2**, you must first
  increase the wallet's allowance on the Permit2 contract
  (`0x000000000022d473030f116ddee9f6b43ac78ba3`) for USDC. Without an allowance the
  Permit2 payment can't be pulled and the purchase will fail.
- The server talks to Claude over stdio and logs to stderr, so you won't see its output
  in the Claude chat — check Claude's MCP logs if something isn't working.
- You can edit the endpoints and the information/payment amount/recipient etc in `test/client.ts`
