import { expect, mock, test } from 'claude-code/testing';

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

  expect(submitted).toEqual(['<atc-message id="m-3" from="bob">\nlate\n</atc-message>']);
  expect(ran).toEqual([]);
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

  expect(spawned).toEqual([]);
  expect(logs).toHaveLength(1);
});
