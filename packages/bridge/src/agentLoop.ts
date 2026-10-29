import { TOOLS, toolSchema, type ToolDescriptor, type ToolName } from '@bastion-pilot/protocol';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ProviderConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
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

export const LIVE_STATE_POLICY = `History is background knowledge, never proof of the current terminal state.
- For every request to inspect or operate the server, discover the current sessions again and execute the relevant command in THIS user turn before stating a result. A previous successful command is not verification for a new turn.
- For the current directory run pwd; for current files run ls; verify service, process, disk, network and log state with the corresponding live command. Never infer a path from a prompt, username, old tool output or a previous assistant answer.
- If execution is denied, fails, is stopped, or no session is available, explicitly say the current state could not be confirmed. Do not substitute historical results or claim a command ran when it did not.
- Historical results may explain background and earlier decisions. Clearly label any explicitly requested historical information as historical, not current.
- Do not repeat modifying commands merely to refresh state. Verify their effects with read-only commands. Prefer read-only inspection and preserve the approval policy.
- Reply in Chinese unless the user requests another language.`;

/** A backstop for common live-state requests; the policy applies to all turns. */
export function needsLiveCommand(text: string): boolean {
  if (/^(?:你好|您好|hi|hello|谢谢|thanks)[!！。,.，\s]*$/i.test(text)) return false;
  if (
    /不要执行|不用执行|无需执行|别执行|不要运行|不要操作|只解释|仅解释|do not (?:run|execute)|don't (?:run|execute)/i.test(
      text
    )
  )
    return false;
  if (
    /历史|上次|之前|刚才|解释|什么意思|怎么用|如何使用|示例|举例|原理|概念|知识|背景|架构|what (?:does|is).*mean/i.test(
      text
    ) &&
    !/重新|再查|执行|运行|现在|当前|实时|检查|查看|看看/.test(text)
  )
    return false;
  return /目录|文件夹|文件|服务器|磁盘|进程|服务|日志|端口|内存|负载|网络|检查|查看|看看|执行|运行|\b(?:pwd|ls|df|ps|du|systemctl|uptime|free|whoami|check|inspect|run|execute|current|directory|files|disk|process|service|logs|ports)\b/i.test(
    text
  );
}

export interface AgentLoopOptions {
  provider: ProviderConfig;
  tools?: ToolDescriptor[];
  systemPrompt?: string;
  maxIterations?: number;
  /** Retries for transient provider failures (429 / 5xx / network). Default 2. */
  maxRetries?: number;
  /**
   * Truncate tool results older than the last 6 in the request context to
   * this many characters (0 disables trimming). Default 2000. Session
   * transcripts keep the full text either way.
   */
  contextToolChars?: number;
  executeTool: (source: 'agent' | 'panel', tool: string, params: unknown) => Promise<unknown>;
  renderResult: (tool: string, data: unknown) => string;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

/** HTTP failure from the provider, carrying the status for retry decisions. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const CONTEXT_KEEP_RECENT_TOOLS = 6;

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
    const lastUser = [...work].reverse().find((message) => message.role === 'user');
    let requireLive = needsLiveCommand(lastUser?.content ?? '');
    let discovered = false;
    const maxIterations = this.opts.maxIterations ?? 30;
    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (input.signal.aborted) return { messages: work, stopReason: 'aborted' };

        const requiredTool = requireLive
          ? discovered
            ? 'send_command'
            : 'list_sessions'
          : undefined;
        // Do not stream an unverified answer if a provider ignores tool_choice.
        const responseHooks = requiredTool ? { ...input.hooks, onDelta() {} } : input.hooks;
        const { content, toolCalls } = await this.chat(
          work,
          input.signal,
          responseHooks,
          requiredTool
        );
        if (input.signal.aborted) return { messages: work, stopReason: 'aborted' };

        if (requiredTool && (toolCalls.length !== 1 || toolCalls[0]?.name !== requiredTool)) {
          return {
            messages: work,
            stopReason: 'error',
            error: 'AI 未执行本轮实时核验，无法确认当前状态。请重试，或检查模型是否支持工具调用。',
          };
        }

        if (toolCalls.length === 0) {
          // Keep the final assistant turn in the persisted transcript even
          // when the model answers without invoking a tool.
          work.push({ role: 'assistant', content: content ?? '' });
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
            if (tc.name === 'list_sessions') {
              discovered = true;
              const sessions = (data as { sessions?: unknown[] } | null)?.sessions;
              if (Array.isArray(sessions) && sessions.length === 0) requireLive = false;
            }
          } catch (err) {
            ok = false;
            text = `ERROR: ${(err as Error).message}`;
            // Report a failed/denied observation instead of looping or using old data.
            requireLive = false;
          }
          if (tc.name === 'send_command') requireLive = false;
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

  /**
   * Provider call with retries. Transient failures (429 / 5xx / network) are
   * retried with exponential backoff — but only while nothing has been
   * streamed to the user yet, so a mid-stream failure never duplicates output.
   */
  private async chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    hooks: LoopHooks,
    requiredTool?: string
  ): Promise<{ content: string | null; toolCalls: AccumulatedToolCall[] }> {
    const maxRetries = this.opts.maxRetries ?? 2;
    let emitted = false;
    const guardedHooks: LoopHooks = {
      ...hooks,
      onDelta: (text) => {
        emitted = true;
        hooks.onDelta(text);
      },
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.chatOnce(messages, signal, guardedHooks, requiredTool);
      } catch (err) {
        if (signal.aborted || emitted || attempt >= maxRetries || !this.isRetryable(err)) {
          throw err;
        }
        const delay = Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        this.opts.log.warn(
          `provider call failed (${(err as Error).message.slice(0, 120)}); retrying in ${delay}ms ` +
            `(attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof ProviderHttpError) return err.status === 429 || err.status >= 500;
    return err instanceof TypeError; // fetch() network failure
  }

  /** Cap older tool results so long sessions do not blow up the context. */
  private trimForContext(messages: ChatMessage[]): ChatMessage[] {
    const maxChars = this.opts.contextToolChars ?? 2_000;
    if (maxChars <= 0) return messages;
    const toolIndices = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    const stale = new Set(
      toolIndices.slice(0, Math.max(0, toolIndices.length - CONTEXT_KEEP_RECENT_TOOLS))
    );
    return messages.map((m, i) => {
      if (!stale.has(i) || m.content.length <= maxChars) return m;
      return {
        ...m,
        content:
          m.content.slice(0, maxChars) +
          `\n[...truncated for context (${m.content.length} chars total) — re-run the command or read_output if you need the rest...]`,
      };
    });
  }

  private async chatOnce(
    messages: ChatMessage[],
    signal: AbortSignal,
    hooks: LoopHooks,
    requiredTool?: string
  ): Promise<{ content: string | null; toolCalls: AccumulatedToolCall[] }> {
    const { provider } = this.opts;
    const base = provider.baseUrl.replace(/\/+$/, '');
    const stream = provider.stream !== false;
    const systemPrompt = this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const context = this.trimForContext(messages);
    let turnStart = context.length - 1;
    while (turnStart >= 0 && context[turnStart]?.role !== 'user') turnStart--;
    // The boundary is request-only: never alter persisted history or tool-call pairs.
    const markedContext =
      turnStart < 0
        ? context
        : [
            ...context.slice(0, turnStart),
            {
              role: 'system',
              content:
                'CURRENT USER TURN STARTS HERE. Everything before this boundary is historical background, not a current observation. Only tool results after this boundary can verify the current state.',
            },
            ...context.slice(turnStart),
          ];
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\n${LIVE_STATE_POLICY}` },
        ...markedContext,
      ],
      tools: this.toolsParam,
      stream,
    };
    if (requiredTool) body.tool_choice = { type: 'function', function: { name: requiredTool } };
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
      throw new ProviderHttpError(res.status, `provider returned HTTP ${res.status}: ${detail}`);
    }

    if (!stream || !res.body || res.headers.get('content-type')?.includes('application/json')) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
      };
      const message = json.choices?.[0]?.message;
      const toolCalls = normalizeToolCalls(message?.tool_calls ?? []);
      if (message?.content) hooks.onDelta(message.content);
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
