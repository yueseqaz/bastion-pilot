import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentLoop,
  DEFAULT_SYSTEM_PROMPT,
  LIVE_STATE_POLICY,
  needsLiveCommand,
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
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'done' });
    expect(bodies[0]!.messages[0]).toEqual({
      role: 'system',
      content: `OPERATOR-SYS\n\n${LIVE_STATE_POLICY}`,
    });
    expect(bodies[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('falls back to the built-in system prompt', async () => {
    let body: { messages: Array<{ role: string; content: string }> } | null = null;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    });
    await makeLoop().run({ messages: [{ role: 'user', content: 'x' }], signal: abort(), hooks });
    expect(body!.messages[0]!.content).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\n${LIVE_STATE_POLICY}`);
  });

  it('streams JSON replies as well as persisting them', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ choices: [{ message: { content: '你好' } }] })
    );
    const onDelta = vi.fn();
    const result = await makeLoop().run({
      messages: [{ role: 'user', content: '你好' }],
      signal: abort(),
      hooks: { ...hooks, onDelta },
    });
    expect(onDelta).toHaveBeenCalledWith('你好');
    expect(result.messages.at(-1)?.content).toBe('你好');
  });

  it('handles gateways returning JSON despite requesting streaming', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ choices: [{ message: { content: '完整回答' } }] })
    );
    const onDelta = vi.fn();
    const result = await makeLoop({ provider: { ...provider, stream: true } }).run({
      messages: [{ role: 'user', content: '你好' }],
      signal: abort(),
      hooks: { ...hooks, onDelta },
    });
    expect(onDelta).toHaveBeenCalledWith('完整回答');
    expect(result.messages.at(-1)?.content).toBe('完整回答');
  });

  it('rechecks sessions and executes a command despite a historical directory answer', async () => {
    const bodies: Array<{
      tool_choice?: { function: { name: string } };
      messages: Array<{ role: string; content: string }>;
    }> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const name = bodies.length === 1 ? 'list_sessions' : 'send_command';
      return Response.json({
        choices: [
          {
            message:
              bodies.length <= 2
                ? {
                    tool_calls: [
                      {
                        id: `call_${bodies.length}`,
                        function: {
                          name,
                          arguments:
                            name === 'send_command'
                              ? '{"sessionId":"fresh-session","command":"pwd"}'
                              : '{}',
                        },
                      },
                    ],
                  }
                : { content: '当前目录是 /new-directory' },
          },
        ],
      });
    });
    const executeTool = vi.fn(async (_source: string, tool: string) =>
      tool === 'list_sessions'
        ? { sessions: [{ sessionId: 'fresh-session' }] }
        : { text: '/new-directory', exitCode: 0 }
    );
    const messages = [
      { role: 'user' as const, content: '看看目录' },
      { role: 'assistant' as const, content: '旧目录是 /old-directory' },
      { role: 'user' as const, content: '你好 看看当前所处目录' },
    ];
    const before = JSON.stringify(messages);
    const result = await makeLoop({
      executeTool,
      renderResult: (_tool, data) => JSON.stringify(data),
    }).run({ messages, signal: abort(), hooks });
    expect(bodies[0]?.tool_choice?.function.name).toBe('list_sessions');
    expect(bodies[1]?.tool_choice?.function.name).toBe('send_command');
    expect(bodies[2]?.tool_choice).toBeUndefined();
    expect(executeTool).toHaveBeenCalledWith('agent', 'send_command', {
      sessionId: 'fresh-session',
      command: 'pwd',
    });
    expect(bodies[0]?.messages.at(-2)?.content).toContain('CURRENT USER TURN');
    expect(JSON.stringify(messages)).toBe(before);
    expect(result.messages.at(-1)?.content).toContain('/new-directory');
  });

  it('blocks and does not stream an unverified answer when the provider ignores tool_choice', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ choices: [{ message: { content: '当前目录是 /old-directory' } }] })
    );
    const onDelta = vi.fn();
    const result = await makeLoop().run({
      messages: [{ role: 'user', content: '看看当前目录' }],
      signal: abort(),
      hooks: { ...hooks, onDelta },
    });
    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('未执行本轮实时核验');
    expect(onDelta).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(1);
  });

  it('allows reporting no session instead of forcing a command against a historical session', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () =>
      Response.json({
        choices: [
          {
            message:
              ++calls === 1
                ? {
                    tool_calls: [
                      { id: 'sessions', function: { name: 'list_sessions', arguments: '{}' } },
                    ],
                  }
                : { content: '没有已连接的终端，无法确认当前目录。' },
          },
        ],
      })
    );
    const executeTool = vi.fn(async () => ({ sessions: [] }));
    const result = await makeLoop({ executeTool }).run({
      messages: [{ role: 'user', content: '当前目录' }],
      signal: abort(),
      hooks,
    });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('end');
    expect(result.messages.at(-1)?.content).toContain('无法确认');
  });

  it('rejects commands using an old session before current session discovery', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'old',
                  function: {
                    name: 'send_command',
                    arguments: '{"sessionId":"old-session","command":"pwd"}',
                  },
                },
              ],
            },
          },
        ],
      })
    );
    const executeTool = vi.fn();
    const result = await makeLoop({ executeTool }).run({
      messages: [{ role: 'user', content: '看看当前目录' }],
      signal: abort(),
      hooks,
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('error');
  });

  it('distinguishes common live requests from greetings and historical explanations', () => {
    for (const text of [
      '你好 看看当前所处目录',
      '有哪些文件',
      '服务是否运行',
      'pwd',
      'check disk usage',
      '再查一下磁盘',
    ])
      expect(needsLiveCommand(text)).toBe(true);
    for (const text of [
      '你好',
      'pwd 是什么意思',
      '解释一下之前的日志',
      '上次目录是什么',
      '不要执行命令，只解释 pwd',
      '解释一下服务的架构',
    ])
      expect(needsLiveCommand(text)).toBe(false);
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
