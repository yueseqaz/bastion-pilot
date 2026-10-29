import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

export type SharedContextSource = 'panel' | 'mcp' | 'agent';
export type SharedContextRole = 'user' | 'assistant' | 'tool' | 'note';

export interface SharedContextEntry {
  id: string;
  ts: string;
  source: SharedContextSource;
  role: SharedContextRole;
  content: string;
  chatId?: string;
  /** When set, only the selected local-agent conversation receives this note. */
  targetAgentId?: string;
  /** Correlates a panel request with the local-agent response. */
  requestId?: string;
}

export interface SharedContextEvent {
  entry: SharedContextEntry;
}

/** Persistent bridge between panel chat and MCP clients. */
export class SharedContext {
  private entries: SharedContextEntry[] = [];
  private listeners = new Set<(event: SharedContextEvent) => void>();

  constructor(
    private readonly file: string,
    private readonly log: { warn(...a: unknown[]): void }
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((entry): entry is SharedContextEntry =>
          Boolean(
            entry &&
            typeof entry === 'object' &&
            typeof (entry as SharedContextEntry).content === 'string'
          )
        );
      }
    } catch {
      // A missing or corrupt context starts clean; chat transcripts remain intact.
    }
  }

  subscribe(listener: (event: SharedContextEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(input: {
    source: SharedContextSource;
    role: SharedContextRole;
    content: string;
    chatId?: string;
    targetAgentId?: string;
    requestId?: string;
  }): SharedContextEntry {
    const entry: SharedContextEntry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      source: input.source,
      role: input.role,
      content: input.content.slice(0, 20_000),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
    void this.persist();
    const event = { entry };
    for (const listener of this.listeners) listener(event);
    return entry;
  }

  recent(limit = 30): SharedContextEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(100, limit)));
  }

  recentExternal(limit = 20): SharedContextEntry[] {
    return this.recent(100)
      .filter((entry) => entry.source !== 'panel')
      .slice(-limit);
  }

  /** Context visible to a specific local-agent conversation. Untargeted notes
   * are shared; targeted notes are isolated to their selected conversation. */
  recentForAgent(agentId: string | undefined, limit = 30): SharedContextEntry[] {
    return this.recent(100)
      .filter((entry) => !entry.targetAgentId || entry.targetAgentId === agentId)
      .slice(-Math.max(1, Math.min(100, limit)));
  }

  promptText(limit = 20): string {
    const recent = this.recent(limit);
    if (recent.length === 0) return '';
    return recent
      .map((entry) => `[${entry.source}/${entry.role} ${entry.ts}]\n${entry.content}`)
      .join('\n\n');
  }

  private async persist(): Promise<void> {
    try {
      await fsp.writeFile(this.file, JSON.stringify(this.entries, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      this.log.warn('failed to persist shared context:', (err as Error).message);
    }
  }
}
