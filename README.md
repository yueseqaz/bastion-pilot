# BastionPilot

[![CI](https://github.com/yueseqaz/bastion-pilot/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[中文文档](./README.zh-CN.md)

**Bring AI agents to bastion-host web terminals.**

In many companies the only way to reach production servers is through a bastion host (JumpServer,
Qizhi, Aliyun Bastionhost, ...) that exposes a **web terminal in the browser**. There is no SSH
access, so CLI agents like Claude Code or Codex cannot reach your servers. BastionPilot fixes
that: a browser extension hooks the web terminal and acts as the agent's _hands and eyes_, while a
local bridge exposes clean, auditable tools to any AI brain you prefer.

```
Claude Code / Codex            Side-panel chat
   (MCP stdio)                       │
        │                            │ HTTPS → your AI provider
        ▼                            ▼
┌─────────────────────────────────────────────┐
│            local bridge (daemon)             │
│  MCP server │ built-in agent │ approvals │   │
│              │    loop      │ audit log  │   │
└──────────────┬──────────────────────────────┘
               │ ws://127.0.0.1 + pairing token
               ▼
┌─────────────────────────────────────────────┐
│           browser extension (MV3)            │
│  MAIN world: WebSocket interception (I/O)    │
│  content controller: session + buffers       │
│  service worker: tool routing, approvals     │
└──────────────┬──────────────────────────────┘
               │ the page's own WebSocket
               ▼
   bastion web terminal (JumpServer / any xterm.js product)
```

## How it works

- **The extension is the only owner of terminal I/O.** A main-world script injected at
  `document_start` patches `window.WebSocket`, tees every downstream frame (the PTY stream) and
  can type into the terminal on request. Whatever the bastion product renders — xterm.js on
  canvas, WebGL, anything — the raw stream is captured before it is drawn.
- **Everything else connects to it.** Claude Code / Codex talk to the daemon's MCP server; the
  side-panel chat uses the daemon's built-in agent loop with your own OpenAI-compatible provider.
  Both brains funnel through the same tool executor, the same approval policy and the same audit
  log.
- **Output is made LLM-ready.** PTY bytes are decoded (UTF-8, chunk-safe), ANSI/OSC escape
  sequences are stripped, `\r`/`\b` overwrite semantics are applied (progress bars collapse into
  their final line), and oversized output is written to a local file whose path is returned to the
  agent — Claude Code can then read the full file with its own tools.
- **Command completion is detected reliably.** After typing a command, BastionPilot appends an
  `echo __BP_<nonce>_$?__` sentinel. The literal `$?` in the echoed input can never match the
  result pattern, so the sentinel resolves exactly once, carrying the exit code. Quiet detection
  and timeouts back it up for interactive situations.
- **Products are abstracted into thin profiles.** WebSocket transport is universal; framing
  (raw / JSON / base64) and DOM hints live in declarative site profiles. JumpServer ships built
  in; anything xterm.js-based works with the generic profile.

## What you get

| Brain                                | How to connect                                                 |
| ------------------------------------ | -------------------------------------------------------------- |
| Claude Code / Codex / any MCP client | `bastion-pilot mcp` (stdio) — recommended                      |
| Built-in side-panel chat             | any OpenAI-compatible endpoint (cloud or self-hosted/intranet) |

Tools exposed to agents: `list_sessions`, `send_command`, `read_output`, `wait_output`,
`send_key`, `get_screen`, `upload_file`, `download_file` — see
[docs/tools.md](./docs/tools.md) for the full contract. Every tool result is also appended to
per-session transcripts for post-incident review (`bastion-pilot transcripts`).

Safety rails:

- **Approval modes** (`auto` / `confirm` / `readonly` + allowlist), enforced on the bridge for
  _every_ brain. Default is `confirm`: each mutating command waits for your click (side panel or
  OS notification).
- **Local audit log**: one JSONL line per tool call under `~/.bastion-pilot/audit/`.
- **Read-only tool classification**: `list_sessions`, `read_output`, `wait_output`, `get_screen`
  never require approval.
- **Opt-in site access**: the extension only runs on origins you explicitly grant in its options.
- The bastion's own session recording keeps recording — BastionPilot types like a human, so your
  compliance story is unchanged.

## Quickstart

### 1. Bridge (local daemon + MCP server)

Requires Node.js ≥ 20.

```bash
git clone https://github.com/yueseqaz/bastion-pilot.git
cd bastion-pilot
pnpm install && pnpm build

# create config + pairing token, print setup instructions
node packages/bridge/dist/cli.js init

# start the daemon (keep it running; the MCP server can also auto-start it)
node packages/bridge/dist/cli.js daemon

# check connectivity at any time
node packages/bridge/dist/cli.js doctor
```

`init` creates `~/.bastion-pilot/config.json` (chmod 600) containing the pairing token, and prints
the token plus copy-paste snippets for Claude Code / Codex.

### 2. Browser extension

Chrome / Edge (Chromium ≥ 116):

1. Build it once: `pnpm --filter @bastion-pilot/extension build` (or grab the zip from GitHub
   Releases / CI artifacts and unzip it).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select
   `packages/extension/dist`.
3. Open the BastionPilot side panel (click the toolbar icon) → **⚙ Settings** → paste the daemon
   URL and pairing token → **Save** → **Test connection**.
4. Under **Bastion sites**, grant access to your bastion origin, e.g.
   `https://bastion.example.com`.

### 3. Wire up a brain

**Claude Code**

```bash
claude mcp add bastion-pilot -- node /absolute/path/to/bastion-pilot/packages/bridge/dist/cli.js mcp
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.bastion-pilot]
command = "node"
args = ["/absolute/path/to/bastion-pilot/packages/bridge/dist/cli.js", "mcp"]
```

Then, in your agent, ask something like: _"list the bastion sessions, and on web-01 check disk
usage"_. The agent will call `list_sessions`, then `send_command df -h`, read the output, and
answer — subject to your approval mode.

**Built-in side-panel chat** (optional) — add an OpenAI-compatible provider to
`~/.bastion-pilot/config.json`:

```json
{
  "providers": [
    {
      "id": "default",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-4o"
    }
  ],
  "activeProviderId": "default"
}
```

Self-hosted / intranet gateways (vLLM, Ollama's OpenAI adapter, corporate LLM gateways) work with
the same shape — the terminal output never has to leave your network if you don't want it to.
Side-panel history survives restarts: reopening the panel restores the latest conversation.

## Configuration

`~/.bastion-pilot/config.json` (created by `bastion-pilot init`):

| Key                          | Default   | Meaning                                                                |
| ---------------------------- | --------- | ---------------------------------------------------------------------- |
| `server.port`                | `8765`    | daemon listen port (always bound to `127.0.0.1`)                       |
| `security.token`             | generated | pairing token for the extension & MCP server                           |
| `approval.mode`              | `confirm` | `auto` / `confirm` / `readonly`                                        |
| `approval.confirmTimeoutMs`  | `120000`  | unanswered approvals are denied after this                             |
| `approval.readonlyAllowlist` | `[]`      | regex list; in `readonly` mode matching commands are allowed           |
| `providers[]`                | `[]`      | OpenAI-compatible providers for the built-in chat                      |
| `activeProviderId`           | `null`    | provider used by the side panel                                        |
| `agent.maxIterations`        | `30`      | loop cap for the built-in agent                                        |
| `agent.systemPrompt`         | built-in  | replace the default safety-first prompt                                |
| `output.maxInlineChars`      | `6000`    | larger outputs are truncated + saved to a file                         |
| `transcripts.enabled`        | `true`    | per-session terminal transcripts under `~/.bastion-pilot/transcripts/` |

Extension-side settings (options page): daemon URL, pairing token, granted origins and the site
profile per origin (`generic-xterm` / `jumpserver`).

## Troubleshooting

| Symptom                                    | Fix                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `doctor` says extension not connected      | Is the daemon running? Token pasted in the options page? Click the toolbar icon to wake the service worker.                      |
| Tool calls fail with "no terminal session" | Open the bastion terminal tab _after_ granting the site (or reload it). Check the origin was granted in options.                 |
| Garbled output                             | Your product frames the PTY as JSON/base64 — duplicate a profile and set `framer.type`, then select it in the options page.      |
| Agent types but nothing happens            | Some products intercept keystrokes client-side; try `inputMode: "dom"` in a custom profile.                                      |
| Long commands "time out"                   | They don't fail — pass a larger `waitMs`, or let the agent use `read_output`/`wait_output` with the returned cursor.             |
| Approval never appears                     | The daemon sends it to the extension; check the side panel and OS notifications, and confirm only one browser profile is paired. |

## Development

```bash
pnpm install
pnpm all        # build + typecheck + test + lint
pnpm test       # 86 tests across protocol / bridge / extension
pnpm --filter @bastion-pilot/extension zip   # release zip for the extension
node scripts/gen-icons.mjs                   # regenerate icons
```

Monorepo layout:

```
packages/protocol   shared wire protocol, tool contract, terminal text renderer
packages/bridge     daemon, MCP server, built-in agent loop, approvals, audit
packages/extension  MV3 extension (interceptor, controller, worker, panel, options)
profiles            docs for adapting further bastion products
```

See [docs/tools.md](./docs/tools.md) for the agent-facing tool contract and
[profiles/README.md](./profiles/README.md) for adding support for new bastion products.

## Security notes

See [SECURITY.md](./SECURITY.md). Short version: everything local is bound to `127.0.0.1` and
token-authenticated; config/audit/output files are `chmod 600`; approval policy is enforced
centrally; the bastion's own audit trail stays fully intact. **You are responsible for complying
with your company's policies** — including whether terminal output may be sent to a cloud LLM.

## Roadmap

- [x] File upload/download over the terminal (`upload_file` / `download_file`, base64 chunks)
- [x] iframe-based terminals (one session per terminal frame)
- [x] More site profiles — Teleport, Qizhi, Aliyun Bastionhost (experimental, field-test welcome)
- [x] Session transcripts replay for post-incident review (`bastion-pilot transcripts`)
- [x] npm publish-ready bridge package (`pnpm --filter bastion-pilot publish`)
- [ ] Published npm package + `npx bastion-pilot mcp` (needs the maintainer's npm account)
- [ ] Vision fallback for non-xterm terminals (Guacamole-style canvas streaming)
- [ ] Multiple terminals inside a single browser frame

## License

[MIT](./LICENSE)
