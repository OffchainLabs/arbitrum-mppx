import { Method, Credential } from "mppx"
import * as Methods from "../Methods.js"
import { keccak256, erc20Abi } from "viem"
import type { Account, Address } from "viem"
import { signTypedData, readContract } from "viem/actions"
import * as defaults from "../default.js"
import { encodePacked } from "viem"
import { resolveClients } from "../utils.js"


export type ChargeParameters = {
  account: Account
  chainId: number
  rpcUrls?: Map<number, string>
}

export function charge(parameters: ChargeParameters): Method.Client<typeof Methods.arbitrumCharge> {
  
  const { rpcUrls } = parameters;

  const clientsMap = resolveClients(rpcUrls)

  return Method.toClient(Methods.arbitrumCharge, {
    
    async createCredential({ challenge }) {
      const { request, expires } = challenge
      const { account } = parameters

      const amount = BigInt(request.amount);
      const currency = request.currency as Address;
      const recipient = request.recipient as Address;
      
      const { methodDetails } = request;
      
      const {
        chainId,
        credentialTypes,
        splits,
      } = methodDetails
      
      const client = clientsMap.get(chainId);

      if (chainId !== client?.chain?.id) {
        throw new Error("Client account chainID does not match challenge chainID")
      }

      if (expires !== undefined && new Date(expires).getTime() < Date.now()) {
        throw new Error(`Challenge has expired. Current Time: ${Date.now()}
        \n challenge expiry time: ${new Date(expires).getTime()}`);
      }

      const balance = await readContract(client, {
        address: currency as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      })

      if (balance < BigInt(amount)) {
        throw new Error(`Insufficient funds to submit credential. Funds: ${balance} 
                    Required funds: ${amount}`)
      }

      /**
       * if credentialTypes is undefined, it assumes transaction is being used. Maybe we should deviate from
       * the spec and require credentialTypes always since I see no reason in making it an assumption
       */
      if (credentialTypes?.includes("permit2")) {
        // TODO: implement permit2

      }
      else if (credentialTypes?.includes("authorization")) {
        if (splits !== undefined) {
          throw new Error("Splits are not allowed for credentialType: authorization")
        }

        // Nonce is given hashed challenge info as a form of challenge binding
        const nonce = keccak256(encodePacked(
          defaults.CHALLENGE_HASH_ABI,
          [challenge.id, challenge.realm]
        ))

        /**
         * We may want to deviate from the spec and always require a challenge expiry 
         * so validBefore can always be equal to it
         */
        const validAfter = 0n;
        const validBefore = expires
          ? BigInt(Math.floor(new Date(expires).getTime() / 1000))
          : BigInt(Math.floor(Date.now() / 1000) + 600); // 10 minutes default 

        const tokenInfo = defaults.erc3009Tokens[currency.toLowerCase()]

        if (!tokenInfo) throw new Error(`EIP3009 Token contract: ${currency} not registered`)
        if (tokenInfo.chainId != chainId) {
          throw new Error(`Token: ${tokenInfo.name} 
          on incorrect network: ${tokenInfo.chainId} current network: ${chainId}`)
        };

        /**
         * Probably a later thing but we should have the user/agent verify with the user that they want to
         * pay the amount being shown to X address for Y information or resource etc etc.
         */
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
      else if (credentialTypes?.includes("transaction")) {
        /**
         * Transaction and hash credential types have weaker challenge bindings so we
         * may not want to bother implementing them since it opens the door to fradulant payments
         */

      }
      else if (credentialTypes?.includes("hash")) {
        /**
         * Transaction and hash credential types have weaker challenge bindings so we
         * may not want to bother implementing them since it opens the door to fradulant payments
         */
      }

      // def a better way to word this error
      throw new Error(`Arbitrum MPP does not support any given credential type: ${credentialTypes}`)
    }
  })
}
