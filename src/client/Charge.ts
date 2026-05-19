import { Method, Credential, z } from "mppx"
import * as Methods from "../Methods.js"
import { createClient, keccak256,  http } from "viem"
import type { Client, Account, Address, Chain } from "viem"
import { signTypedData } from "viem/actions"
import * as defaults from "../default.js"
import { encodePacked } from "viem"


export function charge(parameters: charge.Parameters) {
  const resolveClient = async (
    chainId: number
  ): Promise<Client> => {
    const id = chainId;
    const url = defaults.rpcUrl[chainId];
    if (!url) throw new Error(`chainId: ${chainId} is unsupported`)
    return createClient({ chain: { id } as Chain, transport: http(url) })
  }

  return Method.toClient(Methods.arbitrumCharge, {
    context: z.object({
      account: z.custom<Account>(),
    }),

    // Figure out exactly what context is useful for, otherwise idk?
    async createCredential({ challenge, context }) {
      const { request } = challenge

      const amount = BigInt(request.amount);
      const currency = request.currency as Address;
      const recipient = request.recipient as Address;

      const chainId = request.methodDetails.chainId
      const client = await resolveClient(chainId)
      const account = parameters.account

      if (!request.methodDetails.credentialTypes?.includes("authorization")) {
        throw new Error(`Server does not support authorization credential type`)
      }

      // Nonce is given hashed challenge info as a form of challenge binding
      const nonce = keccak256(encodePacked(
        defaults.CHALLENGE_HASH_ABI,
        [challenge.id, challenge.realm]
      ))

      //Ill keep this for now but if they set the expiry time in like a day or two
      //Then I could see someone abusing the system and purposefully not submitting a transaction
      // to act as if the server isnt working but then in a couple days they will submit it since the
      // expiry was set so far in the future.
      const validAfter = 0n;
      const validBefore = challenge.expires
        ? BigInt(Math.floor(new Date(challenge.expires).getTime() / 1000))
        : BigInt(Math.floor(Date.now() / 1000) + 600); // 10 minutes default 

      const tokenInfo = defaults.erc3009Tokens[currency.toLowerCase()]

      if (!tokenInfo) throw new Error(`EIP3009 Token contract: ${currency} not registered`)
      if (tokenInfo.chainId != chainId) {
        throw new Error(`Token: ${tokenInfo.name} 
        on incorrect network: ${tokenInfo.chainId} current network: ${chainId}`)
      };


      const signature = await signTypedData(client, {
        account,
        domain: {
          name: tokenInfo.name,
          version: tokenInfo.version,
          chainId: tokenInfo.chainId,
          verifyingContract: currency,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: account.address,
          to: recipient,
          value: amount,
          validAfter,
          validBefore,
          nonce,
        },
      });

      return Credential.serialize({
        challenge,
        payload: {
          type: "authorization" as const,
          from: account.address,
          to: recipient,
          value: amount.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce: nonce,
          signature: signature
        }
      })
    }
  })
}


export declare namespace charge {
  type Parameters = {
    account: Account
  }
}