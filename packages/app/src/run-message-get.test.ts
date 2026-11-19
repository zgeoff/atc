import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { DaemonError } from '@atc/protocol/wire';
import type { ErrorCode } from '@atcx/contract/light';
import { runMessageGet } from './run-message-get';
import type { ConnectResult, MessageGetRequest } from './send-types';

interface Script {
  readonly view?: 'queued' | 'delivered' | 'answered' | 'unanswered';
  readonly error?: ErrorCode;
  readonly closed?: boolean;
  readonly connectFailure?: string;
  readonly advanceMs?: number;
}

function setupTest() {
  const clock = buildStubClock(0);
  const out: string[] = [];
  const err: string[] = [];
  const waits: unknown[] = [];
  let script: Script = {};

  const connection = {
    request: (_method: string, params: Readonly<Record<string, unknown>>) => {
      waits.push(params['waitMs']);

      if (script.error !== undefined) {
        return Promise.reject(new DaemonError(script.error, 'read refused'));
      }

      clock.advance(script.advanceMs ?? 0);

      const status = script.view ?? 'queued';

      return Promise.resolve({
        message: 'm-1',
        session: 's-1',
        from: 'atc-send',
        sender: { kind: 'local', name: 'atc-send' },
        text: 'hi',
        status,
        sentAt: 1,
        ...(status === 'answered' ? { answer: 'yes' } : {}),
        ...(status === 'unanswered' ? { unansweredReason: 'session_ended' } : {}),
        turn: null,
        answeredWith: [],
      });
    },
    isClosed: () => script.closed === true,
    stop: () => {},
  };

  const baseRequest: MessageGetRequest = {
    message: 'm-1',
    wait: false,
    timeoutSeconds: 60,
    daemon: null,
    json: false,
  };

  return {
    out,
    err,
    waits,
    baseRequest,
    setScript: (next: Script) => {
      script = next;
    },
    run: (request: MessageGetRequest) =>
      runMessageGet(request, {
        connect: (): Promise<ConnectResult> => {
          if (script.connectFailure !== undefined) {
            return Promise.resolve({
              ok: false,
              error: { code: script.connectFailure, message: 'cannot connect' },
            });
          }

          return Promise.resolve({ ok: true, connection });
        },
        clock,
        io: {
          print: (line) => {
            out.push(line);
          },
          printError: (line) => {
            err.push(line);
          },
        },
      }),
  };
}

test.each([
  {
    title: 'a queued message',
    script: { view: 'queued' },
    request: {},
    exit: 0,
    stdout: ['queued'],
    stderr: [],
  },
  {
    title: 'a delivered message',
    script: { view: 'delivered' },
    request: {},
    exit: 0,
    stdout: ['delivered'],
    stderr: [],
  },
  {
    title: 'an answered message',
    script: { view: 'answered' },
    request: {},
    exit: 0,
    stdout: ['answered\nyes'],
    stderr: [],
  },
  {
    title: 'an unanswered message',
    script: { view: 'unanswered' },
    request: {},
    exit: 7,
    stdout: ['unanswered'],
    stderr: ['atc message get: unanswered: session_ended (message m-1)'],
  },
  {
    title: 'a wait that times out',
    script: { view: 'delivered', advanceMs: 60_000 },
    request: { wait: true, timeoutSeconds: 60 },
    exit: 8,
    stdout: ['delivered'],
    stderr: [expect.toStartWith('atc message get: wait_timeout: ')],
  },
  {
    title: 'an unknown message id',
    script: { error: 'bad_args' },
    request: {},
    exit: 1,
    stdout: [],
    stderr: ['atc message get: bad_args: read refused (message m-1)'],
  },
  {
    title: 'a connection that closes under the read',
    script: { error: 'internal', closed: true },
    request: {},
    exit: 4,
    stdout: [],
    stderr: [expect.toStartWith('atc message get: unreachable: ')],
  },
  {
    title: 'a daemon that is not reached',
    script: { connectFailure: 'unreachable' },
    request: {},
    exit: 4,
    stdout: [],
    stderr: ['atc message get: unreachable: cannot connect (message m-1)'],
  },
  {
    title: 'an unknown --daemon name',
    script: { connectFailure: 'no_such_daemon' },
    request: { daemon: 'box' },
    exit: 1,
    stdout: [],
    stderr: ['atc message get: no_such_daemon: cannot connect (message m-1)'],
  },
] as const)('it exits $exit with the output of $title', async (row) => {
  const ctx = setupTest();

  ctx.setScript(row.script);

  const exit = await ctx.run({ ...ctx.baseRequest, ...row.request });

  expect({ exit, stdout: ctx.out, stderr: ctx.err }).toStrictEqual({
    exit: row.exit,
    stdout: [...row.stdout],
    stderr: [...row.stderr],
  });
});

test.each([
  { title: 'an answered message', script: { view: 'answered' }, exit: 0 },
  { title: 'an unanswered message', script: { view: 'unanswered' }, exit: 7 },
  { title: 'a delivered message', script: { view: 'delivered' }, exit: 0 },
] as const)('it prints the message view as JSON with --json for $title', async (row) => {
  const ctx = setupTest();

  ctx.setScript(row.script);

  const exit = await ctx.run({ ...ctx.baseRequest, json: true });

  expect({
    exit,
    stdout: ctx.out.map((line): unknown => JSON.parse(line)),
    stderr: ctx.err,
  }).toStrictEqual({
    exit: row.exit,
    stdout: [expect.objectContaining({ message: 'm-1', session: 's-1', status: row.script.view })],
    stderr: [],
  });
});

test.each([
  { title: 'an unknown message id', script: { error: 'bad_args' }, exit: 1, code: 'bad_args' },
  {
    title: 'a closed connection',
    script: { error: 'internal', closed: true },
    exit: 4,
    code: 'unreachable',
  },
] as const)('it prints the error object as JSON with --json for $title', async (row) => {
  const ctx = setupTest();

  ctx.setScript(row.script);

  const exit = await ctx.run({ ...ctx.baseRequest, json: true });

  expect({
    exit,
    stdout: ctx.out.map((line): unknown => JSON.parse(line)),
    stderr: ctx.err,
  }).toStrictEqual({
    exit: row.exit,
    stdout: [{ error: { code: row.code, message: 'read refused' } }],
    stderr: [],
  });
});

test('it reads once without holding the request open when --wait is absent', async () => {
  const ctx = setupTest();

  await ctx.run(ctx.baseRequest);

  expect(ctx.waits).toStrictEqual([0]);
});

test('it holds each read open for at most 30 s under --wait', async () => {
  const ctx = setupTest();

  ctx.setScript({ view: 'delivered', advanceMs: 100_000 });

  await ctx.run({ ...ctx.baseRequest, wait: true, timeoutSeconds: 100 });

  expect(ctx.waits).toStrictEqual([30_000]);
});
