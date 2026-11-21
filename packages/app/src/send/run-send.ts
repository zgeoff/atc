import { MESSAGE_ANSWER_SCHEMA } from '@atcx/contract';
import type { Clock } from '@zgeoff/std';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { formatCommandOutcome } from '../cli/format-command-outcome';
import type { ProcessIO } from '../cli/process-io';
import { buildFailureOutcome, buildReadOutcome } from '../message-get/build-read-outcome';
import type { OutcomeBase } from '../message-get/build-read-outcome';
import { findTextRefusal } from './parse-send-args';
import { pickSendFailure } from './pick-send-failure';
import type { FailureStage } from './pick-send-failure';
import { resolveSendSession } from './resolve-send-session';
import type {
  CommandOutcome,
  ConnectResult,
  ConnectTarget,
  MessageView,
  SendConnection,
  SendRequest,
} from './types';
import { waitForMessage } from './wait-for-message';

export interface SendDependencies {
  readonly connect: (target: ConnectTarget) => Promise<ConnectResult>;
  readonly readStdin: () => Promise<string>;
  readonly isStdinTTY: boolean;

  readonly insideSession: boolean;
  readonly mintKey: () => string;
  readonly clock: Pick<Clock, 'now' | 'schedule'>;
  readonly io: Pick<ProcessIO, 'print' | 'printError'>;
}

export async function runSend(
  request: Readonly<SendRequest>,
  dependencies: Readonly<SendDependencies>,
): Promise<number> {
  const io = dependencies.io;

  if (dependencies.insideSession && (request.from !== null || request.owner)) {
    io.printError('atc send: inside a session the daemon ignores --from and --owner');
  }

  const text = await readText(request, dependencies);

  if (!text.ok) {
    io.printError(`atc send: ${text.message}`);

    return 2;
  }

  const key = request.key ?? dependencies.mintKey();

  if (request.key === null) {
    io.printError(`atc send: key ${key}`);
  }

  const target = buildConnectTarget(request);

  const connected = await dependencies.connect(target);

  if (!connected.ok) {
    const exitCode = connected.error.code === 'unreachable' ? 4 : 1;
    const base: OutcomeBase = { key, session: null, message: null };

    return writeOutcome(
      buildFailureOutcome(base, exitCode, connected.error),
      request,
      dependencies,
    );
  }

  const connection = connected.connection;

  try {
    const job = { request, text: text.value, key, remote: target.kind === 'remote', connection };

    const outcome = await sendMessage(job, dependencies);

    return writeOutcome(outcome, request, dependencies);
  } finally {
    connection.stop();
  }
}

type TextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

async function readText(
  request: Readonly<SendRequest>,
  dependencies: Readonly<SendDependencies>,
): Promise<TextResult> {
  if (request.text.kind === 'literal') {
    return { ok: true, value: request.text.value };
  }

  if (!request.text.explicit && dependencies.isStdinTTY) {
    return { ok: false, message: 'give the message text, or pipe it in on stdin' };
  }

  const raw = await dependencies.readStdin();

  const value = raw.replace(/\r?\n$/u, '');
  const refusal = findTextRefusal(value);

  return refusal === null ? { ok: true, value } : { ok: false, message: refusal };
}

function buildConnectTarget(request: Readonly<SendRequest>): ConnectTarget {
  if (request.daemon !== null) {
    return { kind: 'remote', name: request.daemon };
  }

  return { kind: 'local', owner: request.owner };
}

function writeOutcome(
  outcome: Readonly<CommandOutcome>,
  request: Readonly<SendRequest>,
  dependencies: Readonly<SendDependencies>,
): number {
  const output = formatCommandOutcome(outcome, { command: 'send', json: request.json });

  if (output.stdout !== null) {
    dependencies.io.print(output.stdout);
  }

  if (output.stderr !== null) {
    dependencies.io.printError(output.stderr);
  }

  return outcome.exitCode;
}

interface SendJob {
  readonly request: Readonly<SendRequest>;
  readonly text: string;
  readonly key: string;
  readonly remote: boolean;
  readonly connection: SendConnection;
}

const REQUEST_LIMIT_MS = 30_000;
const LISTED_SESSION_SCHEMA = z.object({ id: z.string(), name: z.string(), state: z.string() });
const LIST_SCHEMA = z.object({ sessions: z.array(LISTED_SESSION_SCHEMA) });

async function sendMessage(
  job: Readonly<SendJob>,
  dependencies: Readonly<SendDependencies>,
): Promise<CommandOutcome> {
  const connection = job.connection;
  let base: OutcomeBase = { key: job.key, session: null, message: null };
  let stage: FailureStage = 'list';

  try {
    const listing = await connection.request('session.list', {}, REQUEST_LIMIT_MS);

    const listed = LIST_SCHEMA.parse(listing);
    const match = resolveSendSession(listed.sessions, job.request.session);

    if (match.kind === 'missing') {
      return buildFailureOutcome(base, 3, {
        code: 'no_such_session',
        message: `no session has the id or name '${job.request.session}'`,
      });
    }

    if (match.kind === 'ambiguous') {
      const lines = match.candidates.map(
        (candidate) => `  ${candidate.id}  ${candidate.name}  ${candidate.state}`,
      );

      return buildFailureOutcome(base, 3, {
        code: 'ambiguous_session',
        message: [
          `several sessions are named '${job.request.session}'; pass an id:`,
          ...lines,
        ].join('\n'),
      });
    }

    base = { ...base, session: match.id };

    const sent = await sendOnce(job, match.id, dependencies);

    if (sent.kind === 'failed') {
      return sent.outcome;
    }

    base = { ...base, message: sent.message };
    stage = 'wait';

    if (sent.view !== null && (isSettled(sent.view.status) || !job.request.wait)) {
      return buildReadOutcome(base, sent.view, false);
    }

    if (!job.request.wait) {
      return { ...base, exitCode: 0, progress: { status: sent.status }, view: null, error: null };
    }

    const read = await waitForMessage({
      connection,
      clock: dependencies.clock,
      message: sent.message,
      timeoutSeconds: job.request.timeoutSeconds,
    });

    return buildReadOutcome(base, read.view, read.timedOut);
  } catch (error) {
    const picked = pickSendFailure(error, {
      stage,
      closed: connection.isClosed(),
      remote: job.remote,
    });

    invariant(picked.kind === 'ended');

    return buildFailureOutcome(base, picked.exitCode, picked.error);
  }
}

type SentMessage =
  | {
      readonly kind: 'sent';
      readonly message: string;
      readonly status: z.output<typeof MESSAGE_ANSWER_SCHEMA>['status'];

      readonly view: MessageView | null;
    }
  | { readonly kind: 'failed'; readonly outcome: CommandOutcome };

async function sendOnce(
  job: Readonly<SendJob>,
  session: string,
  dependencies: Readonly<SendDependencies>,
): Promise<SentMessage> {
  const base: OutcomeBase = { key: job.key, session, message: null };
  const localFrom = job.request.daemon === null && !job.request.owner;

  try {
    const answer = await job.connection.request(
      'session.message',
      {
        session,
        text: job.text,
        idempotencyKey: job.key,
        ...(localFrom ? { from: job.request.from ?? 'atc-send' } : {}),
      },
      REQUEST_LIMIT_MS,
    );

    const sent = MESSAGE_ANSWER_SCHEMA.parse(answer);

    return { kind: 'sent', message: sent.message, status: sent.status, view: null };
  } catch (error) {
    const picked = pickSendFailure(error, {
      stage: 'send',
      closed: job.connection.isClosed(),
      remote: job.remote,
    });

    if (picked.kind === 'ended') {
      return { kind: 'failed', outcome: buildFailureOutcome(base, picked.exitCode, picked.error) };
    }

    return settleUnknownSend(job, base, picked.effectRef, dependencies);
  }
}

async function settleUnknownSend(
  job: Readonly<SendJob>,
  base: OutcomeBase,
  effectRef: string,
  dependencies: Readonly<SendDependencies>,
): Promise<SentMessage> {
  const known: OutcomeBase = { ...base, message: effectRef };

  try {
    const read = await waitForMessage({
      connection: job.connection,
      clock: dependencies.clock,
      message: effectRef,
      timeoutSeconds: null,
    });

    return { kind: 'sent', message: effectRef, status: read.view.status, view: read.view };
  } catch (error) {
    const picked = pickSendFailure(error, {
      stage: 'recover',
      closed: job.connection.isClosed(),
      remote: job.remote,
    });

    invariant(picked.kind === 'ended');

    return { kind: 'failed', outcome: buildFailureOutcome(known, picked.exitCode, picked.error) };
  }
}

function isSettled(status: MessageView['status']): boolean {
  return status === 'answered' || status === 'unanswered';
}
