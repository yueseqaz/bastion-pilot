# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

Initial release.

### Added

- Wire protocol v1 between the daemon and its clients (browser extension, MCP server process,
  side-panel chat) with token authentication.
- Agent tool contract: `list_sessions`, `send_command`, `read_output`, `wait_output`, `send_key`,
  `get_screen`.
- Local daemon: localhost-only WS hub, approval policy (`auto`/`confirm`/`readonly` + allowlist),
  JSONL audit log, oversized-output persistence, `/health` endpoint, CLI (`daemon`, `mcp`,
  `init`, `doctor`).
- MCP stdio server for Claude Code / Codex with automatic daemon spawn.
- Built-in agent loop for OpenAI-compatible providers with SSE streaming and tool-call
  accumulation.
- MV3 browser extension: MAIN-world WebSocket interception, cursor-addressed output buffer with
  ANSI rendering, completion sentinel with exit-code extraction, side-panel chat, options page
  with opt-in site grants, approval notifications.
- Declarative site profiles (generic-xterm, JumpServer/koko) with raw/JSON/base64 framers.
- CI (lint, typecheck, 86 tests, build, extension zip artifact, tagged releases).

[0.1.0]: https://github.com/yueseqaz/bastion-pilot/releases/tag/v0.1.0
