import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_HOME_DIR = path.join(os.homedir(), '.bastion-pilot');

/** Config home; overridable for tests and power users. */
export function resolveHome(): string {
  return process.env.BASTION_PILOT_HOME || DEFAULT_HOME_DIR;
}

export type ApprovalMode = 'auto' | 'confirm' | 'readonly';

export interface ProviderConfig {
  id: string;
  label?: string;
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  /** Require a visible user approval for every terminal-affecting tool. */
  requireUserApproval?: boolean;
  confirmTimeoutMs?: number;
  /** Legacy regex sources; only used when strict approval is explicitly disabled. */
  readonlyAllowlist?: string[];
}

export interface BastionPilotConfig {
  server: { port: number };
  security: { token: string };
  approval: ApprovalConfig;
  providers: ProviderConfig[];
  activeProviderId: string | null;
  agent: {
    maxIterations: number;
    systemPrompt?: string;
    maxRetries: number;
    contextToolChars: number;
  };
  output: { maxInlineChars: number };
  transcripts: { enabled: boolean };
}

const providerSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

const configSchema = z.object({
  server: z.object({ port: z.number().int().min(0).max(65_535) }).optional(),
  security: z.object({ token: z.string().min(8) }).optional(),
  approval: z
    .object({
      mode: z.enum(['auto', 'confirm', 'readonly']).optional(),
      requireUserApproval: z.boolean().optional(),
      confirmTimeoutMs: z.number().int().positive().optional(),
      readonlyAllowlist: z.array(z.string()).optional(),
    })
    .optional(),
  providers: z.array(providerSchema).optional(),
  activeProviderId: z.string().nullable().optional(),
  agent: z
    .object({
      maxIterations: z.number().int().min(1).max(100).optional(),
      systemPrompt: z.string().optional(),
      maxRetries: z.number().int().min(0).max(10).optional(),
      contextToolChars: z.number().int().min(0).optional(),
    })
    .optional(),
  output: z.object({ maxInlineChars: z.number().int().min(500) }).optional(),
  transcripts: z.object({ enabled: z.boolean() }).optional(),
});

export function defaultConfig(): BastionPilotConfig {
  return {
    server: { port: 8765 },
    security: { token: crypto.randomBytes(24).toString('hex') },
    approval: {
      mode: 'confirm',
      requireUserApproval: true,
      confirmTimeoutMs: 120_000,
      readonlyAllowlist: [],
    },
    providers: [],
    activeProviderId: null,
    agent: { maxIterations: 30, maxRetries: 2, contextToolChars: 2_000 },
    output: { maxInlineChars: 6000 },
    transcripts: { enabled: true },
  };
}

function mergeConfig(
  base: BastionPilotConfig,
  user: z.infer<typeof configSchema>
): BastionPilotConfig {
  // Keep old explicit `auto`/`readonly` configs working during migration.
  // Fresh installs use the strict default; users must explicitly opt out by
  // setting requireUserApproval to false in their config.
  const approval = {
    ...base.approval,
    ...user.approval,
    ...(user.approval?.requireUserApproval === undefined && user.approval?.mode
      ? { requireUserApproval: user.approval.mode === 'confirm' }
      : {}),
  };
  return {
    server: { ...base.server, ...user.server },
    security: { ...base.security, ...user.security },
    approval,
    providers: user.providers ?? base.providers,
    activeProviderId:
      user.activeProviderId !== undefined ? user.activeProviderId : base.activeProviderId,
    agent: { ...base.agent, ...user.agent },
    output: { ...base.output, ...user.output },
    transcripts: { ...base.transcripts, ...user.transcripts },
  };
}

export function configPaths(home: string) {
  return {
    home,
    config: path.join(home, 'config.json'),
    auditDir: path.join(home, 'audit'),
    outputsDir: path.join(home, 'outputs'),
    chatsDir: path.join(home, 'chats'),
    transcriptsDir: path.join(home, 'transcripts'),
    sharedContext: path.join(home, 'shared-context.json'),
    downloadsDir: path.join(home, 'downloads'),
  };
}

/**
 * Load config from `<home>/config.json`, creating it (with a fresh token) on
 * first run. The created file is chmod 600 because it contains the token and
 * provider API keys.
 */
export function loadConfig(home: string = resolveHome()): {
  config: BastionPilotConfig;
  configPath: string;
  created: boolean;
} {
  const paths = configPaths(home);
  fs.mkdirSync(home, { recursive: true });
  let created = false;
  let raw: unknown = {};
  if (fs.existsSync(paths.config)) {
    try {
      raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    } catch (err) {
      throw new Error(`config file is not valid JSON (${paths.config}): ${(err as Error).message}`);
    }
  } else {
    created = true;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid config file (${paths.config}): ${issues}`);
  }
  const config = mergeConfig(defaultConfig(), parsed.data);
  if (created) {
    saveConfig(config, home);
    created = true;
  }
  return { config, configPath: paths.config, created };
}

export function saveConfig(config: BastionPilotConfig, home: string = resolveHome()): string {
  const paths = configPaths(home);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(paths.config, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return paths.config;
}
