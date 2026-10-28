import { describe, expect, it } from 'vitest';
import { renderToolResult } from '../src/render.js';

describe('renderToolResult', () => {
  it('renders session lists with ids and hints', () => {
    const text = renderToolResult('list_sessions', {
      sessions: [
        {
          sessionId: 's1',
          title: 'web-01',
          url: 'https://bastion.example/terminal',
          profileId: 'generic-xterm',
          state: 'active',
          createdAt: 1,
          lastActivityAt: 2,
        },
      ],
    });
    expect(text).toContain('[s1]');
    expect(text).toContain('web-01');
  });

  it('guides the agent when no sessions exist', () => {
    const text = renderToolResult('list_sessions', { sessions: [] });
    expect(text).toContain('No bastion terminal sessions');
  });

  it('renders send_command results with status and exit code', () => {
    const text = renderToolResult('send_command', {
      status: 'completed',
      exitCode: 2,
      cursor: 12,
      text: 'ls: no such file',
      hasMore: false,
    });
    expect(text).toContain('exit code 2');
    expect(text).toContain('ls: no such file');
  });

  it('renders wait_output quiet status', () => {
    const text = renderToolResult('wait_output', {
      status: 'quiet',
      text: 'done',
      nextCursor: 5,
      hasMore: false,
    });
    expect(text).toContain('likely finished');
  });

  it('falls back to JSON dump for unknown payloads', () => {
    const text = renderToolResult('send_key', { weird: true });
    expect(text).toContain('weird');
  });
});
