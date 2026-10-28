import crypto from 'node:crypto';
import { ToolName } from '@bastion-pilot/protocol';

const READONLY_TOOLS = new Set<string>([
  ToolName.ListSessions,
  ToolName.ReadOutput,
  ToolName.WaitOutput,
  ToolName.GetScreen,
]);

export interface ApprovalPolicy {
  mode: 'auto' | 'confirm' | 'readonly';
  confirmTimeoutMs?: number;
  readonlyAllowlist?: string[];
}

export interface ApprovalRequest {
  requestId: string;
  source: string;
  tool: string;
  sessionId?: string;
  summary: string;
  expiresAt: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
}

export type UserApprovalGate = (req: ApprovalRequest) => Promise<boolean>;

export function isReadonlyTool(tool: string): boolean {
  return READONLY_TOOLS.has(tool);
}

export function summarizeToolCall(tool: string, params: Record<string, unknown>): string {
  if (tool === ToolName.SendCommand && typeof params.command === 'string') {
    const cmd = params.command.length > 200 ? params.command.slice(0, 200) + '…' : params.command;
    return `command: ${cmd}`;
  }
  if (tool === ToolName.SendKey && typeof params.key === 'string') {
    return `key press: ${params.key}`;
  }
  if (tool === ToolName.SendCommand || tool === ToolName.SendKey) {
    return `tool ${tool} (missing parameters)`;
  }
  return `tool ${tool}`;
}

/**
 * Enforces the approval policy for every tool call, regardless of which brain
 * (MCP client or built-in agent) requested it:
 * - auto:     everything runs without confirmation.
 * - confirm:  mutating tools wait for an explicit user approval (with timeout).
 * - readonly: mutating tools are blocked unless the command matches the
 *             configured allowlist.
 */
export class ApprovalEngine {
  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly gate: UserApprovalGate | null,
  ) {}

  async check(
    source: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    if (isReadonlyTool(tool)) {
      return { approved: true, reason: 'read-only tool' };
    }
    const summary = summarizeToolCall(tool, params);
    switch (this.policy.mode) {
      case 'auto':
        return { approved: true, reason: 'policy: auto' };
      case 'readonly': {
        const target =
          tool === ToolName.SendCommand && typeof params.command === 'string'
            ? params.command
            : tool === ToolName.SendKey && typeof params.key === 'string'
              ? `key:${params.key}`
              : '';
        const allowlist = this.policy.readonlyAllowlist ?? [];
        const allowed = allowlist.some((pattern) => {
          try {
            return new RegExp(pattern).test(target);
          } catch {
            return false; // an invalid regex in config must never open the gates
          }
        });
        return allowed
          ? { approved: true, reason: 'policy: readonly allowlist' }
          : {
              approved: false,
              reason:
                `approval policy is "readonly" and blocked "${summary}". ` +
                'Ask the user to switch the approval mode or add a readonlyAllowlist entry.',
            };
      }
      case 'confirm': {
        const timeoutMs = this.policy.confirmTimeoutMs ?? 120_000;
        if (!this.gate) {
          return { approved: false, reason: 'policy: confirm, but no user interface is connected' };
        }
        const request: ApprovalRequest = {
          requestId: crypto.randomUUID(),
          source,
          tool,
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
          summary,
          expiresAt: Date.now() + timeoutMs,
        };
        const approved = await Promise.race([
          this.gate(request).catch(() => false),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        return {
          approved,
          reason: approved ? 'approved by user' : 'denied by user or confirmation timed out',
        };
      }
    }
  }
}
