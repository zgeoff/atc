import { expect, mock, test } from 'claude-code/testing';

test('it registers nothing outside atc', async (engine, on) => {
  const registered: string[] = [];
  const spawned: string[][] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, {});

  on('tool.register', ($, e) => {
    registered.push(e.name);

    return { value: { tool: `mcp__atc-bridge__${e.name}` } };
  });

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);

    return { value: { code: 0, signal: null } };
  });

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(registered).toStrictEqual([]);
  expect(spawned).toStrictEqual([]);
});

test('it submits a tapped message when no turn runs', async (engine, on) => {
  const clock = mock.clock(on);
  const submitted: string[] = [];
  const spawned: string[][] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

  expect(spawned).toStrictEqual([['atc', 'tap', '--session', 's-1']]);
  expect(submitted).toStrictEqual(['<atc-message id="m-1" from="alice">\nhi\n</atc-message>']);
});

test('it reports the answer for the message a turn carried', async (engine, on) => {
  const clock = mock.clock(on);
  const ran: { argv: string[]; stdin: string | undefined }[] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push({ argv: [...e.argv], stdin: e.init?.stdin });

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

  on('prompt.submit', async (_, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

  await engine.turn.complete({
    answer: 'done',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await clock.settle();

  expect(ran).toStrictEqual([
    { argv: ['atc', 'report', 'answered', '--messages', 'm-1', '--turn', 't-1'], stdin: 'done' },
  ]);
});

test('it reports nothing for a turn that ended in an error', async (engine, on) => {
  const clock = mock.clock(on);
  const ran: { argv: string[]; stdin: string | undefined }[] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"hi"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push({ argv: [...e.argv], stdin: e.init?.stdin });

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

  on('prompt.submit', async (_, e) => {
    await engine.turn.start({ text: e.text, turnId: 't-1' });

    return { text: e.text };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

  await engine.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'error',
  });

  await clock.settle();

  expect(ran).toStrictEqual([]);
});

test('it sends a report through atc', async (engine, on) => {
  const ran: string[][] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

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

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  const answered = await engine.tool.call({
    tool: 'mcp__atc-bridge__report',
    text: 'blocked on review',
    kind: 'blocked',
  });

  expect(answered.result).toBe('Sent to the user through atc.');
  expect(ran).toStrictEqual([['atc', 'report', 'note', '--label', 'blocked']]);
});

test('it refuses a report without text', async (engine, on) => {
  const ran: string[][] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

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

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  const answered = await engine.tool.call({ tool: 'mcp__atc-bridge__report', text: '   ' });

  expect(answered.deny).toBe('report needs non-empty text');
  expect(ran).toStrictEqual([]);
});

test('it reports every message a queued turn carried in one report', async (engine, on) => {
  const clock = mock.clock(on);
  const ran: string[][] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"id":"m-1","from":"alice","text":"one"}\n{"id":"m-2","fr' };
    yield { stream: 'stdout', text: 'om":"bob","text":"two"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

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

  on('prompt.submit', ($, e) => ({ text: e.text }));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await clock.settle();

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

  await clock.settle();

  expect(ran).toStrictEqual([
    ['atc', 'report', 'answered', '--messages', 'm-1,m-2', '--turn', 't-1'],
  ]);
});

test('it submits a mid-turn message when the session refuses the append', async (engine, on) => {
  const clock = mock.clock(on);
  let release = (): void => {};

  const line = new Promise<void>((resolve) => {
    release = resolve;
  });

  const submitted: string[] = [];
  const ran: string[][] = [];

  on('ui.log', () => ({ value: undefined }));

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', ($, e) => ({ value: { tool: `mcp__atc-bridge__${e.name}` } }));

  on('process.spawn', async function* () {
    await line;

    yield { stream: 'stdout', text: '{"id":"m-3","from":"bob","text":"late"}\n' };

    return { value: { code: 0, signal: null } };
  });

  on('process.run', ($, e) => {
    ran.push([...e.argv]);

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

  on('prompt.submit', ($, e) => {
    submitted.push(e.text);

    return { text: e.text };
  });

  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await engine.turn.start({ text: 'typed by the user', turnId: 't-1' });

  release();

  await clock.settle();

  await engine.turn.complete({
    answer: 'unrelated',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  });

  await clock.settle();

  expect(submitted).toStrictEqual(['<atc-message id="m-3" from="bob">\nlate\n</atc-message>']);
  expect(ran).toStrictEqual([]);
});

test('it starts no tap when the build refuses the report tool', async (engine, on) => {
  const spawned: string[][] = [];
  const logs: string[] = [];

  on('ui.log', ($, e) => {
    logs.push(e.text);

    return { value: undefined };
  });

  mock.env(on, { ATC_SESSION_ID: 's-1' });

  on('tool.register', () => ({ deny: 'no plugin tools here' }));

  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv]);

    return { value: { code: 0, signal: null } };
  });

  on('session.start', ($, e) => ({ cwd: e.cwd }));

  await engine.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });

  expect(spawned).toStrictEqual([]);
  expect(logs).toHaveLength(1);
});
