# arbitrum-mpp

A package for letting users make payments using MPP (Machine Payments Protocol) on Arbitrum.

# package structure

```bash
arbitrum-mpp/
├── src/
│   ├── index.ts              # Re-export shared schemas
│   ├── Methods.ts            # Shared Method.from() definitions
│   ├── default.ts            # Default shared values
│   ├── client/
│   │   ├── index.ts          # ./client entry point
│   │   └── Charge.ts         # Client charge implementation
│   └── server/
│       ├── index.ts          # ./server entry point
│       └── Charge.ts         # Server charge implementation
└── test/
│   ├── client.ts             # example client implementation
│   └── server.ts             # example server implementation
├── package.json
└── tsconfig.json

```

`client/Charge.ts` is responsible for taking a servers `Challenge` and creating a `Credential` which contains a signature and information about how the client wants to pay, what they want to pay for, etc

`server/Charge.ts` is responsible for both defining the `Challenge` along with taking in a clients `Credential` and checking its validity. If valid, the server will submit the transaction and verify the payment went through.

Useful documentation references:

- [Protocol-overview](https://mpp.dev/protocol)
- [Custom-First-party-SDK](https://mpp.dev/payment-methods/custom#first-party-sdk)
- [Method.from](https://mpp.dev/sdk/typescript/Method.from)
- [Method.toServer](https://mpp.dev/sdk/typescript/core/Method.toServer)
- [Method.toClient](https://mpp.dev/sdk/typescript/core/Method.toClient)
- [Unified-EVM-Spec](https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/evm/draft-evm-charge-00.md#authorization-verification-authorization-verification)

# Running the test

To try it out locally, start the server in one terminal:

```bash
npm run server
```

Then, in a separate terminal, run the client:

```bash
npm run client
```

Make sure the server has eth and the client has a compatible ERC-20 (Currently only USDC)
