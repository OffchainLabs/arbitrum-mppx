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
      payload: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("authorization"),
          from: z.string(),
          to: z.string(),
          value: z.string(),
          validAfter: z.string(),
          validBefore: z.string(),
          nonce: z.string(),
          signature: z.string(),
        }),
        z.object({
          type: z.literal("permit2"),
          permit: z.object({
            permitted: z.array(z.object({ token: z.string(), amount: z.string() })),
            nonce: z.string(),
            deadline: z.string()
          }),
          transderDetails: z.array(z.object({ to: z.string(), requestedAmount: z.string() })),
          witness: z.object({ challengeHash: z.bigint() }),
          signature: z.string()
        }),
        z.object({
          // TODO: implement the hash payload
          type: z.literal("hash"),
        }),
        z.object({
          // TODO: implement the transaction payload
          type: z.literal("transaction")
        })


      ])
    },
  },
})