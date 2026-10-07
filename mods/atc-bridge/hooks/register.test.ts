import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

function setupTest(
  on: On,
  config: {
    readonly env: Readonly<Record<string, string>>;
    readonly toolRegistration:
      | { readonly value: { readonly tool: string } }
      | { readonly deny: string };
    readonly tap: readonly string[];
    readonly tapReady?: Promise<void>;
    readonly onSubmit?: (text: string) => Promise<void>;
  },
) {
  const clock = mock.clock(on);

  mock.env(on, config.env);

  const logs: string[] = [];
  const registered: string[] = [];
  const spawned: string[][] = [];
  const ran: { argv: string[]; stdin: string | undefined }[] = [];
  const submitted: string[] = [];

  on('ui.log', ($, e) => {
    logs.push(e.text);

    return { value: undefined };
  });

  on('tool.register', ($, e) => {
    registered.push(e.name);

    return config.toolRegistration;
  });

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);

    await config.tapReady;

    for (const text of config.tap) {
      yield { stream: 'stdout', text };
    }

    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push({ argv: [...e.argv], stdin: e.init?.stdin });

    // Every atc call the hook makes needs an exit status to finish.
    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  on('prompt.submit', async ($, e) => {
    submitted.push(e.text);

    await config.onSubmit?.(e.text);

    return { text: e.text };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));

  return { clock, logs, registered, spawned, ran, submitted };
}

test('it registers nothing outside atc', async (engine, on) => {
  const ctx = setupTest(on, {
    env: {},
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: [],
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(ctx.registered).toStrictEqual([]);
  expect(ctx.spawned).toStrictEqual([]);
});

test('it submits a tapped message when no turn runs', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: ['{"id":"m-1","from":"alice","text":"hi"}\n'],
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(ctx.spawned).toStrictEqual([['atc', 'tap', '--session', 's-1']]);
  expect(ctx.submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});

test('it reports the answer for the message a turn carried', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: ['{"id":"m-1","from":"alice","text":"hi"}\n'],
    onSubmit: async (text) => {
      await engine.turn.start({ text, turnId: 't-1' });
    },
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  await engine.turn.complete({
    answer: 'done',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'report', 'answered', '--messages', 'm-1', '--turn', 't-1'], stdin: 'done' },
  ]);
});

test('it reports nothing for a turn that ended in an error', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: ['{"id":"m-1","from":"alice","text":"hi"}\n'],
    onSubmit: async (text) => {
      await engine.turn.start({ text, turnId: 't-1' });
    },
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'error',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([]);
});

test('it sends a report through atc', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: [],
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__report',
    text: 'blocked on review',
    kind: 'blocked',
  });

  expect(answered.result).toBe('Sent to the user through atc.');

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'report', 'note', '--label', 'blocked'], stdin: 'blocked on review' },
  ]);
});

test('it refuses a report without text', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: [],
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  const answered = await engine.tool.call({ tool: 'mcp__atc-bridge__report', text: '   ' });

  expect(answered.deny).toBe('report needs non-empty text');
  expect(ctx.ran).toStrictEqual([]);
});

test('it reports every message a queued turn carried in one report', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: ['{"id":"m-1","from":"alice","text":"one"}\n{"id":"m-2","fr', 'om":"bob","text":"two"}\n'],
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  await engine.turn.start({
    text: '<atc-message id="m-1" from="alice">\none\n</atc-message>\n\n<atc-message id="m-2" from="bob">\ntwo\n</atc-message>',
    turnId: 't-1',
  });

  await engine.turn.complete({
    answer: 'both',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'report', 'answered', '--messages', 'm-1,m-2', '--turn', 't-1'],
      stdin: 'both',
    },
  ]);
});

test('it submits a mid-turn message when the session refuses the append', async (engine, on) => {
  const tapLine = Promise.withResolvers<void>();

  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { value: { tool: 'mcp__atc-bridge__report' } },
    tap: ['{"id":"m-3","from":"bob","text":"late"}\n'],
    tapReady: tapLine.promise,
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  tapLine.resolve();

  await ctx.clock.settle();

  await engine.turn.complete({
    answer: 'unrelated',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.submitted).toStrictEqual(['<atc-message id="m-3" from="bob">\nlate\n</atc-message>']);
  expect(ctx.ran).toStrictEqual([]);
});

test('it starts no tap when the build refuses the report tool', async (engine, on) => {
  const ctx = setupTest(on, {
    env: { ATC_SESSION_ID: 's-1' },
    toolRegistration: { deny: 'no plugin tools here' },
    tap: [],
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(ctx.spawned).toStrictEqual([]);

  expect(ctx.logs).toStrictEqual([
    'atc-bridge: off for this session, the Claude Code build refused it (HooksError: atc-bridge: $.tool.register: no plugin tools here)',
  ]);
});
