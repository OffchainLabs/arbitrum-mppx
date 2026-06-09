import { createClient, encodePacked, http, keccak256 } from 'viem';
import * as defaults from './default.js';
export function resolveClients(rpcUrls) {
    const clientsMap = new Map();
    if (rpcUrls === undefined) {
        const arbSepoliaClient = createClient({
            chain: { id: defaults.chainId.arbitrumSepolia },
            transport: http(defaults.rpcUrl[defaults.chainId.arbitrumSepolia]),
        });
        clientsMap.set(arbSepoliaClient.chain.id, arbSepoliaClient);
        const arbOneClient = createClient({
            chain: { id: defaults.chainId.arbitrumOne },
            transport: http(defaults.rpcUrl[defaults.chainId.arbitrumOne]),
        });
        clientsMap.set(arbOneClient.chain.id, arbOneClient);
    }
    else {
        for (const [id, url] of rpcUrls) {
            const newClient = createClient({ chain: { id }, transport: http(url) });
            clientsMap.set(id, newClient);
        }
    }
    return clientsMap;
}
export function buildPermit2TypedData(params) {
    const { chainId, permitted, recipient, nonce, deadline, Witness } = params;
    // if there is more than 1 entry in permitted then we need to call the
    // batch version of permitWitnessTransferFrom which is the same function name but takes arrays
    const isBatchPermit = permitted.length > 1;
    const permittedMessage = isBatchPermit
        ? permitted.map((p) => ({ token: p.token, amount: BigInt(p.amount) }))
        : { token: permitted[0].token, amount: BigInt(permitted[0].amount) };
    // Theres a single and batch version for PermitWitnessTransferFrom
    const typedData = {
        domain: {
            name: 'Permit2',
            chainId: Number(chainId),
            verifyingContract: defaults.PERMIT2_ADDRESS,
        },
        types: {
            [isBatchPermit ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom']: [
                { name: 'permitted', type: isBatchPermit ? 'TokenPermissions[]' : 'TokenPermissions' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'witness', type: 'PaymentWitness' },
            ],
            TokenPermissions: defaults.tokenPermissionsType,
            PaymentWitness: defaults.PaymentWitness,
        },
        primaryType: isBatchPermit ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom',
        message: {
            permitted: permittedMessage,
            spender: recipient,
            nonce: BigInt(nonce),
            deadline: BigInt(deadline),
            witness: Witness,
        },
    };
    return typedData;
}
export function createChallengeHash(params) {
    const { id, realm, transferDetails } = params;
    if (transferDetails === undefined) {
        return keccak256(encodePacked(['string', 'string'], [id, realm]));
    }
    const tos = transferDetails.map((td) => td.to);
    const amounts = transferDetails.map((td) => BigInt(td.requestedAmount));
    return keccak256(encodePacked(['string', 'string', 'string[]', 'uint256[]'], [id, realm, tos, amounts]));
}
