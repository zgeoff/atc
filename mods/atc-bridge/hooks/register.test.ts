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
        stdout: 'delivered\n',
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

  expect(spawned).toStrictEqual([['atc', 'tap', '--session', 's-1', '--notices']]);
  expect(submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});

test('it marks each envelope with the kind of the sender atc gave', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: [
        '{"id":"m-1","from":"Lantern Notes","sender":{"kind":"connector","client":"client-7","name":"Lantern Notes"},"text":"one"}',
        '{"id":"m-2","from":"harbor-refactor","sender":{"kind":"session","session":"s-2","name":"harbor-refactor"},"text":"two"}',
        '{"id":"m-3","from":"owner","sender":{"kind":"owner","name":"owner"},"text":"three"}',
        '{"id":"m-4","from":"x\\"y","sender":{"kind":"robot","name":"x"},"text":"four"}',
        '{"id":"m-5","from":"no id","sender":{"kind":"session","name":"no id"},"text":"five"}',
        '{"id":"m-6","from":"tide-sweeper","sender":{"kind":"local","name":"tide-sweeper"},"text":"six"}',
        '',
      ].join('\n'),
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(submitted).toStrictEqual([
    '<atc-message id="m-1" from="Lantern Notes" kind="connector">\none\n</atc-message>',
    '<atc-message id="m-2" from="harbor-refactor" kind="session" session="s-2">\ntwo\n</atc-message>',
    '<atc-message id="m-3" from="owner" kind="owner">\nthree\n</atc-message>',
    '<atc-message id="m-4" from="x&quot;y">\nfour\n</atc-message>',
    '<atc-message id="m-5" from="no id">\nfive\n</atc-message>',
    '<atc-message id="m-6" from="tide-sweeper" kind="local">\nsix\n</atc-message>',
  ]);
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

test('it reports the message of a turn that ended in an error as unanswered', async (engine, on) => {
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

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'unanswered', '--messages', 'm-1', '--turn', 't-1', '--reason', 'error'],
      stdin: undefined,
    },
  ]);
});

test("it reports an interrupted turn's message as unanswered", async (engine, on) => {
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
    isAborted: true,
    turnId: 't-1',
    reason: 'aborted',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'unanswered', '--messages', 'm-1', '--turn', 't-1', '--reason', 'interrupted'],
      stdin: undefined,
    },
  ]);
});

test('it reports the message of a refused turn as unanswered', async (engine, on) => {
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
    reason: 'refusal',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'unanswered', '--messages', 'm-1', '--turn', 't-1', '--reason', 'refusal'],
      stdin: undefined,
    },
  ]);
});

test('it reports a message a hook dropped as unanswered because no turn started', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', () => ({ drop: 'another hook refused it' }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'unanswered', '--messages', 'm-1', '--reason', 'not_started'],
      stdin: undefined,
    },
  ]);
});

test('it answers a queued message from its own turn after the turn ahead of it fails', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('session.append', () => ({ deny: 'not now' }));
  on('prompt.submit', ($, e) => ({ text: e.text }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  tapLine.resolve();

  await ctx.clock.settle();

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'error',
  });

  await engine.turn.start({
    text: '<atc-message id="m-1" from="alice">\nhi\n</atc-message>',
    turnId: 't-2',
  });

  await engine.turn.complete({
    answer: 'hello',
    durationMs: 5,
    isAborted: false,
    turnId: 't-2',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'answer', '--messages', 'm-1', '--turn', 't-2'],
      stdin: 'hello',
    },
  ]);
});

test('it answers a queued message from its own turn after the turn ahead of it is interrupted', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('session.append', () => ({ deny: 'not now' }));
  on('prompt.submit', ($, e) => ({ text: e.text }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  tapLine.resolve();

  await ctx.clock.settle();

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: true,
    turnId: 't-1',
    reason: 'aborted',
  });

  await engine.turn.start({
    text: '<atc-message id="m-1" from="alice">\nhi\n</atc-message>',
    turnId: 't-2',
  });

  await engine.turn.complete({
    answer: 'hello',
    durationMs: 5,
    isAborted: false,
    turnId: 't-2',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'answer', '--messages', 'm-1', '--turn', 't-2'],
      stdin: 'hello',
    },
  ]);
});

test('it reports a queued message as interrupted once when its own turn is interrupted after the turn ahead of it fails', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('session.append', () => ({ deny: 'not now' }));
  on('prompt.submit', ($, e) => ({ text: e.text }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  tapLine.resolve();

  await ctx.clock.settle();

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'error',
  });

  await engine.turn.start({
    text: '<atc-message id="m-1" from="alice">\nhi\n</atc-message>',
    turnId: 't-2',
  });

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: true,
    turnId: 't-2',
    reason: 'aborted',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'unanswered', '--messages', 'm-1', '--turn', 't-2', '--reason', 'interrupted'],
      stdin: undefined,
    },
  ]);
});

test('it reports a mid-turn message as not started when a hook drops its queued prompt', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('session.append', () => ({ deny: 'not now' }));
  on('prompt.submit', () => ({ drop: 'another hook refused it' }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  tapLine.resolve();

  await ctx.clock.settle();

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'error',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    {
      argv: ['atc', 'unanswered', '--messages', 'm-1', '--reason', 'not_started'],
      stdin: undefined,
    },
  ]);
});

test('it submits a message that arrives during a turn that is then interrupted', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();
  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-2","from":"bob","text":"late"}\n' };

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
    answer: '',
    durationMs: 5,
    isAborted: true,
    turnId: 't-1',
    reason: 'aborted',
  });

  await ctx.clock.settle();

  expect(submitted).toStrictEqual(['<atc-message id="m-2" from="bob">\nlate\n</atc-message>']);
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
    { name: 'answer', properties: ['message', 'text'], required: ['message', 'text'] },
  ]);
});

test('it tells the model to answer each message with the answer tool', async (engine, on) => {
  setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('prompt.compose', ($, e) => ({ sections: e.sections }));
  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  const composed = await engine.prompt.compose({
    sections: [],
    promptModel: 'claude-opus-5-5',
    outputStyle: null,
    tools: [],
    traits: [],
    surfaces: [],
  });

  expect(composed.sections).toStrictEqual([
    {
      id: 'atc-bridge:messages',
      scope: 'session',
      text: expect.stringContaining(
        "Answer each <atc-message> with the answer tool, giving its id and your answer to that sender; atc stores the text as the message's answer, and it reaches a sending session as a notice. Your final reply goes to the user at this terminal, not to a sender: only a message you leave without an answer takes the final reply of its turn as its answer.",
      ),
    },
  ]);
});

test('it reports an answer for one carried message before the turn ends', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"is the lamp lit?"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'the lamp is lit',
  });

  expect(answered.result).toBe('Handed to atc as the answer to m-1.');

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'answer', '--message', 'm-1'], stdin: 'the lamp is lit' },
  ]);
});

test('it gives the final reply only to the carried message the answer tool left without an answer', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"id":"m-1","from":"alice","text":"one"}\n{"id":"m-2","from":"bob","text":"two"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => ({ text: e.text }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  await engine.turn.start({
    text: '<atc-message id="m-1" from="alice">\none\n</atc-message>\n\n<atc-message id="m-2" from="bob">\ntwo\n</atc-message>',
    turnId: 't-1',
  });

  await engine.tool.call({ tool: 'mcp__atc-bridge__answer', message: 'm-1', text: 'for alice' });

  await engine.turn.complete({
    answer: 'for the terminal',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'answer', '--message', 'm-1'], stdin: 'for alice' },
    { argv: ['atc', 'answer', '--messages', 'm-2', '--turn', 't-1'], stdin: 'for the terminal' },
  ]);
});

test('it reports nothing at the end of a turn whose every message the answer tool answered', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();
  await engine.tool.call({ tool: 'mcp__atc-bridge__answer', message: 'm-1', text: 'for alice' });

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: true,
    turnId: 't-1',
    reason: 'aborted',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'answer', '--message', 'm-1'], stdin: 'for alice' },
  ]);
});

test('it leaves a message to the final reply when atc does not take its answer', async (engine, on) => {
  const clock = mock.clock(on);
  const ran: string[][] = [];

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

    if (e.argv.includes('--message')) {
      throw new Error('atc is gone');
    }

    return {
      value: {
        exitCode: 0,
        stdout: 'delivered\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'for alice',
  });

  await engine.turn.complete({
    answer: 'for the terminal',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await clock.settle();

  expect(answered.deny).toStartWith('atc did not take the answer:');

  expect(ran).toStrictEqual([
    ['atc', 'answer', '--message', 'm-1'],
    ['atc', 'answer', '--messages', 'm-1', '--turn', 't-1'],
  ]);
});

test('it leaves a message to the final reply when atc exits nonzero on its answer', async (engine, on) => {
  const clock = mock.clock(on);
  const ran: string[][] = [];

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

    return {
      value: {
        exitCode: e.argv.includes('--message') ? 1 : 0,
        stdout: 'delivered\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'for alice',
  });

  await engine.turn.complete({
    answer: 'for the terminal',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await clock.settle();

  expect(answered.deny).toBe('atc did not take the answer: atc exited with 1');

  expect(ran).toStrictEqual([
    ['atc', 'answer', '--message', 'm-1'],
    ['atc', 'answer', '--messages', 'm-1', '--turn', 't-1'],
  ]);
});

// The reporter always exits 0, so atc prints undelivered when the answer
// never reached it, as when the session's socket is gone.
function setupUndeliveredTest({ on }: { readonly on: On }, undelivered: number) {
  const clock = mock.clock(on);
  const ran: string[][] = [];
  let failures = undelivered;

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

    const isUndelivered = e.argv.includes('--message') && failures > 0;

    if (isUndelivered) {
      failures -= 1;
    }

    return {
      value: {
        exitCode: 0,
        stdout: isUndelivered ? 'undelivered\n' : 'delivered\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  return { clock, ran };
}

test('it keeps a message carried when atc prints undelivered for its answer, so a retry answers it', async (engine, on) => {
  const ctx = setupUndeliveredTest({ on }, 1);

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  const failed = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'for alice',
  });

  const retried = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'for alice',
  });

  await engine.turn.complete({
    answer: 'for the terminal',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(failed.deny).toBe('atc did not take the answer: the answer did not reach atc');
  expect(retried.result).toBe('Handed to atc as the answer to m-1.');

  expect(ctx.ran).toStrictEqual([
    ['atc', 'answer', '--message', 'm-1'],
    ['atc', 'answer', '--message', 'm-1'],
  ]);
});

test('it leaves a message to the final reply when atc prints undelivered for its answer', async (engine, on) => {
  const ctx = setupUndeliveredTest({ on }, 1);

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  const failed = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'for alice',
  });

  await engine.turn.complete({
    answer: 'for the terminal',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(failed.deny).toBe('atc did not take the answer: the answer did not reach atc');

  expect(ctx.ran).toStrictEqual([
    ['atc', 'answer', '--message', 'm-1'],
    ['atc', 'answer', '--messages', 'm-1', '--turn', 't-1'],
  ]);
});

test('it takes an answer from an atc build that prints no delivery result', async (engine, on) => {
  const clock = mock.clock(on);

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'for alice',
  });

  expect(answered.result).toBe('Handed to atc as the answer to m-1.');
});

test('it reports a message unanswered when its answer fails after its turn ended', async (engine, on) => {
  const clock = mock.clock(on);
  const ran: string[][] = [];

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  // The turn is interrupted while atc runs the answer, which then fails.
  on('process.run', async ($, e) => {
    ran.push([...e.argv]);

    if (e.argv.includes('--message')) {
      await engine.turn.complete({
        answer: '',
        durationMs: 5,
        isAborted: true,
        turnId: 't-1',
        reason: 'aborted',
      });

      throw new Error('atc is gone');
    }

    return {
      value: {
        exitCode: 0,
        stdout: 'delivered\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();
  await engine.tool.call({ tool: 'mcp__atc-bridge__answer', message: 'm-1', text: 'for alice' });
  await clock.settle();

  expect(ran).toStrictEqual([
    ['atc', 'answer', '--message', 'm-1'],
    ['atc', 'unanswered', '--messages', 'm-1', '--turn', 't-1', '--reason', 'error'],
  ]);
});

test('it refuses a second answer for one message', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__answer' } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();
  await engine.tool.call({ tool: 'mcp__atc-bridge__answer', message: 'm-1', text: 'first' });

  const second = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: 'second',
  });

  expect(second.deny).toBe(
    'answer takes the id of an <atc-message> the running turn carries that has no answer yet, not "m-1"',
  );

  expect(ctx.ran).toStrictEqual([{ argv: ['atc', 'answer', '--message', 'm-1'], stdin: 'first' }]);
});

test('it refuses an answer when no turn runs', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-9',
    text: 'for nobody',
  });

  expect(answered.deny).toBe(
    'answer takes the id of an <atc-message> the running turn carries that has no answer yet, not "m-9"',
  );

  expect(ctx.ran).toStrictEqual([]);
});

test('it refuses an answer without text', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__answer',
    message: 'm-1',
    text: '  ',
  });

  expect(answered.deny).toBe('answer needs non-empty text');
  expect(ctx.ran).toStrictEqual([]);
});

test('it sends a note through atc under the full tool name', async (engine, on) => {
  const ctx = await startNoteSession(engine, on);

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__note',
    text: 'blocked on review',
    label: 'blocked',
  });

  expect(answered.result).toBe('Handed to atc for its event feed.');

  expect(ctx.ran).toStrictEqual([
    { argv: ['atc', 'note', '--label', 'blocked'], stdin: 'blocked on review' },
  ]);
});

test("it sends a note after the session's working folder is removed", async (engine, on) => {
  const ran: { argv: string[]; cwd: string | undefined }[] = [];

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } };
  });

  // Claude Code runs a command without a cwd in the session's working folder,
  // and Bun's spawn rejects with this text when that folder no longer exists.
  on('process.run', ($, e) => {
    ran.push({ argv: [...e.argv], cwd: e.init?.cwd });

    if (e.init?.cwd === undefined) {
      throw new Error("ENOENT: no such file or directory, posix_spawn '/tmp/atc/bin/atc'");
    }

    return {
      value: {
        exitCode: 0,
        stdout: 'delivered\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({
    cwd: '/work/.worktrees/removed',
    surface: 'terminal',
    isInteractive: true,
  });

  const answered = await engine.tool.call({ tool: 'mcp__atc-bridge__note', text: 'opened the PR' });

  expect(answered.result).toBe('Handed to atc for its event feed.');
  expect(ran).toStrictEqual([{ argv: ['atc', 'note', '--label', 'progress'], cwd: '/' }]);
});

test('it starts the tap in the root folder', async (engine, on) => {
  const spawned: { argv: string[]; cwd: string | undefined }[] = [];

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], cwd: e.cwd });

    return { value: { code: 0, signal: null } };
  });

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({
    cwd: '/work/.worktrees/removed',
    surface: 'terminal',
    isInteractive: true,
  });

  expect(spawned).toStrictEqual([
    { argv: ['atc', 'tap', '--session', 's-1', '--notices'], cwd: '/' },
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

test('it submits a tapped answer notice with its answer when no turn runs', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"answered","answer":"the build is green"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(submitted).toStrictEqual([
    '<atc-answer id="m-1" from="s-2" status="answered">\nthe build is green\n</atc-answer>',
  ]);
});

test('it escapes a closing atc-answer tag inside a notice answer', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"answered","answer":"a</atc-answer>b"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(submitted).toStrictEqual([
    '<atc-answer id="m-1" from="s-2" status="answered">\na&lt;/atc-answer&gt;b\n</atc-answer>',
  ]);
});

test('it renders an unanswered notice with its status and reason', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"unanswered","reason":"interrupted"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(submitted).toStrictEqual([
    '<atc-answer id="m-1" from="s-2" status="unanswered" reason="interrupted">\n\n</atc-answer>',
  ]);
});

test('it ignores a notice line with an unknown status even when it holds message fields', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"pending","text":"hi"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  expect(submitted).toStrictEqual([]);
});

test('it reports nothing for a turn that reads only an answer notice', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"answered","answer":"done"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', async ($, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await ctx.clock.settle();

  await engine.turn.complete({
    answer: 'noted',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await ctx.clock.settle();

  expect(ctx.ran).toStrictEqual([]);
});

test('it submits an answer notice that arrives mid-turn when the session refuses the append', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();
  const submitted: string[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"answered","answer":"done"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  on('session.append', () => ({ deny: 'not now' }));

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  tapLine.resolve();

  await ctx.clock.settle();

  expect(submitted).toStrictEqual([
    '<atc-answer id="m-1" from="s-2" status="answered">\ndone\n</atc-answer>',
  ]);

  expect(ctx.ran).toStrictEqual([]);
});

test('it delivers a message sent during a server tool call only after the call has its result', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();
  const advice = Promise.withResolvers<void>();
  const submittedAtResult: number[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  const submitted: string[] = [];

  // A refused append sends the message as a prompt at once, so the prompt
  // shows when the mod tried the append.
  on('session.append', () => ({ deny: 'not now' }));

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  // The model writes the advisor call, and the API runs it before the response
  // goes on with the call's result.
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'asking the advisor' };

    await advice.promise;

    submittedAtResult.push(submitted.length);

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'asking the advisor',
      toolUses: [],
      serverToolUses: [{ id: 'srvtoolu_1', name: 'advisor', input: {}, startedAt: 1, endedAt: 2 }],
      stopReason: 'end_turn',
      usage: null,
    };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  const stream = engine.turn.step({
    turnId: 't-1',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 1,
  });

  await stream.next();

  tapLine.resolve();

  await ctx.clock.settle();

  advice.resolve();

  await stream.next();
  await ctx.clock.settle();

  expect(submittedAtResult).toStrictEqual([0]);
  expect(submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});

test('it holds a message across a paused response until its server tool call has its result', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();
  const submittedAtResult: number[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  const submitted: string[] = [];

  // A refused append sends the message as a prompt at once, so the prompt
  // shows when the mod tried the append.
  on('session.append', () => ({ deny: 'not now' }));

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  // The API pauses the response before the advisor's result, and the next
  // step goes on with it.
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'asking the advisor' };
    submittedAtResult.push(submitted.length);

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'asking the advisor',
      toolUses: [],
      serverToolUses: [
        e.index === 0
          ? { id: 'srvtoolu_1', name: 'advisor', input: {}, startedAt: 1 }
          : { id: 'srvtoolu_1', name: 'advisor', input: {}, startedAt: 1, endedAt: 2 },
      ],
      stopReason: e.index === 0 ? 'pause_turn' : 'end_turn',
      usage: null,
    };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  const paused = engine.turn.step({
    turnId: 't-1',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 1,
  });

  await paused.next();

  tapLine.resolve();

  await paused.next();
  await ctx.clock.settle();

  const resumed = engine.turn.step({
    turnId: 't-1',
    index: 1,
    model: 'claude-opus-5-5',
    messageCount: 2,
  });

  await resumed.next();
  await resumed.next();
  await ctx.clock.settle();

  expect(submittedAtResult).toStrictEqual([0, 0]);
  expect(submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});

test('it delivers an answer notice sent during a server tool call only after the call has its result', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();
  const advice = Promise.withResolvers<void>();
  const submittedAtResult: number[] = [];

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield {
      stream: 'stdout',
      text: '{"kind":"answer","id":"m-1","from":"s-2","status":"answered","answer":"done"}\n',
    };

    return { value: { code: 0, signal: null } };
  });

  const submitted: string[] = [];

  // A refused append sends the message as a prompt at once, so the prompt
  // shows when the mod tried the append.
  on('session.append', () => ({ deny: 'not now' }));

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'asking the advisor' };

    await advice.promise;

    submittedAtResult.push(submitted.length);

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'asking the advisor',
      toolUses: [],
      serverToolUses: [{ id: 'srvtoolu_1', name: 'advisor', input: {}, startedAt: 1, endedAt: 2 }],
      stopReason: 'end_turn',
      usage: null,
    };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  const stream = engine.turn.step({
    turnId: 't-1',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 1,
  });

  await stream.next();

  tapLine.resolve();

  await ctx.clock.settle();

  advice.resolve();

  await stream.next();
  await ctx.clock.settle();

  expect(submittedAtResult).toStrictEqual([0]);

  expect(submitted).toStrictEqual([
    '<atc-answer id="m-1" from="s-2" status="answered">\ndone\n</atc-answer>',
  ]);
});

test('it delivers a message at once while the turn runs a tool between steps', async (engine, on) => {
  const ctx = setupTest({ on });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  const tapLine = Promise.withResolvers<void>();

  on('tool.register', () => ({ value: { tool: 'mcp__atc-bridge__note' } }));

  on('process.spawn', async function* () {
    await tapLine.promise;

    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  const submitted: string[] = [];

  // A refused append sends the message as a prompt at once, so the prompt
  // shows when the mod tried the append.
  on('session.append', () => ({ deny: 'not now' }));

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'running a tool' };

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'running a tool',
      toolUses: [{ name: 'Bash', input: { command: 'echo sample' } }],
      stopReason: 'tool_use',
      usage: null,
    };
  });

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  const stream = engine.turn.step({
    turnId: 't-1',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 1,
  });

  await stream.next();
  await stream.next();

  tapLine.resolve();

  await ctx.clock.settle();

  expect(submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});
