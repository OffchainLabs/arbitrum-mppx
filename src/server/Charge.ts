import { Method } from 'mppx';
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  keccak256,
  parseEventLogs,
  parseSignature,
  toBytes,
  verifyTypedData,
} from 'viem';
import type { Account, Address, Hex, TransactionReceipt } from 'viem';
import { call, readContract, sendTransaction, waitForTransactionReceipt } from 'viem/actions';

import * as Methods from '../Methods.js';
import * as defaults from '../default.js';
import { buildPermit2TypedData, createChallengeHash, resolveClients } from '../utils.js';

export type ChargeParameters = {
  amount?: string | undefined;
  currency?: string | undefined;
  recipient?: string | undefined;
  description?: string | undefined;
  externalId?: string | undefined;
  methodDetails?: {
    chainId?: number | undefined;
    permit2Address?: string | undefined;
    credentialTypes?: string[] | undefined;
    decimals?: number | undefined;
    splits?: string[] | undefined;
  };
  account: Account;
  rpcUrls?: Map<number, string>;
};

export function charge(parameters: ChargeParameters): Method.Server<typeof Methods.arbitrumCharge> {
  const { currency, recipient, methodDetails, rpcUrls } = parameters;

  const serverAccount = parameters.account;

  const clientsMap = resolveClients(rpcUrls);

  return Method.toServer(Methods.arbitrumCharge, {
    defaults: {
      currency,
      recipient,
      methodDetails,
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
      const { challenge, payload, source } = credential;

      const { id, realm } = challenge;

      const { methodDetails, recipient } = request;

      const { chainId, splits } = methodDetails;

      const client = clientsMap.get(chainId);
      if (client === undefined) {
        throw new Error(`rpcUrl not provided for chainId: ${chainId}`);
      }

      /**
       * Verification steps
       */

      if (splits && payload.type !== 'permit2') {
        throw new Error(
          `Splits is only compatible with type: permit2, Payload type given: ${payload.type}`,
        );
      }

      // Different verifications for different types
      switch (payload.type) {
        case 'permit2': {
          if (
            request.methodDetails.credentialTypes !== undefined &&
            request.methodDetails.credentialTypes.find((type) => type === 'permit2') === undefined
          ) {
            throw new Error(`permit2 is not a valid credentialType given in the request,
							given types ${request.methodDetails.credentialTypes}`);
          }

          const { transferDetails } = payload;
          const { permitted, nonce, deadline } = payload.permit;

          if (source === undefined) {
            throw new Error('Source cannot be undefined for type permit2');
          }

          if (recipient !== serverAccount.address) {
            throw new Error(`Recipient address must be the same as the account in parameters
							Recipient: ${recipient} account: ${serverAccount.address}`);
          }

          const parts = source.split(':');
          if (parts.length !== 5 || parts[0] !== 'did' || parts[1] !== 'pkh') {
            throw new Error(`Invalid did:pkh: ${source}`);
          }

          const [, , , chainIdStr, address] = parts;
          if (!isAddress(address as Address)) throw new Error(`Invalid address: ${address}`);

          if (Number(chainIdStr) !== chainId)
            throw new Error(`did:pkh gave incorrect chainId
						did:pkh chainId: ${chainIdStr} methodDetails chainId: ${chainId}`);

          if (BigInt(payload.permit.deadline) < BigInt(Math.floor(Date.now() / 1000)))
            throw new Error(`Client payload
						timeframe is no longer valid. Current time: ${Date.now() / 1000}
							validBefore timestamp: ${payload.permit.deadline}`);

          // Depending on if splits exists or not, we are required to use different permit2 functions
          // buildPermit2TypedData checks and does it for us
          const typedData = buildPermit2TypedData({
            chainId: chainId,
            permitted: permitted,
            recipient: recipient as Address,
            Witness: payload.witness,
            nonce: BigInt(nonce),
            deadline: BigInt(deadline),
          });

          const signature = await verifyTypedData({
            address: address as Address,
            ...typedData,
            signature: payload.signature as Hex,
          });

          if (!signature) {
            throw new Error('Client signature is invalid');
          }

          const challengeHash = createChallengeHash({ id, realm, transferDetails });

          if (challengeHash != payload.witness.challengeHash) {
            throw new Error(`Client challengeHash is not equal to actual challengeHash`);
          }

          // Check that the signer has sufficient token balance
          const balance = await readContract(client, {
            address: request.currency as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address as Address],
          });

          if (balance < BigInt(request.amount)) {
            throw new Error(`Client does not have enough tokens. 
							balance: ${balance} required: ${request.amount}`);
          }

          // Check that the signer has enough allowance for permit2
          const allowance = await readContract(client, {
            address: request.currency as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address as Address, defaults.PERMIT2_ADDRESS],
          });

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

          if (splits === undefined) {
            verifyPrimaryRecipient(
              permitted,
              transferDetails,
              request.currency as Address,
              0n,
              request.amount,
              request.recipient,
            );
          } else {
            if (permitted.length - 1 !== request.methodDetails.splits!.length) {
              throw new Error(`permitted and transferDetails length - 1 is not equal to splits length.
								permitted/transferDetails length: ${permitted.length} 
								splits length: ${splits.length}`);
            }
            let requestSum = BigInt(0);
            // Since the primary recipient is pushed to the front of the array and is not included
            // in splits. Splits needs to lag behind by 1. which is also why we skip when i == 0
            const splitPayments = permitted.slice(1).map((p, offset) => ({
              index: offset + 1,
              permittedItem: p,
              transferDetail: transferDetails[offset + 1],
              split: splits[offset],
            }));

            for (const { index, permittedItem, transferDetail, split } of splitPayments) {
              if (permittedItem === undefined || transferDetail === undefined) {
                throw new Error(`permitted or transferDetails at 
									index ${index} is undefined. permitted: ${permittedItem} transferDetails: ${transferDetail}`);
              }
              if (split === undefined) {
                throw new Error(`splits at index ${index - 1} is undefined`);
              }
              if (permittedItem.amount !== transferDetail.requestedAmount) {
                throw new Error(`permitted and transferDetails have unequal amount values.
									permitted: ${permittedItem.amount} transferDetails: ${transferDetail.requestedAmount}`);
              }
              if (permittedItem.token.toLowerCase() !== currency?.toLowerCase()) {
                throw new Error(`Permitted token address is not equal to request token address.
									permitted: ${permittedItem.token} request: ${currency}`);
              }
              if (transferDetail.to.toLowerCase() !== split.recipient.toLowerCase()) {
                throw new Error(`transferDetails recipient is not equal to splits recipient
									transferDetails recipient ${transferDetail.to} splits recipient: ${split.recipient}`);
              }
              requestSum += BigInt(transferDetail.requestedAmount);
            }
            // final check to make sure the primary recipient is getting paid the correct amount
            verifyPrimaryRecipient(
              permitted,
              transferDetails,
              request.currency as Address,
              requestSum,
              request.amount,
              request.recipient,
            );
          }

          // I don't really understand this witness hash stuff but it works on chain so it must be correct.
          // it would definitely revert if it wasn't.
          const witnessTypeHash = keccak256(toBytes('PaymentWitness(bytes32 challengeHash)'));
          const witness = keccak256(
            encodeAbiParameters(
              [{ type: 'bytes32' }, { type: 'bytes32' }],
              [witnessTypeHash, payload.witness.challengeHash as Hex],
            ),
          );

          // just like last time different encodings depending on if splits is present
          // tried to make this nicer with   ? :   but doesnt seem to work with the abis
          let transactionInfo;
          if (splits === undefined) {
            transactionInfo = {
              account: serverAccount,
              to: defaults.PERMIT2_ADDRESS as Address,
              data: encodeFunctionData({
                abi: defaults.PERMIT2_SINGLE_ABI,
                functionName: 'permitWitnessTransferFrom',
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
          } else {
            transactionInfo = {
              account: serverAccount,
              to: defaults.PERMIT2_ADDRESS as Address,
              data: encodeFunctionData({
                abi: defaults.PERMIT2_BATCH_ABI,
                functionName: 'permitWitnessTransferFrom',
                args: [
                  {
                    permitted: permitted.map((p) => ({
                      token: p.token as Address,
                      amount: BigInt(p.amount),
                    })),
                    nonce: BigInt(payload.permit.nonce),
                    deadline: BigInt(payload.permit.deadline),
                  },
                  transferDetails.map((t) => ({
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
          // I dont understand why I have to remove chainID for eth_call to not throw error but then
          // in authorization it doesnt care if chainId is a part of eth_call. TS 4/10
          const ethCallResponse = await call(client, transactionInfo);
          if (ethCallResponse.data !== undefined) {
            throw new Error(`simulated transaction failed: ${ethCallResponse}`);
          }

          const transactionHash = await sendTransaction(client, {
            chain: client.chain,
            ...transactionInfo,
          });
          const receipt = await waitForTransactionReceipt(client, { hash: transactionHash });

          // Check the logs and make sure they line up with what should have happened
          const parsedLogs = parseEventLogs({
            abi: erc20Abi,
            eventName: 'Transfer',
            logs: receipt.logs,
          });

          if (parsedLogs.length !== transferDetails.length) {
            throw new Error(`total transfer logs is not equal to transferDetails array
							transfer log num: ${parsedLogs.length} transferDetails array length: ${transferDetails.length}`);
          }
          for (const [i, parsedLog] of parsedLogs.entries()) {
            if (parsedLog?.args.to.toLowerCase() !== transferDetails[i]?.to.toLowerCase()) {
              throw new Error(`emitted logs recipient does not match transferDetails recipient
								log: ${parsedLog?.args.to} transferDetails: ${transferDetails[i]?.to}`);
            }
            if (parsedLog?.args.value.toString() !== transferDetails[i]?.requestedAmount) {
              throw new Error(`emitted logs value does not match transferDetails value
								log: ${parsedLog?.args.value} transferDetails: ${transferDetails[i]?.requestedAmount}`);
            }
          }

          return toReceipt(receipt);
        }
        case 'authorization': {
          if (
            methodDetails.credentialTypes?.find((type) => type === 'authorization') === undefined
          ) {
            throw new Error(`type authorization was not available for this request. Given types: 
							${methodDetails.credentialTypes}`);
          }

          if (payload.to != request.recipient)
            throw new Error(`Client payload sending to incorrect address: 
							${payload.to} Should be ${request.recipient}`);

          if (payload.value != request.amount)
            throw new Error(`Client payload value is incorrect. 
							payload value: ${payload.value} Should be ${request.amount}`);

          const hashedNonce = createChallengeHash({ id, realm });

          if (payload.to.toLowerCase() !== request.recipient.toLowerCase())
            throw new Error(`Client payload sending to incorrect address: 
				${payload.to} Should be ${request.recipient}`);

          if (payload.value != request.amount)
            throw new Error(`Client payload value is incorrect. 
					payload value: ${payload.value} Should be ${request.amount}`);

          if (BigInt(payload.validBefore) < Math.floor(Date.now() / 1000))
            throw new Error(`Client payload timeframe is no longer valid.
				 Current time: ${Date.now() / 1000} validBefore timestamp: ${payload.validBefore}`);

          if (hashedNonce != payload.nonce)
            throw new Error(`Client nonce is not the challengeHash`);

          if (BigInt(payload.validBefore) < Math.floor(Date.now() / 1000))
            throw new Error(`Client 
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
          });

          if (balance < BigInt(payload.value)) {
            throw new Error(`Client does not have enough funds for transaction. Client funds: ${balance} 
							Required funds: ${payload.value}`);
          }

          const signatureValid = await verifyTypedData({
            address: payload.from as Address,
            domain: {
              name: tokenInfo.name,
              version: tokenInfo.version,
              chainId: tokenInfo.chainId,
              verifyingContract: request.currency as Address,
            },
            types: {
              TransferWithAuthorization: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' },
              ],
            },
            primaryType: 'TransferWithAuthorization',
            message: {
              from: payload.from as Address,
              to: payload.to as Address,
              value: BigInt(payload.value),
              validAfter: BigInt(payload.validAfter),
              validBefore: BigInt(payload.validBefore),
              nonce: payload.nonce as Hex,
            },
            signature: payload.signature as Hex,
          });

          if (!signatureValid) throw new Error(`Invalid signature provided by client`);

          const parsedSig = parseSignature(payload.signature as Hex);

          if (parsedSig.v == undefined) {
            throw new Error(`Signature given in shorthand format via EIP 2098 is invalid`);
          }

          const transactionInfo = {
            account: serverAccount,
            chain: client.chain,
            to: request.currency as Hex,
            data: encodeFunctionData({
              abi: defaults.erc3009Abi,
              functionName: 'transferWithAuthorization',
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
          };

          // Simulate the transaction via eth_call to not use gas
          try {
            await call(client, transactionInfo);
          } catch (err) {
            throw new Error('Transaction simulation (eth_call) failed', { cause: err });
          }

          // Submit transaction
          const transactionHash = await sendTransaction(client, transactionInfo);
          const receipt = await waitForTransactionReceipt(client, { hash: transactionHash });

          // Check emitted logs for transfer and make sure the params are expected
          const parsedLogs = parseEventLogs({
            abi: erc20Abi,
            eventName: 'Transfer',
            logs: receipt.logs,
          });

          if (parsedLogs[0] === undefined) {
            throw new Error('No transfer logs found');
          }

          if (
            parsedLogs[0].args.from.toLowerCase() !== payload.from.toLowerCase() ||
            parsedLogs[0].args.to.toLowerCase() !== payload.to.toLowerCase() ||
            parsedLogs[0].args.value.toString() !== payload.value
          ) {
            throw new Error(`Emitted log params do not match up with payload values.
							Emitted log: ${
                (parsedLogs[0].args.from,
                parsedLogs[0].args.to,
                parsedLogs[0].args.value.toString())
              }\n
							payloadParams ${(payload.from, payload.to, payload.value)}`);
          }
          return toReceipt(receipt);
        }
        case 'transaction': {
          // TODO: maybe implement transaction
        }
        case 'hash': {
          // TODO: maybe implement hash
        }
        default: {
          throw new Error(`Arbitrum MPP does not support given credential type: ${payload.type}`);
        }
      }
      // This is only here to avoid error from verify() func
      throw new Error(`Arbitrum MPP does not support given credential type: ${payload.type}`);
    },
  });
}
// This is a question, I made this just to remove redundancy when checking the primary recipient.
// should we even bother returning a boolean value if all we care about is seeing if it throws
// an error or not?
function verifyPrimaryRecipient(
  permitted: defaults.Permit2Payload['permit']['permitted'],
  transferDetails: defaults.Permit2Payload['transferDetails'],
  currency: Address,
  splitsSum: bigint,
  requestAmount: string,
  requestRecipient: string,
) {
  if (permitted[0] === undefined || transferDetails[0] === undefined) {
    throw new Error(`permitted or transferDetails at index 0 is undefined
			permitted: ${permitted[0]} transferDetails: ${transferDetails[0]}`);
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
			permitted: ${permitted[0].amount} requested-splits: ${BigInt(requestAmount) - splitsSum}`);
  }
  if (transferDetails[0].to !== requestRecipient) {
    throw new Error(`transferDetails to does not equal request recipient. transferDetails: ${transferDetails[0].to}
			request recipient: ${requestRecipient}`);
  }
}

function toReceipt(receipt: TransactionReceipt) {
  if (receipt.status != 'success')
    throw new Error(`Transaction reverted: ${receipt.transactionHash}`);
  return {
    method: 'arbitrum' as const,
    status: 'success' as const,
    timestamp: new Date().toISOString(),
    reference: receipt.transactionHash,
  };
}
