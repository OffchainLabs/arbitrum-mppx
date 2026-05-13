import { Method } from "mppx"
import * as Methods from "../Methods.js"
import * as defaults from "../default.js"
import {
	encodeFunctionData,
	encodeAbiParameters,
	verifyTypedData,
	keccak256,
	encodePacked,
	toBytes,
	parseSignature,
	erc20Abi,
	parseEventLogs,
	isAddress
} from "viem";
import type { Address, Hex, Account, TransactionReceipt } from "viem"
import { sendTransaction, waitForTransactionReceipt, readContract, call } from "viem/actions"
import { resolveClients } from "../utils.js";

export type ChargeParameters = {
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
	rpcUrls?: Map<number, string>
}

export function charge(parameters: ChargeParameters): Method.Server<typeof Methods.arbitrumCharge> {
	const {
		currency,
		recipient,
		methodDetails,
		rpcUrls
	} = parameters;

	const serverAccount = parameters.account;

	const clientsMap = resolveClients(rpcUrls);

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
				payload
			} = credential;

			const { methodDetails } = request

			const {
				chainId,
				splits
			} = methodDetails;

			const client = clientsMap.get(chainId);
			if (client === undefined) {
				throw new Error(`rpcUrl not provided for chainId: ${chainId}`);
			}

			/**
			 * Verification steps
			 */


			if (splits && payload.type !== "permit2") {
				throw new Error(`Splits is only compatible with type: permit2, Payload type given: ${payload.type}`)
			}

			// Different verifications for different types
			switch (payload.type) {
				case "permit2": {
					payload as defaults.Permit2Payload

					const { transferDetails } = payload;
					const { permitted } = payload.permit;

					if (source === undefined) { throw new Error("Source cannot be undefined for type permit2") }

					const parts = source.split(':');
					if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'pkh') {
						throw new Error(`Invalid did:pkh: ${source}`);
					}
					const [, , namespace, chainIdStr, address] = parts
					if (!isAddress(address as Address)) throw new Error(`Invalid address: ${address}`);

					if (BigInt(payload.permit.deadline) < BigInt(Math.floor(Date.now() / 1000))) throw new Error(`Client payload
						timeframe is no longer valid. Current time: ${Date.now() / 1000}
							validBefore timestamp: ${payload.permit.deadline}`);

					const domain = {
						name: "Permit2",
						chainId: Number(chainIdStr),
						verifyingContract: defaults.PERMIT2_ADDRESS,
					}

					let signatureValid: boolean = false;
					// Theres a single and batch version for PermitWitnessTransferFrom
					if (splits === undefined) {
						signatureValid = await verifyTypedData({
							address: address as Address,
							domain,
							types: {
								PermitWitnessTransferFrom: [
									{ name: "permitted", type: "TokenPermissions" },
									{ name: "spender", type: "address" },
									{ name: "nonce", type: "uint256" },
									{ name: "deadline", type: "uint256" },
									{ name: "witness", type: "PaymentWitness" },
								],
								TokenPermissions: defaults.tokenPermissionsType,
								PaymentWitness: defaults.PaymentWitness,
							},
							primaryType: "PermitWitnessTransferFrom",
							message: {
								permitted: { token: permitted[0]!.token as Address, amount: BigInt(permitted[0]!.amount) },
								spender: recipient as Address,
								nonce: BigInt(payload.permit.nonce),
								deadline: BigInt(payload.permit.deadline),
								witness: { challengeHash: payload.witness.challengeHash as Hex },
							},
							signature: payload.signature as Hex
						});
					}
					else {
						signatureValid = await verifyTypedData({
							address: address as Address,
							domain,
							types: {
								PermitBatchWitnessTransferFrom: [
									{ name: "permitted", type: "TokenPermissions[]" },
									{ name: "spender", type: "address" },
									{ name: "nonce", type: "uint256" },
									{ name: "deadline", type: "uint256" },
									{ name: "witness", type: "PaymentWitness" },
								],
								TokenPermissions: defaults.tokenPermissionsType,
								PaymentWitness: defaults.PaymentWitness,
							},
							primaryType: "PermitBatchWitnessTransferFrom",
							message: {
								permitted: permitted.map(p => ({ token: p.token as Address, amount: BigInt(p.amount) })),
								spender: recipient as Address,
								nonce: BigInt(payload.permit.nonce),
								deadline: BigInt(payload.permit.deadline),
								witness: { challengeHash: payload.witness.challengeHash as Hex },
							},
							signature: payload.signature as Hex
						});
					}
					if (!signatureValid) {
						throw new Error("Client signature is invalid")
					}

					const challengeHash = keccak256(encodePacked(
						defaults.CHALLENGE_HASH_ABI,
						[challenge.id, challenge.realm]
					))

					if (challengeHash != payload.witness.challengeHash) {
						throw new Error(`Client challengeHash is not equal to actual challengeHash`);
					}

					// Check that the signer has sufficient token balance
					const balance = await readContract(client, {
						address: request.currency as Address,
						abi: erc20Abi,
						functionName: 'balanceOf',
						args: [address as Address],
					})

					if (balance < BigInt(request.amount)) {
						throw new Error(`Client does not have enough tokens. 
							balance: ${balance} required: ${request.amount}`)
					}

					// Check that the signer has enough allowance for permit2
					const allowance = await readContract(client, {
						address: request.currency as Address,
						abi: erc20Abi,
						functionName: 'allowance',
						args: [
							address as Address,
							defaults.PERMIT2_ADDRESS
						],
					})

					if (allowance < BigInt(request.amount)) {
						throw new Error(`Permit2 does not have enough allowance to perform transaction.
							allowance: ${allowance} required: ${request.amount}`);
					}

					// Check that permitted and transferDetails have correct information such as same length, 
					// correct token contract, correct amounts, correct order, if splits are present make sure those
					// are correct and that the primary recipient is in the front of both arrays
					if (permitted.length !== transferDetails.length) {
						throw new Error(`Permitted array and transferDetails array are not equal
							Permitted length: ${permitted.length} transferDetails length: ${transferDetails.length}`);
					}

					let requestSum = BigInt(0);
					if (splits === undefined) {
						verifyPrimaryRecipient(
							permitted,
							transferDetails,
							request.currency as Address,
							requestSum,
							request.amount,
							request.recipient
						)
					}
					else {
						if (permitted.length - 1 !== request.methodDetails.splits!.length) {
							throw new Error(`permitted and transferDetails length - 1 is not equal to splits length.
								permitted/transferDetails length: ${permitted.length} 
								splits length: ${splits.length}`)
						}
						// Since the primary recipient is pushed to the front of the array and is not included 
						// in splits. Splits needs to lag behind by 1.
						for (let i = 1; i < permitted.length; i++) {
							const p = permitted[i];
							const t = transferDetails[i];
							const s = splits[i - 1];
							if (p === undefined || t === undefined) {
								throw new Error(`permitted or transferDetails at 
									index ${i} is undefined. permitted: ${p} transferDetails: ${t}`);
							}
							if (s === undefined) {
								throw new Error(`splits at index ${i - 1} is undefined`);
							}
							if (p.amount !== t.requestedAmount) {
								throw new Error(`permitted and transferDetails have unequal amount values.
									permitted: ${p.amount} transferDetails: ${t.requestedAmount}`);
							}
							if (p.token !== currency) {
								throw new Error(`Permitted token address is not equal to request token address.
									permitted: ${p.token} request: ${currency}`);
							}
							if (t.to !== s.recipient) {
								throw new Error(`transferDetails recipient is not equal to splits recipient
									transferDetails recipient ${t.to} splits recipient: ${s.recipient}`);
							}
							requestSum += BigInt(t.requestedAmount)
						}
						// final check to make sure the primary recipient is getting paid the correct amount 
						verifyPrimaryRecipient(
							permitted,
							transferDetails,
							request.currency as Address,
							requestSum,
							request.amount,
							request.recipient
						)
					}


					// I don't really understand this witness hash stuff but it works on chain so it must be correct.
					// it would definitely revert if it wasn't.
					const witnessTypeHash = keccak256(
						toBytes("PaymentWitness(bytes32 challengeHash)")
					);
					const witness = keccak256(
						encodeAbiParameters(
							[{ type: "bytes32" }, { type: "bytes32" }],
							[witnessTypeHash, payload.witness.challengeHash as Hex]
						)
					);

					// just like last time different encodings depending on if splits is present
					let transactionInfo;
					if (splits === undefined) {
						transactionInfo = {
							account: serverAccount,
							chain: client.chain,
							to: defaults.PERMIT2_ADDRESS as Hex,
							data: encodeFunctionData({
								abi: defaults.PERMIT2_SINGLE_ABI,
								functionName: "permitWitnessTransferFrom",
								args: [
									{
										permitted: {
											token: permitted[0]!.token as Address,
											amount: BigInt(permitted[0]!.amount),
										},
										nonce: BigInt(payload.permit.nonce),
										deadline: BigInt(payload.permit.deadline),
									},
									{
										to: transferDetails[0]!.to as Address,
										requestedAmount: BigInt(transferDetails[0]!.requestedAmount),
									},
									address as Address,
									witness,
									defaults.PERMIT2_WITNESS_TYPE_STRING,
									payload.signature as Hex,
								],
							}),
						};
					}
					else {
						transactionInfo = {
							account: serverAccount,
							chain: client.chain,
							to: defaults.PERMIT2_ADDRESS as Hex,
							data: encodeFunctionData({
								abi: defaults.PERMIT2_BATCH_ABI,
								functionName: "permitWitnessTransferFrom",
								args: [
									{
										permitted: permitted.map(p => ({
											token: p.token as Address,
											amount: BigInt(p.amount),
										})),
										nonce: BigInt(payload.permit.nonce),
										deadline: BigInt(payload.permit.deadline),
									},
									transferDetails.map(t => ({
										to: t.to as Address,
										requestedAmount: BigInt(t.requestedAmount),
									})),
									address as Address,
									witness,
									defaults.PERMIT2_WITNESS_TYPE_STRING,
									payload.signature as Hex,
								],
							}),
						};
					}

					// Simulate via eth_call
					const ethCallResponse = await call(client, transactionInfo);
					if (ethCallResponse.data !== undefined) {
						throw new Error(`simulated transaction failed: ${ethCallResponse}`);
					}

					const transactionHash = await sendTransaction(client, transactionInfo);
					const receipt = await waitForTransactionReceipt(client, { hash: transactionHash });

					// Check the logs and make sure they line up with what should have happened
					const parsedLogs = parseEventLogs({
						abi: erc20Abi,
						eventName: "Transfer",
						logs: receipt.logs
					});

					if (parsedLogs.length !== transferDetails.length) {
						throw new Error(`total transfer logs is not equal to transferDetails array
							transfer log num: ${parsedLogs.length} transferDetails array length: ${transferDetails.length}`)
					}
					for (let i = 0; i < parsedLogs.length; i++) {
						if (parsedLogs[i]?.args.to !== transferDetails[i]?.to) {
							throw new Error(`emitted logs recipient does not match transferDetails recipient
								log: ${parsedLogs[i]?.args.to} transferDetails: ${transferDetails[i]?.to}`)
						}
						if (parsedLogs[i]?.args.value.toString() !== transferDetails[i]?.requestedAmount) {
							throw new Error(`emitted logs value does not match transferDetails value
								log: ${parsedLogs[i]?.args.value} transferDetails: ${transferDetails[i]?.requestedAmount}`);
						}
					}

					return toReceipt(receipt);
				}
				case "authorization": {
					payload as {
						from: string;
						to: string;
						value: string;
						validAfter: string;
						validBefore: string;
						nonce: string;
						signature: string;
					}

					if (payload.to != request.recipient) throw new Error(`Client payload sending to incorrect address: 
							${payload.to} Should be ${request.recipient}`);

					if (payload.value != request.amount) throw new Error(`Client payload value is incorrect. 
							payload value: ${payload.value} Should be ${request.amount}`);

					const hashedNonce = keccak256(encodePacked(
						defaults.CHALLENGE_HASH_ABI,
						[challenge.id, challenge.realm]
					))

					if (payload.to.toLowerCase() !== request.recipient.toLowerCase()) throw new Error(`Client payload sending to incorrect address: 
				${payload.to} Should be ${request.recipient}`);

					if (payload.value != request.amount) throw new Error(`Client payload value is incorrect. 
					payload value: ${payload.value} Should be ${request.amount}`);

					if (BigInt(payload.validBefore) < Math.floor(Date.now() / 1000)) throw new Error(`Client payload timeframe is no longer valid.
				 Current time: ${Date.now() / 1000} validBefore timestamp: ${payload.validBefore}`);

					if (hashedNonce != payload.nonce) throw new Error(`Client nonce is not the challengeHash`)

					if (BigInt(payload.validBefore) < Math.floor(Date.now() / 1000)) throw new Error(`Client 
						payload timeframe is no longer valid. Current time: ${Date.now() / 1000} validBefore 
						timestamp: ${payload.validBefore}`);

					const tokenInfo = defaults.erc3009Tokens[request.currency];
					if (!tokenInfo) throw new Error(`Token contract is not verified to have EIP3009`);

					// Make sure client have enough funds
					const balance = await readContract(client, {
						address: request.currency as Address,
						abi: erc20Abi,
						functionName: 'balanceOf',
						args: [payload.from as Address],
					})

					if (balance < BigInt(payload.value)) {
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
					try {
						await call(client, transactionInfo);
					}
					catch (err) {
						throw new Error("Transaction simulation (eth_call) failed", { cause: err });
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

					if (parsedLogs[0] === undefined) {
						throw new Error("No transfer logs found")
					}

					if (parsedLogs[0].args.from.toLowerCase() !== payload.from.toLowerCase() ||
						parsedLogs[0].args.to.toLowerCase() !== payload.to.toLowerCase() ||
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
// This is a question, I made this just to remove redundancy when checking the primary recipient.
// should we even bother returning a boolean value if all we care about is seeing if it throws 
// an error or not?
function verifyPrimaryRecipient(
	permitted: defaults.Permit2Payload["permit"]["permitted"],
	transferDetails: defaults.Permit2Payload["transferDetails"],
	currency: Address,
	splitsSum: bigint,
	requestAmount: string,
	requestRecipient: string
) {
	if (permitted[0] === undefined || transferDetails[0] === undefined) {
		throw new Error(`permitted or transferDetails at index 0 is undefined
			permitted: ${permitted[0]} transferDetails: ${transferDetails[0]}`)
	}
	if (permitted[0].token !== currency) {
		throw new Error(`permitted token contract is not correct. permitted: ${permitted[0].token}
			request: ${currency}`);
	}
	if (permitted[0].amount !== transferDetails[0].requestedAmount) {
		throw new Error(`Amounts are not equal. permitted: ${permitted[0]?.amount} 
			transferDetails: ${transferDetails[0].requestedAmount}
			request: ${requestAmount}`);
	}
	if (BigInt(requestAmount) - splitsSum !== BigInt(permitted[0].amount)) {
		throw new Error(`permitted amount for primary recipient does not equal requested amount - sum of splits
			permitted: ${permitted[0].amount} requested-splits: ${BigInt(requestAmount) - splitsSum}`)
	}
	if (transferDetails[0].to !== requestRecipient) {
		throw new Error(`transferDetails to does not equal request recipient. transferDetails: ${transferDetails[0].to}
			request recipient: ${requestRecipient}`);
	}
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
