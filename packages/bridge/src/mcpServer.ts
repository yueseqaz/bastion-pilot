import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from '@bastion-pilot/protocol';
import { loadConfig, resolveHome } from './config.js';
import { HubClient, selfCliPath } from './hubClient.js';
import { renderToolResult } from './render.js';
import { createLogger } from './logger.js';
import { VERSION } from './version.js';

/**
 * `bastion-pilot mcp`: an MCP stdio server that forwards tool calls to the
 * daemon. Spawned by MCP clients (Claude Code, Codex, ...); auto-starts the
 * daemon when nothing is listening yet.
 */
export async function runMcpServer(): Promise<void> {
  const log = createLogger('mcp');
  const { config } = loadConfig(resolveHome());

  const hub = new HubClient(
    {
      url: `ws://127.0.0.1:${config.server.port}`,
      token: config.security.token,
      name: 'mcp-server',
      version: VERSION,
      spawnDaemon: {
        command: process.execPath,
        args: [selfCliPath(), 'daemon'],
        env: process.env,
      },
    },
    log,
  );
  await hub.connect();

  const server = new McpServer({ name: 'bastion-pilot', version: VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.shape },
      async (params: Record<string, unknown>) => {
        try {
          const data = await hub.executeTool('mcp', tool.name, params);
          return { content: [{ type: 'text', text: renderToolResult(tool.name, data) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
  log.info('MCP stdio server ready (forwarding to daemon)');

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      hub.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('close', shutdown);
  });
}
