import { z } from 'zod';

/**
 * Wire protocol v1 between BastionPilot daemons and their clients
 * (browser extension, MCP server process, side-panel chat).
 *
 * Every frame is a JSON envelope: { v, id, type, ts, payload }.
 */

export const ENVELOPE_VERSION = 1 as const;

const EnvelopeShape = {
  v: z.literal(1),
  id: z.string(),
  ts: z.number(),
  type: z.string(),
  payload: z.unknown(),
};

export const Envelope = z.object(EnvelopeShape);
export type Envelope = z.infer<typeof Envelope>;

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */

export const HelloPayload = z.object({
  token: z.string(),
  role: z.enum(['extension', 'brain']),
  name: z.string().default('unknown'),
  version: z.string().default('0'),
});

export const SessionInfoLikeSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.string(),
  profileId: z.string(),
  state: z.enum(['active', 'idle']),
  createdAt: z.number(),
  lastActivityAt: z.number(),
});

export const ProviderInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  model: z.string(),
});

export const ChatStopReasonSchema = z.enum(['end', 'aborted', 'error', 'max_iterations']);

/* ---------------- client -> daemon ---------------- */

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('hello'),
    payload: HelloPayload,
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('pong'),
    payload: z.object({}).passthrough(),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('tool_result'),
    payload: z.object({
      callId: z.string(),
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.string().optional(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('sessions_update'),
    payload: z.object({ sessions: z.array(SessionInfoLikeSchema) }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('tool_call'),
    payload: z.object({
      callId: z.string(),
      source: z.enum(['mcp', 'agent', 'panel']),
      tool: z.string(),
      params: z.record(z.unknown()),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('providers_list_get'),
    payload: z.object({}).passthrough(),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_new'),
    payload: z.object({ providerId: z.string().optional() }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_message'),
    payload: z.object({ chatId: z.string(), text: z.string().min(1) }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_abort'),
    payload: z.object({ chatId: z.string() }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('approval_response'),
    payload: z.object({ requestId: z.string(), approved: z.boolean() }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/* ---------------- daemon -> client ---------------- */

export const DaemonMessage = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('welcome'),
    payload: z.object({
      daemonVersion: z.string(),
      sessions: z.array(SessionInfoLikeSchema),
      providers: z.array(ProviderInfoSchema),
      activeProviderId: z.string().nullable(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('ping'),
    payload: z.object({}).passthrough(),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('tool_call'),
    payload: z.object({
      callId: z.string(),
      source: z.enum(['mcp', 'agent', 'panel']),
      tool: z.string(),
      params: z.record(z.unknown()),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('tool_result'),
    payload: z.object({
      callId: z.string(),
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.string().optional(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('providers_list'),
    payload: z.object({
      providers: z.array(ProviderInfoSchema),
      activeProviderId: z.string().nullable(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_created'),
    payload: z.object({ chatId: z.string() }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_delta'),
    payload: z.object({ chatId: z.string(), seq: z.number(), text: z.string() }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_tool_call'),
    payload: z.object({
      chatId: z.string(),
      callId: z.string(),
      tool: z.string(),
      params: z.record(z.unknown()),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_tool_result'),
    payload: z.object({
      chatId: z.string(),
      callId: z.string(),
      ok: z.boolean(),
      summary: z.string(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('chat_done'),
    payload: z.object({
      chatId: z.string(),
      stopReason: ChatStopReasonSchema,
      error: z.string().optional(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('approval_request'),
    payload: z.object({
      requestId: z.string(),
      source: z.enum(['mcp', 'agent', 'panel']),
      tool: z.string(),
      sessionId: z.string().optional(),
      summary: z.string(),
      expiresAt: z.number(),
    }),
  }),
  z.object({
    v: z.literal(1),
    id: z.string(),
    ts: z.number(),
    type: z.literal('error'),
    payload: z.object({ message: z.string() }),
  }),
]);
export type DaemonMessage = z.infer<typeof DaemonMessage>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function makeEnvelope(type: string, payload: unknown): Envelope {
  return {
    v: ENVELOPE_VERSION,
    id: crypto.randomUUID(),
    ts: Date.now(),
    type,
    payload,
  };
}

export function parseClientMessage(
  raw: unknown
): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  const parsed = ClientMessage.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}

export function parseDaemonMessage(
  raw: unknown
): { ok: true; message: DaemonMessage } | { ok: false; error: string } {
  const parsed = DaemonMessage.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}
