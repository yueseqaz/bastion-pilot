import {
  GetScreenResult,
  ListSessionsResult,
  ReadOutputResult,
  SendCommandResult,
  SendKeyResult,
  ToolName,
  WaitOutputResult,
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
        return (
          `status: ${status}\n` +
          '--- output ---\n' +
          (r.text.trim().length > 0 ? r.text : '(no output)') +
          `\n--- end --- (cursor ${r.cursor}${r.hasMore ? ', more output available via read_output' : ''})`
        );
      }
      case ToolName.ReadOutput: {
        const r = ReadOutputResult.parse(data);
        return (
          '--- output ---\n' +
          (r.text.trim().length > 0 ? r.text : '(no new output)') +
          `\n--- end --- (nextCursor ${r.nextCursor}${r.hasMore ? ', more available' : ''}${r.dropped ? ', WARNING: older output was dropped from the retention buffer' : ''})`
        );
      }
      case ToolName.WaitOutput: {
        const r = WaitOutputResult.parse(data);
        const status =
          r.status === 'quiet'
            ? 'output went quiet (likely finished)'
            : r.status === 'timeout'
              ? 'still producing output when the wait elapsed'
              : 'new output arrived';
        return (
          `${status}\n--- output ---\n` +
          (r.text.trim().length > 0 ? r.text : '(no new output)') +
          `\n--- end --- (nextCursor ${r.nextCursor}${r.hasMore ? ', more available' : ''})`
        );
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
      default:
        return JSON.stringify(data, null, 2);
    }
  } catch {
    // Result did not match the schema (e.g. an older extension): dump it raw.
    return `unexpected result payload for ${tool}:\n${JSON.stringify(data, null, 2)}`;
  }
}
