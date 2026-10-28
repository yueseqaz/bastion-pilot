# Security Policy

BastionPilot is a security-sensitive tool by design: it drives interactive sessions on production
servers. This document explains the threat model and the controls, and how to report issues.

## Threat model

| Asset                             | Controls                                                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon WebSocket                  | Bound to `127.0.0.1` only; every client must present the pairing token from `~/.bastion-pilot/config.json`.                                                                                                                                                                      |
| Pairing token / provider API keys | Stored in `config.json` with mode `600`, created on first `bastion-pilot init`. Never logged, never sent anywhere except your configured AI provider.                                                                                                                            |
| Extension access                  | Strictly opt-in: content scripts are registered only for origins the user granted via `chrome.permissions` (options page). Revoking removes injection.                                                                                                                           |
| Tool execution                    | Approval policy enforced on the daemon for **every** brain: `readonly` (default-deny with allowlist), `confirm` (explicit per-command approval via side panel/notification, timeout = deny), `auto`.                                                                             |
| Audit trail                       | One JSONL line per tool call in `~/.bastion-pilot/audit/` (time, source, tool, params, result, duration). The bastion host's own session recording is untouched — BastionPilot types like a human.                                                                               |
| Terminal output                   | Oversized outputs are truncated for the model; full text is written to `~/.bastion-pilot/outputs/` with mode `600`. Where that output goes next (a cloud LLM) is the user's compliance decision — use `providers[].baseUrl` pointing at an intranet gateway to keep data on-net. |
| Chat transcripts                  | Written to `~/.bastion-pilot/chats/` with mode `600`.                                                                                                                                                                                                                            |

## Residual risks (known, by design)

- In `auto` approval mode, a compromised or misguided AI brain can run arbitrary commands on
  servers reachable through your bastion session. Use `confirm` or `readonly` for production.
- Anyone with local user-level code execution can read `config.json` (it is mode `600`, same
  trust boundary as your SSH keys).
- The extension can only act on terminals the logged-in user has already opened; it cannot
  escalate bastion permissions.

## Reporting a vulnerability

Open a private security advisory via GitHub ("Report a vulnerability" on the Security tab) or
contact the maintainers directly. Please do not open public issues for exploitable findings.
