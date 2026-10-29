import { z } from 'zod';
import type { SessionInfo } from './types.js';

export const ToolName = {
  ListSessions: 'list_sessions',
  SendCommand: 'send_command',
  ReadOutput: 'read_output',
  WaitOutput: 'wait_output',
  SendKey: 'send_key',
  GetScreen: 'get_screen',
  UploadFile: 'upload_file',
  DownloadFile: 'download_file',
  GetSharedContext: 'get_shared_context',
  AppendSharedContext: 'append_shared_context',
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const TOOL_NAMES: ToolName[] = Object.values(ToolName);

const sessionId = z.string().min(1).describe('Terminal session id, as returned by list_sessions.');

/* ------------------------------------------------------------------ */
/* Parameter schemas (used as MCP ZodRawShape and validated on both    */
/* sides of the bridge).                                               */
/* ------------------------------------------------------------------ */

export const ListSessionsParams = z.object({});

export const SendCommandParams = z.object({
  sessionId,
  command: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => !/[\r\n]/.test(value), {
      message: 'command must be one line; chain steps with && or ;',
    })
    .refine((value) => !/```/.test(value), {
      message: 'command must not contain Markdown code fences',
    })
    .describe(
      'A single shell command to type and execute. One logical command per call — ' +
        'chain steps with `&&` or `;` instead of pasting many lines. No trailing newline. ' +
        'Do NOT start interactive full-screen programs (vim, top, less). If the command ' +
        'may read stdin (e.g. mysql, python REPL), redirect it: `cmd </dev/null`.'
    ),
  waitMs: z
    .number()
    .int()
    .min(500)
    .max(600_000)
    .optional()
    .describe(
      'How long to watch for completion, in milliseconds (default 10000). ' +
        'Use larger values for slow commands (builds, installs, big greps).'
    ),
  attachSentinel: z
    .boolean()
    .optional()
    .describe(
      'Append an `echo __BP_..._$?__` sentinel after the command so BastionPilot can ' +
        'detect completion and exit code (default true). Set false only when typing ' +
        'into an interactive dialog (y/n confirmations, pager prompts).'
    ),
});

export const ReadOutputParams = z.object({
  sessionId,
  cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Read output produced after this offset (take `cursor` from the previous ' +
        'read_output/send_command/wait_output result). Omit to read from the beginning ' +
        'of the retained scrollback.'
    ),
  maxChars: z
    .number()
    .int()
    .min(200)
    .max(200_000)
    .optional()
    .describe('Maximum characters to return (default 8000).'),
});

export const WaitOutputParams = z.object({
  sessionId,
  cursor: z.number().int().min(0).optional().describe('Only return output after this offset.'),
  timeoutMs: z
    .number()
    .int()
    .min(500)
    .max(600_000)
    .optional()
    .describe('Give up after this long (default 20000).'),
  quietMs: z
    .number()
    .int()
    .min(200)
    .max(60_000)
    .optional()
    .describe(
      'Consider the command finished when no new bytes arrive for this long (default 1000).'
    ),
});

export const SendKeyParams = z.object({
  sessionId,
  key: z
    .enum([
      'enter',
      'ctrl+c',
      'ctrl+d',
      'ctrl+z',
      'esc',
      'tab',
      'up',
      'down',
      'left',
      'right',
      'ctrl+l',
      'ctrl+u',
      'ctrl+a',
      'ctrl+e',
      'ctrl+k',
      'ctrl+w',
    ])
    .describe(
      "'ctrl+c' aborts the running command; 'enter' confirms a prompt; " +
        "'up'/'down' walk shell history; 'esc' cancels."
    ),
});

export const GetScreenParams = z.object({
  sessionId,
  maxLines: z
    .number()
    .int()
    .min(5)
    .max(200)
    .optional()
    .describe('Maximum number of lines to return (default 40).'),
});

export const UploadFileParams = z.object({
  sessionId,
  localPath: z
    .string()
    .min(1)
    .describe('Absolute path of the file on YOUR machine (where the daemon runs).'),
  remotePath: z.string().min(1).describe('Absolute destination path on the remote server.'),
  overwrite: z
    .boolean()
    .optional()
    .describe('Overwrite the remote file if it exists (default false — the call fails instead).'),
});

export const DownloadFileParams = z.object({
  sessionId,
  remotePath: z.string().min(1).describe('Absolute path of the file on the remote server.'),
  localPath: z
    .string()
    .optional()
    .describe(
      'Where to store the downloaded file on your machine. Defaults to ' +
        '~/.bastion-pilot/downloads/<basename>.'
    ),
});

export const GetSharedContextParams = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('Maximum shared entries to return.'),
  targetAgentId: z
    .string()
    .min(1)
    .optional()
    .describe('Only return messages addressed to this local-agent conversation.'),
});

export const AppendSharedContextParams = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'note']),
  content: z.string().min(1).max(20_000),
  targetAgentId: z.string().min(1).optional(),
  /** Correlate an assistant response with a panel request. */
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe('Echo the requestId from the panel message when replying to that request.'),
});

/* ------------------------------------------------------------------ */
/* Result schemas (what the extension returns for each tool).          */
/* ------------------------------------------------------------------ */

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.string(),
  profileId: z.string(),
  state: z.enum(['active', 'idle']),
  createdAt: z.number(),
  lastActivityAt: z.number(),
}) satisfies z.ZodType<SessionInfo>;

export const ListSessionsResult = z.object({
  sessions: z.array(SessionInfoSchema),
});

export const SendCommandResult = z.object({
  status: z
    .enum(['completed', 'quiet', 'timeout'])
    .describe(
      'completed = sentinel seen (exitCode is authoritative); ' +
        'quiet = no new output for a while (maybe still running); ' +
        'timeout = wait window elapsed while output kept flowing.'
    ),
  exitCode: z
    .number()
    .nullable()
    .describe('Exit code of the command when status is "completed", else null.'),
  cursor: z.number(),
  text: z.string().describe('Output produced so far (rendered, escape sequences stripped).'),
  hasMore: z.boolean(),
});

export const ReadOutputResult = z.object({
  text: z.string(),
  nextCursor: z.number(),
  hasMore: z.boolean(),
  dropped: z
    .boolean()
    .describe('True if output older than the retention window was dropped; re-run the command.'),
});

export const WaitOutputResult = z.object({
  status: z.enum(['quiet', 'output', 'timeout']),
  text: z.string(),
  nextCursor: z.number(),
  hasMore: z.boolean(),
});

export const SendKeyResult = z.object({ ok: z.boolean() });

export const GetScreenResult = z.object({
  screen: z.string(),
  truncated: z.boolean(),
});

export const UploadFileResult = z.object({
  remotePath: z.string(),
  bytes: z.number(),
});

export const DownloadFileResult = z.object({
  localPath: z.string(),
  bytes: z.number(),
});

/* ------------------------------------------------------------------ */
/* Tool descriptors — the agent-facing contract.                       */
/* ------------------------------------------------------------------ */

export interface ToolDescriptor {
  name: ToolName;
  title: string;
  description: string;
  shape: z.ZodRawShape;
}

const AUDIT_WARNING =
  " Commands run on a real server under the user's account and are fully " +
  'audit-logged by the bastion host. Never attempt to disable, evade or tamper with auditing.';

export const TOOLS: ToolDescriptor[] = [
  {
    name: ToolName.ListSessions,
    title: 'List bastion terminal sessions',
    description:
      'List the bastion web-terminal sessions currently hooked by the BastionPilot browser ' +
      'extension (one session per terminal tab). Always call this first and pick the right ' +
      'sessionId for the host you mean to work on.',
    shape: ListSessionsParams.shape,
  },
  {
    name: ToolName.SendCommand,
    title: 'Run a command in a bastion terminal',
    description:
      'Type a shell command into a bastion terminal session and press Enter. BastionPilot ' +
      'watches the output and returns as soon as the command finishes (status "completed", ' +
      'with its exit code), goes quiet, or the wait elapses. `text` holds the output so far; ' +
      'pass `cursor` to read_output/wait_output to get more.' +
      AUDIT_WARNING,
    shape: SendCommandParams.shape,
  },
  {
    name: ToolName.ReadOutput,
    title: 'Read terminal output',
    description:
      'Read terminal output of a session produced after `cursor` (from a previous ' +
      'read_output / send_command / wait_output result). Returns up to maxChars characters ' +
      'and the new cursor. Use while a command is still producing output.',
    shape: ReadOutputParams.shape,
  },
  {
    name: ToolName.WaitOutput,
    title: 'Wait for terminal output',
    description:
      'Wait for a session to produce more output and return it. Resolves when output goes ' +
      'quiet for quietMs (a good completion signal for commands started without a sentinel, ' +
      'e.g. after send_key) or when timeoutMs elapses. Use to keep collecting output of a ' +
      'long-running command instead of polling read_output in a tight loop.',
    shape: WaitOutputParams.shape,
  },
  {
    name: ToolName.SendKey,
    title: 'Send a special key press',
    description:
      "Send a special key press to a terminal session: 'ctrl+c' to abort the running command, " +
      "'enter' to confirm, 'esc' to cancel, 'up'/'down' for history. Use ctrl+c to stop a " +
      'runaway command. Never use this to answer a password/sudo prompt — refuse sensitive ' +
      'interactive input and ask the human to type it themselves.' +
      AUDIT_WARNING,
    shape: SendKeyParams.shape,
  },
  {
    name: ToolName.GetScreen,
    title: 'Snapshot the visible screen',
    description:
      'Get a text snapshot of what is currently visible on the terminal (like a screenshot ' +
      'in text form). Best when the terminal is on an alternate screen (vim, top, interactive ' +
      'menus) or when you need to see the current prompt state.',
    shape: GetScreenParams.shape,
  },
  {
    name: ToolName.UploadFile,
    title: 'Upload a local file to the remote server',
    description:
      'Upload a file from your machine to the remote server through the terminal (base64 over ' +
      'the PTY — no SFTP required). Fails if the remote file exists unless overwrite=true. ' +
      'Works for files up to ~64 MB; larger transfers are refused.' +
      AUDIT_WARNING,
    shape: UploadFileParams.shape,
  },
  {
    name: ToolName.DownloadFile,
    title: 'Download a remote file to your machine',
    description:
      'Download a file from the remote server to your machine through the terminal (base64 ' +
      'over the PTY) and store it locally, returning the local path. Works for files up to ' +
      '~64 MB; for bigger files use streaming commands (tar/gzip + split) instead.' +
      AUDIT_WARNING,
    shape: DownloadFileParams.shape,
  },
  {
    name: ToolName.GetSharedContext,
    title: 'Read shared BastionPilot conversation context',
    description:
      'Read recent conversation notes shared between the BastionPilot side panel and local MCP agents. ' +
      'Use this at the start of a related task so the panel and local agent can continue the same work. ' +
      'This is context only; terminal state must still be checked with list_sessions and a live command.',
    shape: GetSharedContextParams.shape,
  },
  {
    name: ToolName.AppendSharedContext,
    title: 'Share a message with BastionPilot',
    description:
      'Append a concise user/assistant/tool note to the shared BastionPilot conversation so the side panel can see it. ' +
      'Use for the task plan, findings and final summary, not secrets or unverified current server state.',
    shape: AppendSharedContextParams.shape,
  },
];

export const TOOL_MAP: ReadonlyMap<ToolName, ToolDescriptor> = new Map(
  TOOLS.map((t) => [t.name, t])
);

export function toolSchema(name: ToolName): z.ZodObject<z.ZodRawShape> {
  const desc = TOOL_MAP.get(name);
  if (!desc) throw new Error(`unknown tool: ${name}`);
  return z.object(desc.shape);
}
