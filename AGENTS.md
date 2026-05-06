# arbitrum-mppx

## Goal

This repo is an Arbitrum-specific implementation of the [`mppx`](https://www.npmjs.com/package/mppx) Method Payment Protocol. `mppx` defines a generic challenge/credential flow for payments between a server (the merchant / payee) and a client (the payer); this package provides the concrete `arbitrum` method that settles those payments on Arbitrum One / Arbitrum Sepolia using ERC-20 stablecoins (currently USDC) via the [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization` flow.

The end result: a merchant can request payment, the user signs an EIP-712 authorization off-chain (no gas, no prior approval), and the merchant's server submits the signed authorization on-chain to pull the funds. The user never broadcasts a transaction themselves.

## Layout

- [src/Methods.ts](src/Methods.ts) — defines `arbitrumCharge`, the shared `Method` schema (zod) describing the request shape and the `authorization` credential payload. Both client and server import this so their wire formats stay aligned.
- [src/default.ts](src/default.ts) — chain IDs, RPC URLs, supported EIP-3009 token registry (USDC on Arbitrum One + Sepolia), and the `transferWithAuthorization` ABI fragment.
- [src/server/Charge.ts](src/server/Charge.ts) — server-side handler.
- [src/client/Charge.ts](src/client/Charge.ts) — client-side credential producer.
- `src/server/index.ts` / `src/client/index.ts` — thin wrappers exposing `arbitrum(parameters)` returning the configured method array `mppx` expects.
- `test/server`, `test/client` — client and server sided examples that execute a transaction when ran together, started via `npm run server` / `npm run client`.

## What the two `Charge.ts` files do

The protocol splits a payment into two halves. The client produces a signed credential proving it authorizes the transfer; the server verifies that credential and submits the on-chain transaction. They mirror each other, both keyed off the `arbitrumCharge` method definition.

### Client — [src/client/Charge.ts](src/client/Charge.ts)

`charge(parameters)` returns a `Method.toClient(arbitrumCharge, ...)` handler whose job is to turn a server-issued `challenge` into a signed `Credential`. Inside `createCredential`:

1. Reads the merchant's `request` from the challenge (`amount`, `currency`, `recipient`, `methodDetails.chainId`).
2. Confirms the server advertised support for the `"authorization"` credential type — bails otherwise.
3. Binds the signature to this specific challenge by computing `nonce = keccak256(encodePacked(["string","string"], [challenge.id, challenge.realm]))`. This prevents the signature from being replayed against a different challenge or realm.
4. Computes `validAfter = 0` and `validBefore` from `challenge.expires` (defaulting to `now + 10 minutes`). Note the inline comment flagging that a server-supplied far-future expiry would let a malicious client withhold submission and replay later — the expiry is trusted from the challenge today.
5. Looks up the token's EIP-712 domain (`name`, `version`, `chainId`) in `defaults.erc3009Tokens` and refuses if the token isn't registered or its chain doesn't match the requested chain.
6. Calls `signTypedData` with the `TransferWithAuthorization` typed-data struct from EIP-3009. The signing account comes from `parameters.account`.
7. Returns `Credential.serialize({ challenge, payload })` containing `{ type: "authorization", from, to, value, validAfter, validBefore, nonce, signature }`. No transaction is broadcast on the client.

### Server — [src/server/Charge.ts](src/server/Charge.ts)

`charge(parameters)` returns a `Method.toServer(arbitrumCharge, ...)` handler. The merchant's `account`, `amount`, `currency`, `recipient`, and `methodDetails` flow in as defaults. Inside `verify({ credential, request })`:

1. Resolves a viem `Client` for the requested chain via `defaults.rpcUrl`; throws if the chain is unsupported.
2. Re-checks every field the client claimed against the merchant's actual request:
   - `payload.to === request.recipient`
   - `payload.type === "authorization"`
   - `payload.validBefore` is still in the future
   - `payload.value === request.amount`
   - `payload.nonce === keccak256(encodePacked(...,[challenge.id, challenge.realm]))` — same challenge-binding the client computed.
3. Confirms the token is in the EIP-3009 registry, then calls `verifyTypedData` with the same EIP-712 domain/struct the client signed. Rejects on signature mismatch.
4. Splits the signature with `parseSignature` into `(v, r, s)` and submits `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` to the token contract from the merchant's `serverAccount` via `sendTransaction`. The merchant pays the gas; the user's tokens are pulled atomically.
5. `waitForTransactionReceipt`, then `toReceipt(receipt)` converts the on-chain receipt to the `mppx` `Receipt` shape (`{ method: "arbitrum", status: "success", timestamp, reference: txHash }`). A non-`"success"` status throws.

Open TODOs noted in the file: pre-flight balance check on the sender, `eth_call` simulation before broadcasting to avoid wasting gas, and verification of the emitted `Transfer` event log against the expected amounts.

## Flow at a glance

```
client                                     server
  │                                          │
  │  ── request charge ──────────────────▶  │
  │                                          │ issues challenge (id, realm, expires, request)
  │  ◀── challenge ─────────────────────── │
  │                                          │
  │ sign EIP-712 TransferWithAuthorization   │
  │ nonce = keccak256(id, realm)             │
  │  ── credential (signed payload) ─────▶  │
  │                                          │ verify fields + signature
  │                                          │ submit transferWithAuthorization on-chain
  │                                          │ wait for receipt
  │  ◀── Receipt { txHash } ─────────────── │
```

## Run

```
npm run server   # tsx test/server
npm run client   # tsx test/client
```

Requires the env vars referenced in `.env.example` (RPC keys / merchant + payer private keys for the test harness).