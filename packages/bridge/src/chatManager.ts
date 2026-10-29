import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnvelope, type DaemonMessage } from '@bastion-pilot/protocol';
import type { BastionPilotConfig, ProviderConfig } from './config.js';
import { AgentLoop, DEFAULT_SYSTEM_PROMPT, type ChatMessage } from './agentLoop.js';
import { SharedContext } from './sharedContext.js';

interface ChatSession {
  id: string;
  providerId: string | null;
  targetSessionId: string | null;
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
  sharedContext: SharedContext;
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

  create(providerId?: string, targetSessionId?: string, fresh = false): ChatSession {
    const resumed = fresh ? null : this.tryResumeLatest(providerId, targetSessionId);
    if (resumed) return resumed;
    const session: ChatSession = {
      id: crypto.randomUUID(),
      providerId: providerId ?? null,
      targetSessionId: targetSessionId ?? null,
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
  private tryResumeLatest(providerId?: string, targetSessionId?: string): ChatSession | null {
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
        targetSessionId?: string | null;
        messages?: ChatMessage[];
      };
      if (!parsed.chatId || !Array.isArray(parsed.messages)) return null;
      const messages = parsed.messages.filter((m) => m && m.role && typeof m.content === 'string');
      if (messages.length === 0) return null;
      const session: ChatSession = {
        id: parsed.chatId,
        providerId: providerId ?? parsed.providerId ?? null,
        targetSessionId: targetSessionId ?? parsed.targetSessionId ?? null,
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
    const messages = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content:
          m.role === 'tool' && m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content,
      }));
    return { chatId: session.id, messages };
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
    this.opts.sharedContext.append({ source: 'panel', role: 'user', content: text, chatId });
    const emit = (msg: DaemonMessage) => this.opts.emit(msg);

    try {
      const loop = new AgentLoop({
        provider,
        systemPrompt: this.opts.config.agent.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        maxIterations: this.opts.config.agent.maxIterations,
        maxRetries: this.opts.config.agent.maxRetries,
        contextToolChars: this.opts.config.agent.contextToolChars,
        executeTool: (source, tool, params) =>
          this.opts.executeTool(source, tool, this.bindTargetSession(session, tool, params)),
        renderResult: this.opts.renderResult,
        log: this.opts.log,
      });
      const sharedText = this.opts.sharedContext.promptText();
      const sharedMessage: ChatMessage | null = sharedText
        ? {
            role: 'system',
            content:
              'Shared conversation context from the local Agent and BastionPilot panel. Treat it as background only; verify live terminal state before claiming current facts:\n' +
              sharedText,
          }
        : null;
      const loopMessages = sharedMessage
        ? [
            ...session.messages.slice(0, -1),
            sharedMessage,
            session.messages[session.messages.length - 1]!,
          ]
        : session.messages;
      const result = await loop.run({
        messages: loopMessages,
        signal: session.abort.signal,
        hooks: {
          onDelta: (t) =>
            emit(
              makeEnvelope('chat_delta', { chatId, seq: ++session.seq, text: t }) as DaemonMessage
            ),
          onToolCall: (callId, tool, params) =>
            emit(makeEnvelope('chat_tool_call', { chatId, callId, tool, params }) as DaemonMessage),
          onToolResult: (callId, tool, ok, summary) => {
            this.opts.sharedContext.append({
              source: 'panel',
              role: 'tool',
              content: `${tool}: ${ok ? summary : `ERROR: ${summary}`}`,
              chatId,
            });
            emit(
              makeEnvelope('chat_tool_result', { chatId, callId, ok, summary }) as DaemonMessage
            );
          },
        },
      });
      session.messages = sharedMessage
        ? result.messages.filter((message) => message !== sharedMessage)
        : result.messages;
      const finalAssistant = [...session.messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      if (finalAssistant?.content) {
        this.opts.sharedContext.append({
          source: 'panel',
          role: 'assistant',
          content: finalAssistant.content,
          chatId,
        });
      }
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

  private bindTargetSession(
    session: ChatSession,
    tool: string,
    rawParams: unknown
  ): unknown {
    if (!session.targetSessionId || tool === 'list_sessions') return rawParams;
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return rawParams;
    // The panel's target is authoritative. The model may still call
    // list_sessions for discovery, but every terminal operation stays on the
    // user-selected session to prevent production/staging mix-ups.
    return { ...(rawParams as Record<string, unknown>), sessionId: session.targetSessionId };
  }

  private async persist(session: ChatSession): Promise<void> {
    try {
      const file = path.join(this.opts.chatsDir, `${session.id}.json`);
      await fsp.writeFile(
        file,
        JSON.stringify(
          {
            chatId: session.id,
            providerId: session.providerId,
            targetSessionId: session.targetSessionId,
            messages: session.messages,
          },
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
