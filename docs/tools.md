# Agent tool contract

These eight tools are exposed identically to every brain — the MCP server
(Claude Code, Codex, ...) and the built-in side-panel agent. Schemas are
enforced with zod on the bridge and validated again in the extension.

| Tool            | Kind      | Purpose                                                                          |
| --------------- | --------- | -------------------------------------------------------------------------------- |
| `list_sessions` | read-only | Discover hooked terminal tabs (one session per tab or terminal iframe).          |
| `send_command`  | mutating  | Type a command, press Enter, watch it complete.                                  |
| `read_output`   | read-only | Incremental read with a cursor.                                                  |
| `wait_output`   | read-only | Block until new output goes quiet or the timeout elapses.                        |
| `send_key`      | mutating  | Special keys: `ctrl+c`, `enter`, `esc`, arrows, ...                              |
| `get_screen`    | read-only | Text snapshot of the visible screen (alternate-screen friendly).                 |
| `upload_file`   | mutating  | Push a local file to the server through the terminal (base64 over the PTY).      |
| `download_file` | mutating  | Pull a remote file to the local machine (base64 over the PTY), returns the path. |

The file tools are orchestrated by the daemon (approval applies once for the whole transfer) and
are capped at ~64 MB per file — a terminal stream is not an SFTP replacement; use
`tar/gzip + split` for anything bigger.

## Result shapes

`send_command` returns:

```jsonc
{
  "status": "completed", // completed | quiet | timeout
  "exitCode": 0, // authoritative when status === "completed"
  "cursor": 1234, // pass to read_output / wait_output
  "text": "...", // rendered output so far (ANSI stripped)
  "hasMore": false,
}
```

Semantics the agent should rely on:

- `completed` — the sentinel printed; `exitCode` is the command's real exit code.
- `quiet` — no new output for a while; the command may still be running. Follow up with
  `wait_output` before assuming failure.
- `timeout` — output was still flowing when the wait window closed; keep reading with
  `read_output`/`wait_output`.

Oversized `text`/`screen` fields are truncated by the daemon and the full output is saved to a
local file, reported as `outputFile` in the result. Brain agents can read that path directly.

`upload_file` returns `{ remotePath, bytes }`; `download_file` returns
`{ localPath, bytes }` — the downloaded file lands in `~/.bastion-pilot/downloads/` unless an
absolute `localPath` is given, with mode 600.

## Transcripts

Every tool result carrying terminal text is appended to
`~/.bastion-pilot/transcripts/<sessionId>.log` between header lines — a replay of what the agent
saw and did, for post-incident review. Disable with `transcripts.enabled: false`. Inspect with:

```bash
bastion-pilot transcripts            # list all sessions
bastion-pilot transcripts sess_abc   # print one transcript
bastion-pilot transcripts sess_abc --tail 100
```

## Behavioral rules baked into tool descriptions

- One logical command per `send_command` (chain with `&&`/`;`); no interactive full-screen
  programs; redirect stdin for commands that would block on it.
- Never type passwords or interactive secrets — refuse and ask the human.
- Abort runaway commands with `send_key ctrl+c` instead of opening new sessions.
- All actions are audit-logged by the bastion host; never attempt to evade auditing.
