import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentLoop,
  DEFAULT_SYSTEM_PROMPT,
  type AgentLoopOptions,
  type LoopHooks,
} from '../src/agentLoop.js';
import type { ProviderConfig } from '../src/config.js';

const provider: ProviderConfig = {
  id: 'test',
  baseUrl: 'https://provider.test/v1',
  apiKey: 'key',
  model: 'test-model',
  stream: false, // JSON path — no SSE parsing needed for these tests
};

const hooks: LoopHooks = { onDelta() {}, onToolCall() {}, onToolResult() {} };
const silentLog = { info() {}, warn() {}, error() {} };

function makeLoop(overrides: Partial<AgentLoopOptions> = {}): AgentLoop {
  return new AgentLoop({
    provider,
    executeTool: async () => {
      throw new Error('no tools in this test');
    },
    renderResult: () => '',
    log: silentLog,
    ...overrides,
  });
}

function abort(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentLoop provider calls', () => {
  it('sends the configured system prompt with every request', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: 'done' } }] });
    });
    const result = await makeLoop({ systemPrompt: 'OPERATOR-SYS' }).run({
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort(),
      hooks,
    });
    expect(result.stopReason).toBe('end');
    expect(bodies[0]!.messages[0]).toEqual({ role: 'system', content: 'OPERATOR-SYS' });
    expect(bodies[0]!.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('falls back to the built-in system prompt', async () => {
    let body: { messages: Array<{ role: string; content: string }> } | null = null;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    });
    await makeLoop().run({ messages: [{ role: 'user', content: 'x' }], signal: abort(), hooks });
    expect(body!.messages[0]!.content).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('retries transient 5xx/429 failures and recovers', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) return new Response('boom', { status: 503 });
      if (calls === 2) return new Response('slow down', { status: 429 });
      return Response.json({ choices: [{ message: { content: 'recovered' } }] });
    });
    const result = await makeLoop({ maxRetries: 3 }).run({
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort(),
      hooks,
    });
    expect(result.stopReason).toBe('end');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable 4xx errors', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('bad key', { status: 401 });
    });
    const result = await makeLoop().run({
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort(),
      hooks,
    });
    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('401');
    expect(calls).toBe(1);
  });

  it('gives up after the configured retry budget', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('down', { status: 500 });
    });
    const result = await makeLoop({ maxRetries: 2 }).run({
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort(),
      hooks,
    });
    expect(result.stopReason).toBe('error');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('trims stale tool results but keeps the recent ones intact', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    });
    const big = 'x'.repeat(5_000);
    const messages = [
      { role: 'user' as const, content: 'go' },
      { role: 'tool' as const, content: big }, // stale (7 tools, keep 6)
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'tool' as const, content: `t${i}` })),
    ];
    await makeLoop({ contextToolChars: 1_000 }).run({ messages, signal: abort(), hooks });
    const requestTools = bodies[0]!.messages.filter((m) => m.role === 'tool');
    expect(requestTools).toHaveLength(7);
    const trimmed = requestTools.find((m) => m.content.startsWith('x'))!;
    expect(trimmed.content).toContain('truncated for context');
    expect(trimmed.content.length).toBeLessThan(1_200);
    expect(requestTools.filter((m) => /^t\d$/.test(m.content))).toHaveLength(6);
  });
});
