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

  it('preserves local-agent request correlation metadata', () => {
    const env = makeEnvelope('shared_context_append', {
      role: 'assistant',
      content: 'done',
      targetAgentId: 'codex-1',
      requestId: 'req-1',
    });
    const parsed = parseClientMessage(JSON.parse(JSON.stringify(env)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'shared_context_append') {
      expect(parsed.message.payload.requestId).toBe('req-1');
    }
  });

  it('round-trips a provider model discovery request', () => {
    const request = makeEnvelope('provider_models_get', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret',
    });
    const parsedRequest = parseClientMessage(JSON.parse(JSON.stringify(request)));
    expect(parsedRequest.ok).toBe(true);

    const response = makeEnvelope('provider_models', { models: ['alpha', 'beta'] });
    const parsedResponse = parseDaemonMessage(JSON.parse(JSON.stringify(response)));
    expect(parsedResponse.ok).toBe(true);
  });

  it('validates every tool schema accepts a minimal call and rejects garbage', () => {
    for (const name of TOOL_NAMES) {
      const schema = toolSchema(name);
      expect(schema.safeParse({}).success).toBe(
        name === 'list_sessions' || name === 'get_shared_context'
      );
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
