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
      // MCP hosts normally spawn one process per conversation. Preserve that
      // identity so the panel can target one Codex/Claude conversation rather
      // than broadcasting a request to every connected agent.
      agentId:
        process.env.BASTION_PILOT_AGENT_ID ??
        `${process.env.BASTION_PILOT_AGENT_NAME ?? 'mcp'}-${process.pid}`,
      conversationId:
        process.env.BASTION_PILOT_CONVERSATION_ID ??
        process.env.CODEX_THREAD_ID ??
        process.env.CODEX_SESSION_ID ??
        process.env.CLAUDE_SESSION_ID,
      label:
        process.env.BASTION_PILOT_AGENT_LABEL ??
        process.env.CODEX_THREAD_TITLE ??
        process.env.CLAUDE_SESSION_NAME ??
        (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID ? 'Codex 对话' : undefined),
      spawnDaemon: {
        command: process.execPath,
        args: [selfCliPath(), 'daemon'],
        env: process.env,
      },
    },
    log
  );
  await hub.connect();

  const server = new McpServer(
    { name: 'bastion-pilot', version: VERSION },
    {
      instructions:
        'BastionPilot shares conversation context with its browser side panel. At the start of a related task call get_shared_context; after forming a plan or reaching a conclusion call append_shared_context. When a panel user message includes a requestId, echo that requestId in your assistant append_shared_context response so the panel can correlate the reply. Shared context is background only: always call list_sessions and verify live terminal state before reporting current facts.',
    }
  );
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
      }
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
