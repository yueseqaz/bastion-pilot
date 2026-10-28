import {
  TOOLS,
  toolSchema,
  type ToolDescriptor,
  type ToolName,
} from '@bastion-pilot/protocol';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ProviderConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface LoopHooks {
  onDelta(text: string): void;
  onToolCall(callId: string, tool: string, params: unknown): void;
  onToolResult(callId: string, tool: string, ok: boolean, summary: string): void;
}

export interface LoopResult {
  messages: ChatMessage[];
  stopReason: 'end' | 'aborted' | 'error' | 'max_iterations';
  error?: string;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are BastionPilot, an assistant that operates bastion-host web terminals on behalf of the user through a browser extension.

Rules:
- Always call list_sessions first and pick the session matching the host the user means.
- Prefer read-only commands (cat, grep, df, ps, systemctl status) before mutating ones.
- One logical command per send_command call; chain with && or ; if needed.
- Read the output carefully before acting. If a command is still streaming, use wait_output or read_output instead of re-running it.
- Never type passwords or interactive secrets. If a command prompts for credentials, abort with send_key ctrl+c and ask the user to handle authentication themselves.
- Abort runaway commands with send_key ctrl+c instead of opening new sessions.
- Every action is audit-logged by the bastion host. Act with the care of a production operator and explain what you are doing.`;

export interface AgentLoopOptions {
  provider: ProviderConfig;
  tools?: ToolDescriptor[];
  systemPrompt?: string;
  maxIterations?: number;
  executeTool: (source: 'agent' | 'panel', tool: string, params: unknown) => Promise<unknown>;
  renderResult: (tool: string, data: unknown) => string;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

/** Built-in brain: an OpenAI-compatible tool-calling loop with SSE streaming. */
export class AgentLoop {
  private readonly toolDefs: ToolDescriptor[];
  private readonly toolsParam: unknown[];

  constructor(private readonly opts: AgentLoopOptions) {
    this.toolDefs = opts.tools ?? TOOLS;
    this.toolsParam = this.toolDefs.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(toolSchema(t.name as ToolName), { $refStrategy: 'none' }),
      },
    }));
  }

  async run(input: {
    messages: ChatMessage[];
    signal: AbortSignal;
    hooks: LoopHooks;
  }): Promise<LoopResult> {
    const work: ChatMessage[] = [...input.messages];
    const maxIterations = this.opts.maxIterations ?? 30;
    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (input.signal.aborted) return { messages: work, stopReason: 'aborted' };

        const { content, toolCalls } = await this.chat(work, input.signal, input.hooks);

        if (toolCalls.length === 0) {
          return { messages: work, stopReason: 'end' };
        }

        work.push({
          role: 'assistant',
          content: content ?? '',
          tool_calls: toolCalls.map((tc, i) => ({
            id: tc.id || `call_${i}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (let i = 0; i < toolCalls.length; i++) {
          if (input.signal.aborted) return { messages: work, stopReason: 'aborted' };
          const tc = toolCalls[i]!;
          const callId = tc.id || `call_${i}`;
          let params: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(tc.arguments || '{}');
            if (parsed && typeof parsed === 'object') params = parsed as Record<string, unknown>;
          } catch {
            /* fall through with empty params; executor reports the schema error */
          }
          input.hooks.onToolCall(callId, tc.name, params);
          let ok = true;
          let text: string;
          try {
            const data = await this.opts.executeTool('agent', tc.name, params);
            text = this.opts.renderResult(tc.name, data);
          } catch (err) {
            ok = false;
            text = `ERROR: ${(err as Error).message}`;
          }
          input.hooks.onToolResult(callId, tc.name, ok, summarizeForPanel(text));
          work.push({ role: 'tool', tool_call_id: callId, content: text });
        }
      }
      return { messages: work, stopReason: 'max_iterations' };
    } catch (err) {
      if (input.signal.aborted) return { messages: work, stopReason: 'aborted' };
      this.opts.log.error('agent loop failed:', (err as Error).message);
      return { messages: work, stopReason: 'error', error: (err as Error).message };
    }
  }

  private async chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    hooks: LoopHooks,
  ): Promise<{ content: string | null; toolCalls: AccumulatedToolCall[] }> {
    const { provider } = this.opts;
    const base = provider.baseUrl.replace(/\/+$/, '');
    const stream = provider.stream !== false;
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      tools: this.toolsParam,
      stream,
    };
    if (provider.temperature !== undefined) body.temperature = provider.temperature;
    if (provider.maxTokens !== undefined) body.max_tokens = provider.maxTokens;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`provider returned HTTP ${res.status}: ${detail}`);
    }

    if (!stream || !res.body) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
      };
      const message = json.choices?.[0]?.message;
      const toolCalls = normalizeToolCalls(message?.tool_calls ?? []);
      return { content: message?.content ?? null, toolCalls };
    }

    // SSE streaming
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls = new Map<number, AccumulatedToolCall>();
    const order: number[] = [];

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          hooks.onDelta(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCalls.has(index)) {
              toolCalls.set(index, { id: '', name: '', arguments: '' });
              order.push(index);
            }
            const acc = toolCalls.get(index)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }
    }

    return {
      content: content.length > 0 ? content : null,
      toolCalls: order
        .sort((a, b) => a - b)
        .map((i) => toolCalls.get(i)!)
        .filter((tc) => tc.name.length > 0),
    };
  }
}

function normalizeToolCalls(raw: unknown[]): AccumulatedToolCall[] {
  const out: AccumulatedToolCall[] = [];
  for (const item of raw) {
    const tc = item as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    if (tc?.function?.name) {
      out.push({
        id: tc.id ?? '',
        name: tc.function.name,
        arguments: tc.function.arguments ?? '',
      });
    }
  }
  return out;
}

export function summarizeForPanel(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}
