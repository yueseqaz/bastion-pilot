import { Command } from 'commander';
import { configPaths, loadConfig, resolveHome, type BastionPilotConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { isPortServing } from './hubClient.js';
import { createLogger } from './logger.js';
import { runMcpServer } from './mcpServer.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('bastion-pilot')
  .description('BastionPilot local bridge — bring AI agents to bastion web terminals')
  .version(VERSION);

program
  .command('daemon')
  .description('Start the BastionPilot daemon (localhost WS hub + approvals + audit log)')
  .option('-p, --port <port>', 'override the listen port', (v) => Number.parseInt(v, 10))
  .action(async (opts: { port?: number }) => {
    const handle = await startDaemon({ port: opts.port });
    const shutdown = () => {
      handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('mcp')
  .description('Run the MCP stdio server (used by Claude Code, Codex and other MCP clients)')
  .action(async () => {
    await runMcpServer();
  });

program
  .command('init')
  .description('Create the config file (first run) and print setup instructions')
  .action(() => {
    const home = resolveHome();
    const { config, configPath, created } = loadConfig(home);
    printInitSummary(config, configPath, created);
  });

program
  .command('doctor')
  .description('Check daemon, extension connection and AI provider reachability')
  .action(async () => {
    const { config, configPath } = loadConfig(resolveHome());
    const ok = await runDoctor(config, configPath);
    process.exitCode = ok ? 0 : 1;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

/* ------------------------------------------------------------------ */

function printInitSummary(config: BastionPilotConfig, configPath: string, created: boolean) {
  const paths = configPaths(resolveHome());
  const url = `ws://127.0.0.1:${config.server.port}`;
  console.log(
    `
BastionPilot v${VERSION}
Config:  ${configPath} ${created ? '(created; contains a fresh pairing token)' : '(existing)'}
Daemon:  ${url}
Audit:   ${paths.auditDir}
Outputs: ${paths.outputsDir}

Pairing token (paste into the extension options page):
  ${config.security.token}

1) Install the extension
   Chrome/Edge → chrome://extensions → enable "Developer mode" → "Load unpacked"
   → select packages/extension/dist (or the downloaded release zip, unzipped).

2) Connect the extension
   Open the BastionPilot side panel → Settings → paste the token → Save.
   Grant the extension access to your bastion host origin when prompted.

3) Use it from an MCP client (recommended brain)
   Claude Code:  claude mcp add bastion-pilot -- npx -y bastion-pilot mcp
                 (or: claude mcp add bastion-pilot -- <path-to>/dist/cli.js mcp)
   Codex CLI:    add to ~/.codex/config.toml:
                 [mcp_servers.bastion-pilot]
                 command = "bastion-pilot"
                 args = ["mcp"]

4) Optional: built-in side-panel chat with your own AI provider
   Add an OpenAI-compatible provider to ${configPath}:
     "providers": [
       { "id": "default", "baseUrl": "https://api.openai.com/v1",
         "apiKey": "sk-...", "model": "gpt-4o" }
     ],
     "activeProviderId": "default"
   Self-hosted / intranet gateways work the same way (any OpenAI-compatible URL).

5) Verify:  bastion-pilot doctor
`,
  );
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function runDoctor(config: BastionPilotConfig, configPath: string): Promise<boolean> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: 'config',
    ok: true,
    detail: configPath,
  });

  const serving = await isPortServing(`ws://127.0.0.1:${config.server.port}`);
  let health: Record<string, unknown> | null = null;
  if (serving) {
    try {
      const res = await fetch(`http://127.0.0.1:${config.server.port}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      health = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      checks.push({
        name: 'daemon',
        ok: false,
        detail: `port is open but /health failed: ${(err as Error).message}`,
      });
    }
  }
  if (health) {
    checks.push({
      name: 'daemon',
      ok: true,
      detail: `v${health.version}, uptime ${health.uptimeS}s, approval mode: ${health.approvalMode}`,
    });
    checks.push({
      name: 'extension',
      ok: health.extensionConnected === true,
      detail:
        health.extensionConnected === true
          ? `connected (${health.sessions} session(s) hooked)`
          : 'not connected — open the browser side panel and check the daemon URL/token',
    });
  } else if (!serving) {
    checks.push({
      name: 'daemon',
      ok: false,
      detail: 'not running — start it with `bastion-pilot daemon` (or let the MCP server spawn it)',
    });
  }

  if (config.providers.length === 0) {
    checks.push({
      name: 'ai-provider',
      ok: true,
      detail:
        'none configured (built-in chat disabled; MCP brains like Claude Code still work). ' +
        'Add an OpenAI-compatible provider to the config to enable the side-panel chat.',
    });
  } else {
    for (const provider of config.providers) {
      const base = provider.baseUrl.replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${provider.apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        checks.push({
          name: `ai-provider:${provider.id}`,
          ok: res.status === 200,
          detail:
            res.status === 200
              ? `reachable, model: ${provider.model}`
              : `HTTP ${res.status} from ${base}/models (check baseUrl/apiKey)`,
        });
      } catch (err) {
        checks.push({
          name: `ai-provider:${provider.id}`,
          ok: false,
          detail: `unreachable: ${(err as Error).message}`,
        });
      }
    }
  }

  let allOk = true;
  console.log(`BastionPilot doctor (v${VERSION})\n`);
  for (const check of checks) {
    if (!check.ok) allOk = false;
    console.log(`  ${check.ok ? '✔' : '✘'} ${check.name.padEnd(24)} ${check.detail}`);
  }
  console.log('');
  return allOk;
}
