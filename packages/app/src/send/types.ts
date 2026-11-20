import type { MESSAGE_VIEW_SCHEMA } from '@atcx/contract';
import type { z } from 'zod';

export type MessageView = z.output<typeof MESSAGE_VIEW_SCHEMA>;

type MessageStatus = MessageView['status'];

type SendText =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'stdin'; readonly explicit: boolean };

export interface SendRequest {
  readonly session: string;
  readonly text: SendText;
  readonly key: string | null;
  readonly wait: boolean;
  readonly timeoutSeconds: number;
  readonly from: string | null;
  readonly owner: boolean;
  readonly daemon: string | null;
  readonly json: boolean;
}

export interface MessageGetRequest {
  readonly message: string;
  readonly wait: boolean;
  readonly timeoutSeconds: number;
  readonly daemon: string | null;
  readonly json: boolean;
}

export type UsageResult<Request> =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly message: string };

export interface CommandError {
  readonly code: string;
  readonly message: string;
}

export interface CommandOutcome {
  readonly exitCode: number;
  readonly key: string | null;
  readonly session: string | null;
  readonly message: string | null;

  readonly progress: {
    readonly status: MessageStatus;
    readonly answer?: string;
    readonly unansweredReason?: string;
  } | null;

  readonly view: MessageView | null;

  readonly error: CommandError | null;
}

// The params of each call a send makes.
export interface SendCalls {
  readonly 'session.list': Record<string, never>;

  readonly 'session.message': {
    readonly session: string;
    readonly text: string;
    readonly idempotencyKey: string;
    readonly from?: string;
  };

  readonly 'message.get': { readonly message: string; readonly waitMs: number };
}

export interface SendConnection {
  readonly request: <Method extends keyof SendCalls>(
    method: Method,
    params: SendCalls[Method],
    limitMs: number,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly isClosed: () => boolean;
  readonly stop: () => void;
}

export type ConnectResult =
  | { readonly ok: true; readonly connection: SendConnection }
  | { readonly ok: false; readonly error: CommandError };

export type ConnectTarget =
  | { readonly kind: 'local'; readonly owner: boolean }
  | { readonly kind: 'remote'; readonly name: string };
