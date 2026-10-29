# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-10-29

### Fixed

- `list_sessions` now reports every hooked terminal: the service worker answers from its global
  session registry instead of relaying to a single content controller (multi-tab / multi-iframe
  discovery was broken).
- Binary WebSocket streams are only accepted as terminals when they look like PTY output
  (printable-text ratio heuristic); analytics/protobuf sockets no longer get hooked.
- File transfers abort instead of corrupting data when the terminal is busy: the exists probe,
  temp-file init and every upload batch now verify completion and exit codes.
- In-flight tool calls fail immediately when the browser disconnects, instead of hanging until
  the timeout (pending calls are now keyed by connection).
- `/health` no longer exposes session URLs (bastion tokens can leak via query strings); it
  reports a `sessionCount` instead.
- `wait_output` without an explicit cursor waits from the current end of output rather than
  replaying the whole scrollback.
- `upload_file`/`download_file` results render as human-readable text.

### Added

- Bracketed-paste command typing with a one-shot per-session probe: supported shells (bash/zsh
  with readline) receive commands wrapped in paste markers, so tabs and multi-line payloads can
  no longer be mangled by readline; unsupported shells automatically fall back to plain typing.

### Changed

- npm distribution instructions use `pnpm publish` (the manifest carries a pnpm workspace range).

## [0.2.0] - 2026-10-29

### Added

- `upload_file` / `download_file` tools: file transfer through the terminal via base64 chunks
  (heredoc batching on upload, cursor-chained capture and pure-base64 extraction on download),
  64 MB per-file cap, overwrite protection, downloads stored with mode 600.
- Per-session terminal transcripts: every tool result is appended to
  `~/.bastion-pilot/transcripts/<sessionId>.log` for post-incident replay; disable with
  `transcripts.enabled: false`; inspect with the new `bastion-pilot transcripts [id] [--tail N]`
  command.
- iframe-based terminals: content scripts now inject into all frames, so terminals embedded in
  an iframe (e.g. JumpServer luna layouts) hook as their own session, marked `· frame` in the
  side panel.
- Experimental site profiles: Teleport, Qizhi (齐治), Aliyun Bastionhost (raw xterm.js framing,
  product-specific DOM hints).
- npm publish readiness for the bridge package (`bastion-pilot`): bin, files, repository,
  engines, publishConfig and `prepublishOnly`; the bundle is fully self-contained so
  `npx bastion-pilot mcp` works once published.

### Changed

- Config gains the `transcripts.enabled` switch (default on).
- Versions bumped to 0.2.0 across the monorepo and the extension manifest.

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
