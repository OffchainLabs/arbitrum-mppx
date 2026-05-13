import { Method } from "mppx"
import * as Methods from "../Methods.js"
import * as defaults from "../default.js"
import {
	encodeFunctionData,
	verifyTypedData,
	keccak256,
	encodePacked,
	parseSignature,
	createClient,
	http,
	erc20Abi,
	parseEventLogs
} from "viem";
import type { Address, Hex, Client, Chain, Account, TransactionReceipt } from "viem"
import { sendTransaction, waitForTransactionReceipt, readContract, call } from "viem/actions"

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


		/**
		 * I did some testing trying to figure out why they send both credential and request. It seems that 
		 * MPP already does internal checks to see if the request of the challenge has been modified. I tested this
		 * by making a new branch and purposefully modifying the challenge sent to me from the server
		 * and when I sent back the credential containing the challenge the server always rejected it. 
		 * Payload is different, you need to check the values manually, since extra or modified
		 * parameters are not automatically checked and that is up to you
		 * 
		 * so TLDR: I do not know why it sends back both the credential and the request 
		 * when the credential contains the request and it was already checked to be the same
		 * Claude also said it checks it but I wanted to see for myself just incase
		 * 
		 * https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/evm/draft-evm-charge-00.md#verification-procedure-verification
		 * says to check and see if the server has stored a challenge with a specific ID that was sent out.
		 * but MPP seems to already do that for us. The Unified EVM doc is only a couple weeks old so I dont know 
		 * why it has extra checks in here that seem hard to implement (due to no post challenge sent hook) and also redundant
		 * (its probably claudes fault)
		 */
		async verify({ credential, request }) {
			const {
				challenge,
				payload,
				source
			} = credential;

			const { methodDetails } = request

			const {
				chainId,
				splits
			} = methodDetails;

			/**
			 * Verification steps
			 */

			const client = await resolveClient(chainId);

			if (splits && payload.type !== "permit2") {
				throw new Error(`Splits is only compatible with type: permit2, Payload type given: ${payload.type}`)
			}

			// Different verifications for different types
			switch (payload.type) {
				case "permit2": {
					// TODO: implement permit2 verification
					break;
				}
				case "authorization": {

					const hashedNonce = keccak256(encodePacked(
						defaults.CHALLENGE_HASH_ABI,
						[challenge.id, challenge.realm]
					))

					if (payload.to != request.recipient) throw new Error(`Client payload sending to incorrect address: 
				${payload.to} Should be ${request.recipient}`);

					if (payload.value != request.amount) throw new Error(`Client payload value is incorrect. 
					payload value: ${payload.value} Should be ${request.amount}`);

					if (BigInt(payload.validBefore) < Math.floor(Date.now() / 1000)) throw new Error(`Client payload timeframe is no longer valid.
				 Current time: ${Date.now() / 1000} validBefore timestamp: ${payload.validBefore}`);

					if (hashedNonce != payload.nonce) throw new Error(`Client nonce is not the challengeHash`)

					const tokenInfo = defaults.erc3009Tokens[request.currency];
					if (!tokenInfo) throw new Error(`Token contract is not verified to have EIP3009`);

					// Make sure client have enough funds
					const balance = await readContract(client, {
						address: request.currency as Address,
						abi: erc20Abi,
						functionName: 'balanceOf',
						args: [payload.from as Address],
					})

					if (balance.toString() < payload.value) {
						throw new Error(`Client does not have enough funds for transaction. Client funds: ${balance} 
							Required funds: ${payload.value}`)
					}

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

					const parsedSig = parseSignature(payload.signature as Hex)

					if (parsedSig.v == undefined) {
						throw new Error(`Signature given in shorthand format via EIP 2098 is invalid`);
					}

					const transactionInfo = {
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
					}

					// Simulate the transaction via eth_call to not use gas
					const ethCallResponse = await call(client, transactionInfo);
					if (ethCallResponse.data !== undefined) {
						throw new Error(`simulated transaction failed: ${ethCallResponse}`);
					}

					// Submit transaction
					const transactionHash = await sendTransaction(client, transactionInfo);
					const receipt = await waitForTransactionReceipt(client, { hash: transactionHash });

					// Check emitted logs for transfer and make sure the params are expected
					const parsedLogs = parseEventLogs({
						abi: erc20Abi,
						eventName: "Transfer",
						logs: receipt.logs
					});

					if (!parsedLogs[0]) {
						throw new Error("No transfer logs found")
					}

					if (parsedLogs[0].args.from !== payload.from ||
						parsedLogs[0].args.to !== payload.to ||
						parsedLogs[0].args.value.toString() !== payload.value
					) {
						throw new Error(`Emitted log params do not match up with payload values.
							Emitted log: ${parsedLogs[0].args.from,
							parsedLogs[0].args.to,
							parsedLogs[0].args.value.toString()}\n
							payloadParams ${payload.from, payload.to, payload.value}`)
					}
					return toReceipt(receipt);
				}
				case "transaction": {
					// TODO: maybe implement transaction
				}
				case "hash": {
					// TODO: maybe implement hash
				}
				default: {
					throw new Error(`Arbitrum MPP does not support given credential type: ${payload.type}`)
				}
			}
			// This is only here to avoid error from verify() func
			throw new Error(`Arbitrum MPP does not support given credential type: ${payload.type}`)
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