import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnvelope, type DaemonMessage } from '@bastion-pilot/protocol';
import type { BastionPilotConfig, ProviderConfig } from './config.js';
import { AgentLoop, DEFAULT_SYSTEM_PROMPT, type ChatMessage } from './agentLoop.js';

interface ChatSession {
  id: string;
  providerId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  seq: number;
  abort: AbortController | null;
}

export interface ChatManagerOptions {
  config: BastionPilotConfig;
  chatsDir: string;
  executeTool: (source: 'agent' | 'panel', tool: string, params: unknown) => Promise<unknown>;
  renderResult: (tool: string, data: unknown) => string;
  emit: (msg: DaemonMessage) => void;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

/**
 * Owns the side-panel chat sessions. The loop itself lives in AgentLoop; this
 * class tracks per-chat state, persists transcripts to <chatsDir> and turns
 * loop hooks into chat_delta / chat_tool_call / chat_tool_result / chat_done
 * envelopes.
 */
export class ChatManager {
  private chats = new Map<string, ChatSession>();

  constructor(private readonly opts: ChatManagerOptions) {
    fs.mkdirSync(opts.chatsDir, { recursive: true });
  }

  create(providerId?: string): ChatSession {
    const resumed = this.tryResumeLatest(providerId);
    if (resumed) return resumed;
    const session: ChatSession = {
      id: crypto.randomUUID(),
      providerId: providerId ?? null,
      messages: [],
      busy: false,
      seq: 0,
      abort: null,
    };
    this.chats.set(session.id, session);
    return session;
  }

  /**
   * Restore the most recently persisted chat so the side panel keeps its
   * history across panel/daemon restarts. Returns null when nothing usable
   * is on disk or the caller explicitly asked for a fresh provider.
   */
  private tryResumeLatest(providerId?: string): ChatSession | null {
    try {
      const files = fs
        .readdirSync(this.opts.chatsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({
          f,
          mtime: fs.statSync(path.join(this.opts.chatsDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      const newest = files[0];
      if (!newest) return null;
      const parsed = JSON.parse(
        fs.readFileSync(path.join(this.opts.chatsDir, newest.f), 'utf8')
      ) as {
        chatId?: string;
        providerId?: string | null;
        messages?: ChatMessage[];
      };
      if (!parsed.chatId || !Array.isArray(parsed.messages)) return null;
      const messages = parsed.messages.filter((m) => m && m.role && typeof m.content === 'string');
      if (messages.length === 0) return null;
      const session: ChatSession = {
        id: parsed.chatId,
        providerId: providerId ?? parsed.providerId ?? null,
        messages,
        busy: false,
        seq: 0,
        abort: null,
      };
      this.chats.set(session.id, session);
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Compact view of a restored chat for the panel: user/assistant text in
   * full, tool results truncated (the transcript files keep everything).
   */
  replayPayload(session: ChatSession): {
    chatId: string;
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  } {
    return {
      chatId: session.id,
      messages: session.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
        .map((m) => ({
          role: m.role as 'user' | 'assistant' | 'tool',
          content:
            m.role === 'tool' && m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content,
        })),
    };
  }

  get(chatId: string): ChatSession | undefined {
    return this.chats.get(chatId);
  }

  activeProviderId(): string | null {
    return this.opts.config.activeProviderId;
  }

  providers(): Array<{ id: string; label: string; model: string }> {
    return this.opts.config.providers.map((p) => ({
      id: p.id,
      label: p.label || p.id,
      model: p.model,
    }));
  }

  async submit(chatId: string, text: string): Promise<void> {
    const session = this.chats.get(chatId);
    if (!session) throw new Error(`unknown chat ${chatId}`);
    if (session.busy) throw new Error('the assistant is still working on the previous message');
    const provider = this.pickProvider(session.providerId);
    if (!provider) {
      throw new Error(
        'no AI provider configured. Add an OpenAI-compatible provider to ' +
          '~/.bastion-pilot/config.json (providers[] + activeProviderId) or connect an ' +
          'MCP client such as Claude Code / Codex instead.'
      );
    }

    session.busy = true;
    session.abort = new AbortController();
    session.messages.push({ role: 'user', content: text });
    const emit = (msg: DaemonMessage) => this.opts.emit(msg);

    try {
      const loop = new AgentLoop({
        provider,
        systemPrompt: this.opts.config.agent.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        maxIterations: this.opts.config.agent.maxIterations,
        maxRetries: this.opts.config.agent.maxRetries,
        contextToolChars: this.opts.config.agent.contextToolChars,
        executeTool: this.opts.executeTool,
        renderResult: this.opts.renderResult,
        log: this.opts.log,
      });
      const result = await loop.run({
        messages: session.messages,
        signal: session.abort.signal,
        hooks: {
          onDelta: (t) =>
            emit(
              makeEnvelope('chat_delta', { chatId, seq: ++session.seq, text: t }) as DaemonMessage
            ),
          onToolCall: (callId, tool, params) =>
            emit(makeEnvelope('chat_tool_call', { chatId, callId, tool, params }) as DaemonMessage),
          onToolResult: (callId, _tool, ok, summary) =>
            emit(
              makeEnvelope('chat_tool_result', { chatId, callId, ok, summary }) as DaemonMessage
            ),
        },
      });
      session.messages = result.messages;
      emit(
        makeEnvelope('chat_done', {
          chatId,
          stopReason: result.stopReason,
          error: result.error,
        }) as DaemonMessage
      );
      void this.persist(session);
    } finally {
      session.busy = false;
      session.abort = null;
    }
  }

  abort(chatId: string): void {
    this.chats.get(chatId)?.abort?.abort();
  }

  private pickProvider(preferred: string | null): ProviderConfig | null {
    const providers = this.opts.config.providers;
    if (providers.length === 0) return null;
    const id = preferred ?? this.opts.config.activeProviderId;
    return providers.find((p) => p.id === id) ?? providers[0]!;
  }

  private async persist(session: ChatSession): Promise<void> {
    try {
      const file = path.join(this.opts.chatsDir, `${session.id}.json`);
      await fsp.writeFile(
        file,
        JSON.stringify(
          { chatId: session.id, providerId: session.providerId, messages: session.messages },
          null,
          2
        ),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (err) {
      this.opts.log.warn('failed to persist chat:', (err as Error).message);
    }
  }
}
