import { z } from 'zod';
import type { CocoonEvent } from './events.ts';

/**
 * WebSocket wire format (/v1/ws), one JSON object per message:
 *   client → server  { id, method, params }            any method, plus "events.subscribe" / "events.unsubscribe"
 *   server → client  { id, result } | { id, error }
 *   server → client  { event: CocoonEvent, subscription } for active subscriptions
 */
export const WireRequest = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export type WireRequest = z.infer<typeof WireRequest>;

export type ErrorCode = 'bad_request' | 'unauthorized' | 'not_found' | 'conflict' | 'timeout' | 'internal';

export interface WireError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type WireResponse =
  | { id: string | number; result: unknown }
  | { id: string | number | null; error: WireError };

export interface WireEvent {
  subscription: string;
  event: CocoonEvent;
}

/** Client → server control messages on the raw terminal attach socket (/v1/agents/:id/attach). */
export const AttachControl = z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() });
export type AttachControl = z.infer<typeof AttachControl>;
