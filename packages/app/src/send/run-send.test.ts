import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { DaemonError } from '@atc/protocol/wire';
import type { ErrorCode } from '@atcx/contract/light';
import { runSend } from './run-send';
import type { ConnectResult, SendRequest } from './types';

type GetStep =
  | {
      readonly view: 'queued' | 'delivered' | 'answered' | 'unanswered';
      readonly advanceMs?: number;
    }
  | { readonly error: ErrorCode };

interface Script {
  readonly sessions?: readonly { id: string; name: string; state: string }[];
  readonly send?: 'ok' | { readonly error: ErrorCode; readonly effectRef?: string };
  readonly gets?: readonly GetStep[];
  readonly closed?: boolean;
  readonly connectFailure?: string;
}

function setupTest() {
  const clock = buildStubClock(0);
  const out: string[] = [];
  const err: string[] = [];
  const requests: { method: string; params: Readonly<Record<string, unknown>> }[] = [];
  const targets: unknown[] = [];
  let script: Script = {};
  let getIndex = 0;
  let stopped = 0;

  const connection = {
    request: (method: string, params: Readonly<Record<string, unknown>>) => {
      requests.push({ method, params });

      if (method === 'session.list') {
        return Promise.resolve({
          sessions: script.sessions ?? [{ id: 's-1', name: 'planner', state: 'running' }],
        });
      }

      if (method === 'session.message') {
        const send = script.send ?? 'ok';

        if (send === 'ok') {
          return Promise.resolve({ message: 'm-1', status: 'queued' });
        }

        const data = send.effectRef === undefined ? undefined : { effectRef: send.effectRef };

        return Promise.reject(new DaemonError(send.error, 'daemon said no', data));
      }

      const step = script.gets?.[getIndex++];

      if (step === undefined) {
        return Promise.reject(new Error('the script holds no more reads'));
      }

      if ('error' in step) {
        return Promise.reject(new DaemonError(step.error, 'read refused'));
      }

      clock.advance(step.advanceMs ?? 0);

      return Promise.resolve({
        message: 'm-1',
        session: 's-1',
        from: 'atc-send',
        text: 'hi',
        status: step.view,
        sentAt: 1,
        ...(step.view === 'answered' ? { answer: 'yes' } : {}),
        ...(step.view === 'unanswered' ? { unansweredReason: 'session_ended' } : {}),
        turn: null,
        answeredWith: [],
      });
    },
    isClosed: () => script.closed === true,
    stop: () => {
      stopped += 1;
    },
  };

  const baseRequest: SendRequest = {
    session: 'planner',
    text: { kind: 'literal', value: 'hi' },
    key: 'k-1',
    wait: false,
    timeoutSeconds: 60,
    from: null,
    owner: false,
    daemon: null,
    json: false,
  };

  return {
    out,
    err,
    requests,
    targets,
    baseRequest,
    stoppedCount: () => stopped,
    setScript: (next: Script) => {
      script = next;
    },
    run: (request: SendRequest, extras: { stdin?: string; tty?: boolean; inside?: boolean } = {}) =>
      runSend(request, {
        connect: (target): Promise<ConnectResult> => {
          targets.push(target);

          if (script.connectFailure !== undefined) {
            return Promise.resolve({
              ok: false,
              error: { code: script.connectFailure, message: 'cannot connect' },
            });
          }

          return Promise.resolve({ ok: true, connection });
        },
        readStdin: () => Promise.resolve(extras.stdin ?? ''),
        isStdinTTY: extras.tty === true,
        insideSession: extras.inside === true,
        mintKey: () => 'atc-send-minted',
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
  { title: 'a send that is queued', script: {}, request: {}, exit: 0, stdout: ['m-1'], stderr: [] },
  {
    title: 'an answered wait',
    script: { gets: [{ view: 'answered' }] },
    request: { wait: true },
    exit: 0,
    stdout: ['yes'],
    stderr: [],
  },
  {
    title: 'a session that no listed session matches',
    script: { sessions: [] },
    request: {},
    exit: 3,
    stdout: [],
    stderr: [expect.toStartWith('atc send: no_such_session: ')],
  },
  {
    title: 'a name that several sessions hold',
    script: {
      sessions: [
        { id: 's-1', name: 'planner', state: 'running' },
        { id: 's-2', name: 'planner', state: 'exited' },
      ],
    },
    request: {},
    exit: 3,
    stdout: [],
    stderr: [
      expect.toStartWith("atc send: ambiguous_session: several sessions are named 'planner'"),
    ],
  },
  {
    title: 'a send refused with no_such_session',
    script: { send: { error: 'no_such_session' } },
    request: {},
    exit: 3,
    stdout: [],
    stderr: [expect.toStartWith('atc send: no_such_session: ')],
  },
  {
    title: 'a daemon that is not reached',
    script: { connectFailure: 'unreachable' },
    request: {},
    exit: 4,
    stdout: [],
    stderr: [expect.toStartWith('atc send: unreachable: ')],
  },
  {
    title: 'a connection that closes under the send',
    script: { send: { error: 'internal' }, closed: true },
    request: {},
    exit: 4,
    stdout: [],
    stderr: [expect.toStartWith('atc send: unreachable: ')],
  },
  {
    title: 'outcome_unknown with an effectRef that message.get finds',
    script: { send: { error: 'outcome_unknown', effectRef: 'm-9' }, gets: [{ view: 'queued' }] },
    request: {},
    exit: 0,
    stdout: ['m-9'],
    stderr: [],
  },
  {
    title: 'outcome_unknown with an effectRef that message.get finds, then an answered wait',
    script: {
      send: { error: 'outcome_unknown', effectRef: 'm-9' },
      gets: [{ view: 'delivered' }, { view: 'answered' }],
    },
    request: { wait: true },
    exit: 0,
    stdout: ['yes'],
    stderr: [],
  },
  {
    title: 'outcome_unknown with an effectRef that message.get finds answered, without --wait',
    script: { send: { error: 'outcome_unknown', effectRef: 'm-9' }, gets: [{ view: 'answered' }] },
    request: {},
    exit: 0,
    stdout: ['yes'],
    stderr: [],
  },
  {
    title: 'outcome_unknown with an effectRef that message.get finds unanswered, without --wait',
    script: {
      send: { error: 'outcome_unknown', effectRef: 'm-9' },
      gets: [{ view: 'unanswered' }],
    },
    request: {},
    exit: 7,
    stdout: [],
    stderr: ['atc send: unanswered: session_ended (key k-1, message m-9)'],
  },
  {
    title: 'outcome_unknown with an effectRef whose recovery read is refused',
    script: {
      send: { error: 'outcome_unknown', effectRef: 'm-9' },
      gets: [{ error: 'unauthorized' }],
    },
    request: {},
    exit: 6,
    stdout: [],
    stderr: [expect.toEndWith('(key k-1, message m-9)')],
  },
  {
    title: 'outcome_unknown on the local socket with no effectRef',
    script: { send: { error: 'outcome_unknown' } },
    request: {},
    exit: 5,
    stdout: [],
    stderr: [expect.toStartWith('atc send: outcome_unknown: ')],
  },
  {
    title: 'outcome_unknown with an effectRef that message.get refuses with bad_args',
    script: { send: { error: 'outcome_unknown', effectRef: 'm-9' }, gets: [{ error: 'bad_args' }] },
    request: {},
    exit: 5,
    stdout: [],
    stderr: [expect.toStartWith('atc send: outcome_unknown: ')],
  },
  {
    title: 'outcome_unknown under --daemon with no effectRef',
    script: { send: { error: 'outcome_unknown' } },
    request: { daemon: 'box' },
    exit: 6,
    stdout: [],
    stderr: [expect.toStartWith('atc send: outcome_unknown: ')],
  },
  {
    title: 'outcome_unknown under --daemon whose message.get refuses with bad_args',
    script: { send: { error: 'outcome_unknown', effectRef: 'm-9' }, gets: [{ error: 'bad_args' }] },
    request: { daemon: 'box' },
    exit: 6,
    stdout: [],
    stderr: [expect.toStartWith('atc send: outcome_unknown: ')],
  },
  {
    title: 'outcome_unknown whose message.get refuses with another code',
    script: {
      send: { error: 'outcome_unknown', effectRef: 'm-9' },
      gets: [{ error: 'idempotency_conflict' }],
    },
    request: {},
    exit: 6,
    stdout: [],
    stderr: [expect.toStartWith('atc send: outcome_unknown: ')],
  },
  {
    title: 'idempotency_conflict',
    script: { send: { error: 'idempotency_conflict' } },
    request: {},
    exit: 6,
    stdout: [],
    stderr: [expect.toStartWith('atc send: idempotency_conflict: ')],
  },
  {
    title: 'an internal error with an effectRef that message.get finds',
    script: { send: { error: 'internal', effectRef: 'm-9' }, gets: [{ view: 'delivered' }] },
    request: {},
    exit: 0,
    stdout: ['m-9'],
    stderr: [],
  },
  {
    title: 'an internal error with an effectRef that message.get refuses with bad_args',
    script: { send: { error: 'internal', effectRef: 'm-9' }, gets: [{ error: 'bad_args' }] },
    request: {},
    exit: 5,
    stdout: [],
    stderr: [expect.toStartWith('atc send: outcome_unknown: ')],
  },
  {
    title: 'an unanswered message',
    script: { gets: [{ view: 'unanswered' }] },
    request: { wait: true },
    exit: 7,
    stdout: [],
    stderr: ['atc send: unanswered: session_ended (key k-1, message m-1)'],
  },
  {
    title: 'a wait that reaches its timeout',
    script: {
      gets: [
        { view: 'delivered', advanceMs: 30_000 },
        { view: 'delivered', advanceMs: 30_000 },
      ],
    },
    request: { wait: true },
    exit: 8,
    stdout: ['m-1'],
    stderr: [expect.toStartWith('atc send: wait_timeout: ')],
  },
  {
    title: 'an unknown --daemon name',
    script: { connectFailure: 'no_such_daemon' },
    request: { daemon: 'box' },
    exit: 1,
    stdout: [],
    stderr: [expect.toStartWith('atc send: no_such_daemon: ')],
  },
  {
    title: 'an unreadable --daemon token',
    script: { connectFailure: 'remote_token' },
    request: { daemon: 'box' },
    exit: 1,
    stdout: [],
    stderr: [expect.toStartWith('atc send: remote_token: ')],
  },
  {
    title: 'a session that is dead',
    script: { send: { error: 'session_dead' } },
    request: {},
    exit: 1,
    stdout: [],
    stderr: [
      'atc send: session_dead: daemon said no; start it with: atc session adopt s-1 (key k-1)',
    ],
  },
  {
    title: 'a bad_args read during the wait',
    script: { gets: [{ error: 'bad_args' }] },
    request: { wait: true },
    exit: 1,
    stdout: [],
    stderr: [expect.toStartWith('atc send: bad_args: ')],
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

test('it prints one JSON line for an answered wait with --json', async () => {
  const ctx = setupTest();

  ctx.setScript({ gets: [{ view: 'answered' }] });

  const exit = await ctx.run({ ...ctx.baseRequest, wait: true, json: true });

  expect({ exit, stdout: ctx.out, stderr: ctx.err }).toStrictEqual({
    exit: 0,
    stdout: ['{"key":"k-1","session":"s-1","message":"m-1","status":"answered","answer":"yes"}'],
    stderr: [],
  });
});

test('it prints the error with the key as one JSON line for a refused send with --json', async () => {
  const ctx = setupTest();

  ctx.setScript({ send: { error: 'idempotency_conflict' } });

  const exit = await ctx.run({ ...ctx.baseRequest, json: true });

  expect({ exit, stdout: ctx.out, stderr: ctx.err }).toStrictEqual({
    exit: 6,
    stdout: ['{"key":"k-1","error":{"code":"idempotency_conflict","message":"daemon said no"}}'],
    stderr: [],
  });
});

test('it prints the message id in the JSON error when the recovery read is refused', async () => {
  const ctx = setupTest();

  ctx.setScript({
    send: { error: 'outcome_unknown', effectRef: 'm-9' },
    gets: [{ error: 'unauthorized' }],
  });

  const exit = await ctx.run({ ...ctx.baseRequest, json: true });

  expect({ exit, stdout: ctx.out, stderr: ctx.err }).toStrictEqual({
    exit: 6,
    stdout: [
      '{"key":"k-1","message":"m-9","error":{"code":"outcome_unknown","message":"the daemon did not say whether the message was delivered: read refused"}}',
    ],
    stderr: [],
  });
});

test('it sends one session.message with the key and the default sender name', async () => {
  const ctx = setupTest();

  await ctx.run(ctx.baseRequest);

  expect(ctx.requests.filter((sent) => sent.method === 'session.message')).toStrictEqual([
    {
      method: 'session.message',
      params: { session: 's-1', text: 'hi', idempotencyKey: 'k-1', from: 'atc-send' },
    },
  ]);
});

test.each([
  { title: '--from', request: { from: 'cron' }, params: { from: 'cron' } },
  { title: '--owner', request: { owner: true }, params: {} },
  { title: '--daemon', request: { daemon: 'box' }, params: {} },
])('it sends the sender name only for a local send, as $title shows', async (row) => {
  const ctx = setupTest();

  await ctx.run({ ...ctx.baseRequest, ...row.request });

  expect(ctx.requests.find((sent) => sent.method === 'session.message')?.params).toStrictEqual({
    session: 's-1',
    text: 'hi',
    idempotencyKey: 'k-1',
    ...row.params,
  });
});

test('it mints a key and prints it to stderr when --key is absent', async () => {
  const ctx = setupTest();

  await ctx.run({ ...ctx.baseRequest, key: null });

  expect(ctx.err).toStrictEqual(['atc send: key atc-send-minted']);
  expect(ctx.requests[1]?.params['idempotencyKey']).toBe('atc-send-minted');
});

test('it resolves a session by id before a name', async () => {
  const ctx = setupTest();

  ctx.setScript({
    sessions: [
      { id: 's-1', name: 's-2', state: 'running' },
      { id: 's-2', name: 'other', state: 'running' },
    ],
  });

  await ctx.run({ ...ctx.baseRequest, session: 's-2' });

  expect(ctx.requests[1]?.params['session']).toBe('s-2');
});

test('it never resends: a send of unknown outcome makes one session.message', async () => {
  const ctx = setupTest();

  ctx.setScript({ send: { error: 'outcome_unknown' } });

  await ctx.run(ctx.baseRequest);

  expect(ctx.requests.filter((sent) => sent.method === 'session.message')).toHaveLength(1);
});

test('it reads stdin to its end and drops one trailing newline', async () => {
  const ctx = setupTest();

  await ctx.run(
    { ...ctx.baseRequest, text: { kind: 'stdin', explicit: false } },
    { stdin: 'a\nb\n\n' },
  );

  expect(ctx.requests[1]?.params['text']).toBe('a\nb\n');
});

test('it drops a trailing CRLF from stdin text', async () => {
  const ctx = setupTest();

  await ctx.run(
    { ...ctx.baseRequest, text: { kind: 'stdin', explicit: true } },
    { stdin: 'a\r\n' },
  );

  expect(ctx.requests[1]?.params['text']).toBe('a');
});

test.each([
  {
    title: 'absent text with a terminal on stdin',
    request: { text: { kind: 'stdin', explicit: false } },
    stdin: '',
    tty: true,
  },
  {
    title: 'empty stdin text',
    request: { text: { kind: 'stdin', explicit: true } },
    stdin: '\n',
    tty: false,
  },
  {
    title: 'text over 256 KiB',
    request: { text: { kind: 'stdin', explicit: true } },
    stdin: 'x'.repeat(256 * 1024 + 1),
    tty: false,
  },
] as const)('it exits 2 without connecting for $title', async (row) => {
  const ctx = setupTest();

  const exit = await ctx.run(
    { ...ctx.baseRequest, ...row.request },
    { stdin: row.stdin, tty: row.tty },
  );

  expect({ exit, targets: ctx.targets, stdout: ctx.out, errors: ctx.err.length }).toStrictEqual({
    exit: 2,
    targets: [],
    stdout: [],
    errors: 1,
  });
});

test('it accepts text of exactly 256 KiB', async () => {
  const ctx = setupTest();

  const exit = await ctx.run({
    ...ctx.baseRequest,
    text: { kind: 'literal', value: 'x'.repeat(256 * 1024) },
  });

  expect(exit).toBe(0);
});

test('it warns once on stderr that --from and --owner are ignored inside a session', async () => {
  const ctx = setupTest();

  await ctx.run({ ...ctx.baseRequest, from: 'cron' }, { inside: true });

  expect(ctx.err).toStrictEqual([
    'atc send: inside a session the daemon ignores --from and --owner',
  ]);
});

test('it connects to the local daemon as the owner under --owner', async () => {
  const ctx = setupTest();

  await ctx.run({ ...ctx.baseRequest, owner: true });

  expect(ctx.targets).toStrictEqual([{ kind: 'local', owner: true }]);
});

test('it connects to a named daemon under --daemon', async () => {
  const ctx = setupTest();

  await ctx.run({ ...ctx.baseRequest, daemon: 'box' });

  expect(ctx.targets).toStrictEqual([{ kind: 'remote', name: 'box' }]);
});

test('it stops its connection once it is done', async () => {
  const ctx = setupTest();

  await ctx.run(ctx.baseRequest);

  expect(ctx.stoppedCount()).toBe(1);
});

test('it holds each read open for at most 30 s and ends at the timeout without real waiting', async () => {
  const ctx = setupTest();

  ctx.setScript({
    gets: [
      { view: 'delivered', advanceMs: 30_000 },
      { view: 'delivered', advanceMs: 15_000 },
    ],
  });

  const exit = await ctx.run({ ...ctx.baseRequest, wait: true, timeoutSeconds: 45 });

  const reads = ctx.requests.filter((sent) => sent.method === 'message.get');

  expect({ exit, waits: reads.map((sent) => sent.params['waitMs']) }).toStrictEqual({
    exit: 8,
    waits: [30_000, 15_000],
  });
});
