import { Method, z } from 'mppx'

export const arbitrumCharge = Method.from({
  name: 'arbitrum',
  intent: 'charge',
  schema: {
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.object({
        chainId: z.number(),
        permit2Address: z.string(),
        credentialTypes: z.optional(z.array(z.string())),
        decimals: z.optional(z.number()),
        splits: z.optional(z.array(z.object({
          recipient: z.string(),
          amount: z.string(),
          memo: z.optional(z.string())
        })))
      })

    }),
    credential: {
      payload: z.object({
        type: z.union([
          z.string("authorization"),
          z.string("permit2"),
          z.string("transaction"),
          z.string("hash")
        ]),
        from: z.string(),
        to: z.string(),
        value: z.string(),
        validAfter: z.string(),
        validBefore: z.string(),
        nonce: z.string(),
        signature: z.string(),
      }),
    },
  },
})