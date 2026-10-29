import {
  DownloadFileResult,
  GetScreenResult,
  ListSessionsResult,
  ReadOutputResult,
  SendCommandResult,
  SendKeyResult,
  ToolName,
  UploadFileResult,
  WaitOutputResult,
  cleanCommandOutput,
} from '@bastion-pilot/protocol';

/**
 * Renders validated tool results as plain text for MCP clients / the built-in
 * agent loop. Output size is already bounded by the OutputStore before this.
 */
export function renderToolResult(tool: string, data: unknown): string {
  try {
    switch (tool) {
      case ToolName.ListSessions: {
        const r = ListSessionsResult.parse(data);
        if (r.sessions.length === 0) {
          return (
            'No bastion terminal sessions are currently hooked.\n' +
            'Ask the user to open a bastion web-terminal tab in the browser ' +
            '(the BastionPilot extension must be granted access to that site).'
          );
        }
        return (
          `${r.sessions.length} session(s):\n` +
          r.sessions
            .map(
              (s) =>
                `- [${s.sessionId}] ${s.title} — state: ${s.state}, profile: ${s.profileId}\n  ${s.url}`
            )
            .join('\n')
        );
      }
      case ToolName.SendCommand: {
        const r = SendCommandResult.parse(data);
        const status =
          r.status === 'completed'
            ? `completed (exit code ${r.exitCode ?? 'unknown'})`
            : r.status === 'quiet'
              ? 'no new output for a while — the command may still be running'
              : 'wait window elapsed while output kept flowing';
        const output = cleanCommandOutput(r.text).trim();
        return `status: ${status}\n${output || '(no output)'}${
          r.hasMore ? `\nmore output available (cursor ${r.cursor})` : ''
        }`;
      }
      case ToolName.ReadOutput: {
        const r = ReadOutputResult.parse(data);
        const output = cleanCommandOutput(r.text).trim();
        return `${output || '(no new output)'}${
          r.hasMore ? `\nmore output available (cursor ${r.nextCursor})` : ''
        }${r.dropped ? '\nwarning: older output was dropped; rerun the command' : ''}`;
      }
      case ToolName.WaitOutput: {
        const r = WaitOutputResult.parse(data);
        const status =
          r.status === 'quiet'
            ? 'output went quiet (likely finished)'
            : r.status === 'timeout'
              ? 'still producing output when the wait elapsed'
              : 'new output arrived';
        const output = cleanCommandOutput(r.text).trim();
        return `${status}\n${output || '(no new output)'}${
          r.hasMore ? `\nmore output available (cursor ${r.nextCursor})` : ''
        }`;
      }
      case ToolName.SendKey: {
        const r = SendKeyResult.parse(data);
        return r.ok ? 'key sent.' : 'failed to send key.';
      }
      case ToolName.GetScreen: {
        const r = GetScreenResult.parse(data);
        return (
          '--- screen ---\n' +
          (r.screen.trim().length > 0 ? r.screen : '(empty screen)') +
          (r.truncated ? '\n--- truncated to the requested number of lines ---' : '\n--- end ---')
        );
      }
      case ToolName.UploadFile: {
        const r = UploadFileResult.parse(data);
        return `uploaded ${r.bytes} bytes to ${r.remotePath}.`;
      }
      case ToolName.DownloadFile: {
        const r = DownloadFileResult.parse(data);
        return `downloaded ${r.bytes} bytes to ${r.localPath} (mode 600).`;
      }
      case ToolName.GetSharedContext: {
        const entries =
          (
            data as {
              entries?: Array<{
                source: string;
                role: string;
                ts: string;
                content: string;
                requestId?: string;
              }>;
            }
          ).entries ?? [];
        return entries.length === 0
          ? 'No shared conversation context yet.'
          : entries
              .map(
                (entry) =>
                  `[${entry.source}/${entry.role} ${entry.ts}${
                    entry.requestId ? ` requestId=${entry.requestId}` : ''
                  }]\n${entry.content}`
              )
              .join('\n\n');
      }
      case ToolName.AppendSharedContext:
        return 'Shared context appended for the BastionPilot panel.';
      default:
        return JSON.stringify(data, null, 2);
    }
  } catch {
    // Result did not match the schema (e.g. an older extension): dump it raw.
    return `unexpected result payload for ${tool}:\n${JSON.stringify(data, null, 2)}`;
  }
}
