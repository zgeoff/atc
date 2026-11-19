import type { MESSAGE_VIEW_SCHEMA } from '@atcx/contract';
import type { z } from 'zod';

export type MessageView = z.output<typeof MESSAGE_VIEW_SCHEMA>;

type MessageStatus = MessageView['status'];

// Where the text of a send comes from: the command line, or stdin, which
// the command reads to its end.
type SendText =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'stdin'; readonly explicit: boolean };

// What `atc send` was asked to do, once its flags passed the usage checks.
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

// What `atc message get` was asked to do, once its flags passed the usage
// checks.
export interface MessageGetRequest {
  readonly message: string;
  readonly wait: boolean;
  readonly timeoutSeconds: number;
  readonly daemon: string | null;
  readonly json: boolean;
}

// The outcome of a usage check: the request, or the reason the command line
// is wrong.
export type UsageResult<Request> =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly message: string };

export interface CommandError {
  readonly code: string;
  readonly message: string;
}

// Where the command ended, with what it knew by then.
export interface CommandOutcome {
  readonly exitCode: number;
  readonly key: string | null;
  readonly session: string | null;
  readonly message: string | null;

  // The message's status and what it holds, from the last read or from the
  // send's answer.
  readonly progress: {
    readonly status: MessageStatus;
    readonly answer?: string;
    readonly unansweredReason?: string;
  } | null;

  // The last read of the message, for `atc message get`.
  readonly view: MessageView | null;

  // Why the command did not end plainly answered: set for a failure, for an
  // unanswered message and for a wait that ran out.
  readonly error: CommandError | null;
}

// The daemon requests the commands make, each given a limit on its wait for
// the answer.
export interface SendConnection {
  readonly request: (
    method: 'session.list' | 'session.message' | 'message.get',
    params: Readonly<Record<string, unknown>>,
    limitMs: number,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly isClosed: () => boolean;
  readonly stop: () => void;
}

// A connection that opened, or the reason it did not.
export type ConnectResult =
  | { readonly ok: true; readonly connection: SendConnection }
  | { readonly ok: false; readonly error: CommandError };

// Which daemon a command talks to, and as whom.
export type ConnectTarget =
  | { readonly kind: 'local'; readonly owner: boolean }
  | { readonly kind: 'remote'; readonly name: string };
