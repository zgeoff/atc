import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

function setupTest({ on }: { readonly on: On }) {
  const clock = mock.clock(on);
  const logs: string[] = [];
  const ran: { argv: string[]; stdin: string | undefined }[] = [];

  on('ui.log', ($, e) => {
    logs.push(e.text);

    return { value: undefined };
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

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));

  return { clock, logs, ran };
}

test('it registers nothing outside atc', async (engine, on) => {
  setupTest({ on });

  mock.env(on, {});

  const registered: string[] = [];
  const spawned: string[][] = [];

  on('tool.register', ($, e) => {
    registered.push(e.name);

    return { value: { tool: 'mcp__atc-bridge__note' } };
  });

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);

    return { value: { code: 0, signal: null } };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(registered).toStrictEqual([]);
  expect(spawned).toStrictEqual([]);
});

test('it submits a tapped message when no turn runs', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const spawned: string[][] = [];
  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(spawned).toStrictEqual([['atc', 'tap', '--session', 's-1']]);
  expect(submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});

test('it reports the answer for the message a turn carried', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
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
    { argv: ['atc', 'answer', '--messages', 'm-1', '--turn', 't-1'], stdin: 'done' },
  ]);
});

test('it reports nothing for a turn that ended in an error', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
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

async function startNoteSession(
  engine: {
    readonly session: {
      readonly start: (init: {
        cwd: string;
        surface: 'terminal';
        isInteractive: boolean;
      }) => Promise<unknown>;
    };
  },
  on: On,
) {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  // The hook starts its tap at session start; this one never yields a line.
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  return ctx;
}

test('it registers the note tool with a label input', async (engine, on) => {
  setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const registered: { name: string; properties: unknown; required: unknown }[] = [];

  on('tool.register', ($, e) => {
    registered.push({
      name: e.name,
      properties: Object.keys(e.inputSchema['properties'] as object),
      required: e.inputSchema['required'],
    });

    return { value: { tool: 'mcp__atc-bridge__note' } };
  });

  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(registered).toStrictEqual([
    { name: 'note', properties: ['text', 'label'], required: ['text'] },
  ]);
});

test('it sends a note through atc under the full tool name', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__note',
    text: 'blocked on review',
    label: 'blocked',
  });

  expect(answered.result).toBe('Sent to the user through atc.');

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'note', '--label', 'blocked'], stdin: 'blocked on review' },
  ]);
});

test('it defaults a note without a label to progress', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  await engine.tool.call({ tool: 'mcp__atc-bridge__note', text: 'found the cause' });

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'note', '--label', 'progress'], stdin: 'found the cause' },
  ]);
});

test('it takes each valid label', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  for (const label of ['progress', 'blocked', 'decision']) {
    await engine.tool.call({ tool: 'mcp__atc-bridge__note', text: 'x', label });
  }

  expect(ctx.ran.map((run) => run.argv.at(-1))).toStrictEqual(['progress', 'blocked', 'decision']);
});

test('it refuses a note with an unknown label', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__note',
    text: 'x',
    label: 'urgent',
  });

  expect(answered.deny).toBe('note label must be progress, blocked or decision');
  expect(ctx.ran).toStrictEqual([]);
});

test('it refuses a note without text', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);
  const answered = await engine.tool.call({ tool: 'mcp__atc-bridge__note', text: '   ' });

  expect(answered.deny).toBe('note needs non-empty text');
  expect(ctx.ran).toStrictEqual([]);
});

test('it reports every message a queued turn carried in one report', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n{"id":"m-2","fr' };
    yield { stream: 'stdout', text: 'om":"bob","text":"two"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => ({ text: e.text }));

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
      argv: ['atc', 'answer', '--messages', 'm-1,m-2', '--turn', 't-1'],
      stdin: 'both',
    },
  ]);
});

test('it submits a mid-turn message when the session refuses the append', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();
  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-3","from":"bob","text":"late"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
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

  expect(submitted).toStrictEqual(['<atc-message id="m-3" from="bob">\nlate\n</atc-message>']);
  expect(ctx.ran).toStrictEqual([]);
});

test('it starts no tap when the build refuses the note tool', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const spawned: string[][] = [];

  on('tool.register', () => ({ deny: 'no plugin tools here' }));

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);

    return { value: { code: 0, signal: null } };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(spawned).toStrictEqual([]);

  expect(ctx.logs).toStrictEqual([
    'atc-bridge: off for this session, the Claude Code build refused it (HooksError: atc-bridge: $.tool.register: no plugin tools here)',
  ]);
});
