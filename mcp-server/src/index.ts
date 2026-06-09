import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { charge } from '@arbitrum/mpp/client';
import { config } from 'dotenv';
import { Mppx } from 'mppx/client';
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
  const final =
    Buffer.from(paymentReceipt, 'base64').toString('binary') + JSON.stringify(data);
  return final;
}

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Payment MCP working?');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
