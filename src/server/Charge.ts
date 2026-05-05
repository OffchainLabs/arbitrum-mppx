import { Method, Receipt } from "mppx"
import * as Methods from "../Methods.js"
import * as defaults from "../default.js"
import {
	encodeFunctionData,
	Address,
	Hex,
	verifyTypedData,
	keccak256,
	encodePacked,
	parseSignature,
	Client,
	createClient,
	Chain,
	http,
	Account,
	TransactionReceipt
} from "viem";
import { sendTransaction, waitForTransactionReceipt } from "viem/actions"

export function charge(parameters: charge.Parameters) {
	const {
		amount,
		currency,
		recipient,
		description,
		externalId,
		methodDetails,
	} = parameters;

	const serverAccount = parameters.account;

	const resolveClient = async (
		chainId: number
	): Promise<Client> => {
		const id = chainId;
		const url = defaults.rpcUrl[chainId];
		if (!url) throw new Error(`chainId: ${chainId} is unsupported`)
		return createClient({ chain: { id } as Chain, transport: http(url) })
	}

	return Method.toServer(Methods.arbitrumCharge, {
		defaults: {
			currency,
			recipient,
			methodDetails
		} as never,

		async verify({ credential, request }) {
			const {
				challenge,
				payload,
				source
			} = credential;
			const { chainId } = request.methodDetails;

			/**
			 * Verification steps
			 */

			const client = await resolveClient(chainId);

			if (payload.to != request.recipient) throw new Error(`Client payload sending to incorrect address: 
				${payload.to} Should be ${request.recipient}`);

			if (payload.type != "authorization") throw new Error(`Client payload has incorrect type: 
				${payload.type} should be authorization`);

			if (BigInt(payload.validBefore) < Math.floor(Date.now() / 1000)) throw new Error(`Client payload timeframe is no longer valid.
				 Current time: ${Date.now() / 1000} validBefore timestamp: ${payload.validBefore}`);

			if (payload.value != request.amount) throw new Error(`Client payload value is incorrect. 
				payload value: ${payload.value} Should be ${request.amount}`);

			const hashedNonce = keccak256(encodePacked(
				defaults.CHALLENGE_HASH_ABI,
				[challenge.id, challenge.realm]
			))

			if (hashedNonce != payload.nonce) throw new Error(`Client nonce is not the challengeHash`)


			const tokenInfo = defaults.erc3009Tokens[request.currency];
			if (!tokenInfo) throw new Error(`Token contract is not verified to have EIP3009`);

			const signatureValid = await verifyTypedData({
				address: payload.from as Address,
				domain: {
					name: tokenInfo.name,
					version: tokenInfo.version,
					chainId: tokenInfo.chainId,
					verifyingContract: request.currency as Address
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
					from: payload.from as Address,
					to: payload.to as Address,
					value: BigInt(payload.value),
					validAfter: BigInt(payload.validAfter),
					validBefore: BigInt(payload.validBefore),
					nonce: payload.nonce as Hex,
				},
				signature: payload.signature as Hex
			})

			if (!signatureValid) throw new Error(`Invalid signature provided by client`);

			// TODO: Check to see if the sender has enough tokens (too lazy to do right now)

			// TODO: Simulate the transaction via eth_call to not waste gas
			const parsedSig = parseSignature(payload.signature as Hex)

			if (parsedSig.v == undefined) throw new Error(`Signature given in shorthand format via EIP 2098 is invalid`);

			const transactionHash = await sendTransaction(client, {
				account: serverAccount,
				chain: client.chain,
				to: request.currency as Hex,
				data: encodeFunctionData({
					abi: defaults.erc3009Abi,
					functionName: "transferWithAuthorization",
					args: [
						payload.from as Address,
						payload.to as Address,
						BigInt(payload.value),
						BigInt(payload.validAfter),
						BigInt(payload.validBefore),
						payload.nonce as `0x${string}`,
						Number(parsedSig.v),
						parsedSig.r as `0x${string}`,
						parsedSig.s as `0x${string}`,
					],
				}),
			});
			const receipt = await waitForTransactionReceipt(client, {hash: transactionHash});
			// TODO: check the Transfer event log to make sure it adds up
			return toReceipt(receipt);
		}
	}
	)
}

function toReceipt(receipt: TransactionReceipt) {
	if (receipt.status != "success") throw new Error(`Transaction reverted: ${receipt.transactionHash}`);
	return {
    method: "arbitrum" as const,
    status: "success" as const,
    timestamp: new Date().toISOString(),
    reference: receipt.transactionHash,
  };
}

export declare namespace charge {
	type Parameters = {
		amount?: string | undefined,
		currency?: string | undefined,
		recipient?: string | undefined,
		description?: string | undefined,
		externalId?: string | undefined,
		methodDetails?: {
			chainId?: number | undefined,
			permit2Address?: string | undefined,
			credentialTypes?: string[] | undefined,
			decimals?: number | undefined,
			splits?: string[] | undefined
		}
		account: Account
	}

}