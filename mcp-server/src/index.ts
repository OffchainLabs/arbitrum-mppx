import { charge } from '@arbitrum/mpp/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { Mppx } from 'mppx/client';
import { formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

config({ quiet: true });

if (process.env.PRIVATE_KEY == undefined) {
  throw new Error(`Client private key required`);
}

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(privateKey);

const mppx = Mppx.create({
  methods: [
    charge({
      account: account,
      chainId: 421614,
    }),
  ],
});

// Create server instance
const server = new McpServer({
  name: 'Arbitrum MPP',
  version: '1.0.0',
});

async function buy(endpoint: string): Promise<string | null> {
  const response = await mppx.fetch(endpoint);
  const data = await response.json();
  const paymentReceipt = response.headers.get('payment-receipt');
  if (paymentReceipt == undefined) return null;
  const final = Buffer.from(paymentReceipt, 'base64').toString('binary') + JSON.stringify(data);
  return final;
}

// Best-effort friendly label for known token contracts on Arbitrum.
const KNOWN_TOKENS: Record<string, string> = {
  '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d': 'USDC (Arbitrum Sepolia)',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC (Arbitrum One)',
};

function tokenLabel(currency: string): string {
  const known = KNOWN_TOKENS[currency.toLowerCase()];
  return known ? `${known} — ${currency}` : currency;
}

server.registerTool(
  'Discover_endpoints',
  {
    description: 'Discover the different endpoints and there offers at this host',
    inputSchema: {
      link: z.string().describe('The host link'),
    }
  },
  async ({ link }) => {
    const response = await fetch(`${link}/openapi.json`);

    if (!response.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to fetch discovery data (HTTP ${response.status})`,
          },
        ],
      };
    }

    const discovery = await response.text();
    return {
      content: [
        {
          type: 'text',
          text: discovery,
        },
      ],
    };
  },
)

server.registerTool(
  'pay_endpoint',
  {
    description: 'Pay the endpoint and retrieve the information',
    inputSchema: {
      state: z.string().describe('The endpoint that MPP should buy from'),
    },
  },
  async ({ state }) => {
    const mppEndpoint = state;
    const mppReceipt = await buy(mppEndpoint);

    if (mppReceipt === null) {
      return {
        content: [
          {
            type: 'text',
            text: 'Failed to pay',
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: mppReceipt,
        },
      ],
    };
  },
);

// server.registerTool(
//   'inspect_payment',
//   {
//     description:
//       'Fetch an MPP endpoint and relay its payment challenge: what you are paying for, how much, which token, and who receives it. Does NOT pay. Use this first so the user can decide whether to approve.',
//     inputSchema: {
//       endpoint: z.string().describe('The MPP endpoint to inspect for payment requirements'),
//     },
//   },
//   async ({ endpoint }) => {
//     const response = await mppx.rawFetch(endpoint);

//     if (response.status !== 402) {
//       const body = await response.text();
//       return {
//         content: [
//           {
//             type: 'text',
//             text:
//               `Endpoint did not request payment (HTTP ${response.status}). ` +
//               `No payment challenge to approve.\n\nResponse body:\n${body}`,
//           },
//         ],
//       };
//     }

//     const challenge = Challenge.fromResponse(response);
//     const request = challenge.request as {
//       amount: string;
//       currency: string;
//       recipient: string;
//       description?: string;
//       methodDetails?: { chainId?: number; decimals?: number };
//     };

//     const decimals = request.methodDetails?.decimals ?? 6;
//     const humanAmount = formatUnits(BigInt(request.amount), decimals);

//     const summary = [
//       `Payment requested by: ${challenge.realm}`,
//       `Paying for: ${request.description ?? challenge.description ?? '(no description provided)'}`,
//       `Amount: ${humanAmount} (${request.amount} base units, ${decimals} decimals)`,
//       `Token: ${tokenLabel(request.currency)}`,
//       `Recipient: ${request.recipient}`,
//       request.methodDetails?.chainId !== undefined
//         ? `Chain ID: ${request.methodDetails.chainId}`
//         : undefined,
//       challenge.expires ? `Expires: ${challenge.expires}` : undefined,
//       `Method/intent: ${challenge.method}/${challenge.intent}`,
//       '',
//       `If you approve, call create_credential with this same endpoint to sign the payment, ` +
//       `then submit_credential to complete it and receive the data.`,
//     ]
//       .filter((line) => line !== undefined)
//       .join('\n');

//     return {
//       content: [
//         {
//           type: 'text',
//           text: summary,
//         },
//       ],
//     };
//   },
// );

// server.registerTool(
//   'create_credential',
//   {
//     description:
//       'After the user has approved the payment shown by inspect_payment, create (sign) the payment credential for the endpoint. Returns the credential string to pass to submit_credential. Only call this once the user has explicitly approved paying.',
//     inputSchema: {
//       endpoint: z
//         .string()
//         .describe('The same MPP endpoint that was inspected and approved for payment'),
//     },
//   },
//   async ({ endpoint }) => {
//     const response = await mppx.rawFetch(endpoint);
//     if (response.status !== 402) {
//       return {
//         content: [
//           {
//             type: 'text',
//             text: `Endpoint no longer requests payment (HTTP ${response.status}). Nothing to sign.`,
//           },
//         ],
//       };
//     }

//     try {
//       const credential = await mppx.createCredential(response);
//       return {
//         content: [
//           {
//             type: 'text',
//             text: credential,
//           },
//         ],
//       };
//     } catch (error) {
//       return {
//         content: [
//           {
//             type: 'text',
//             text: `Failed to create credential: ${error instanceof Error ? error.message : String(error)}`,
//           },
//         ],
//       };
//     }
//   },
// );

// server.registerTool(
//   'submit_credential',
//   {
//     description:
//       'Send a signed payment credential (from create_credential) back to the MPP endpoint that issued the challenge, then return the purchased data along with the payment status and transaction hash.',
//     inputSchema: {
//       endpoint: z.string().describe('The MPP endpoint that issued the payment challenge'),
//       credential: z
//         .string()
//         .describe('The credential string produced by create_credential'),
//     },
//   },
//   async ({ endpoint, credential }) => {
//     const response = await mppx.rawFetch(endpoint, {
//       headers: { Authorization: credential },
//     });

//     const rawBody = await response.text();
//     let data: string = rawBody;
//     try {
//       data = JSON.stringify(JSON.parse(rawBody), null, 2);
//     } catch {
//       // body was not JSON — keep it as-is
//     }

//     if (!response.ok) {
//       return {
//         content: [
//           {
//             type: 'text',
//             text: `Payment was not accepted (HTTP ${response.status}).\n\nResponse:\n${data}`,
//           },
//         ],
//       };
//     }

//     let receiptText = 'No payment receipt was returned by the server.';
//     try {
//       const receipt = Receipt.fromResponse(response);
//       receiptText = [
//         `Status: ${receipt.status}`,
//         `Transaction hash: ${receipt.reference}`,
//         `Method: ${receipt.method}`,
//         `Settled at: ${receipt.timestamp}`,
//         receipt.externalId ? `External ID: ${receipt.externalId}` : undefined,
//       ]
//         .filter((line) => line !== undefined)
//         .join('\n');
//     } catch {
//       // no/invalid receipt header — fall back to the default message
//     }

//     return {
//       content: [
//         {
//           type: 'text',
//           text: `Payment complete.\n\n${receiptText}\n\nData you paid for:\n${data}`,
//         },
//       ],
//     };
//   },
// );

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Payment MCP working?');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
