import { describe, expect, it } from 'vitest';
import { makeEnvelope, parseClientMessage, parseDaemonMessage } from '../src/messages.js';
import { TOOL_NAMES, toolSchema } from '../src/tools.js';

describe('messages', () => {
  it('round-trips a hello message', () => {
    const env = makeEnvelope('hello', {
      token: 't',
      role: 'extension',
      name: 'BastionPilot',
      version: '0.1.0',
    });
    const parsed = parseClientMessage(JSON.parse(JSON.stringify(env)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'hello') {
      expect(parsed.message.payload.role).toBe('extension');
    } else {
      expect.unreachable('should have parsed as hello');
    }
  });

  it('rejects unknown client message types', () => {
    const env = makeEnvelope('bogus', {});
    const parsed = parseClientMessage(JSON.parse(JSON.stringify(env)));
    expect(parsed.ok).toBe(false);
  });

  it('rejects malformed tool_result payloads', () => {
    const env = makeEnvelope('tool_result', { callId: 42 });
    const parsed = parseClientMessage(JSON.parse(JSON.stringify(env)));
    expect(parsed.ok).toBe(false);
  });

  it('round-trips daemon tool_call', () => {
    const env = makeEnvelope('tool_call', {
      callId: 'c1',
      source: 'mcp',
      tool: 'send_command',
      params: { sessionId: 's1', command: 'ls' },
    });
    const parsed = parseDaemonMessage(JSON.parse(JSON.stringify(env)));
    expect(parsed.ok).toBe(true);
  });

  it('validates every tool schema accepts a minimal call and rejects garbage', () => {
    for (const name of TOOL_NAMES) {
      const schema = toolSchema(name);
      expect(schema.safeParse({}).success).toBe(name === 'list_sessions');
    }
    expect(toolSchema('send_command').safeParse({ sessionId: 's', command: 'ls' }).success).toBe(
      true
    );
    expect(toolSchema('send_command').safeParse({ sessionId: 's' }).success).toBe(false);
    expect(toolSchema('send_key').safeParse({ sessionId: 's', key: 'ctrl+space' }).success).toBe(
      false
    );
  });
});
