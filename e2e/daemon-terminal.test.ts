import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  KEYS,
  createStubClaude,
  createStubCodex,
  createStubComposer,
  createStubGrok,
  getRecord,
  getString,
  registerTestCleanup,
  resolveATCCommand,
  setupTempDir,
  waitFor,
  waitForEvent,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { DaemonEvent } from '@atcx/contract';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-terminal-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(temporaryDirectory.path);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, { atc, composer }),
    grok: createStubGrok(temporaryDirectory.path, { atc, composer }),
    codex: createStubCodex(temporaryDirectory.path, { atc, composer }),
  };
}

test('it attaches a client at the size it asks for', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const attached = await client.sendRequest('session.attach', {
    session: id,
    cols: 100,
    rows: 30,
  });

  expect(attached).toStrictEqual({ cols: 100, rows: 30 });
});

test('it streams pty output to an attached client with increasing seq', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 100, rows: 30 });
  await client.sendRequest('session.input', { session: id, data: `hello${KEYS.enter}` });

  await waitForEvent(events, { ev: 'SessionOutput', data: expect.stringContaining('GOT:hello') });

  const seqs = events
    .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
    .map((daemonEvent) => daemonEvent.seq);

  expect(seqs).toStrictEqual(seqs.toSorted((left, right) => left - right));
  expect(new Set(seqs).size).toBe(seqs.length);
});

test('it stops streaming to a detached client while others keep receiving', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const leaver = await daemon.openClient();

  const leaverEvents: DaemonEvent[] = [];

  leaver.onEvent = (event) => {
    leaverEvents.push(event);
  };

  await leaver.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await leaver.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await leaver.sendRequest('session.detach', { session: id });
  await client.sendRequest('session.input', { session: id, data: `ping${KEYS.enter}` });

  await waitForEvent(events, { ev: 'SessionOutput', data: expect.stringContaining('GOT:ping') });

  // The daemon answers on the same connection it streams on, so every
  // event it sent the leaver before this answer has arrived.
  await leaver.sendRequest('session.list');

  expect(
    leaverEvents.filter(
      (daemonEvent) => daemonEvent.ev === 'SessionOutput' && daemonEvent.data.includes('GOT:ping'),
    ),
  ).toStrictEqual([]);
});

test('it resizes the pty to the smallest dims across attached clients', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const narrow = await daemon.openClient();

  await narrow.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 120, rows: 40 });

  await waitForEvent(events, { ev: 'SessionResized', cols: 120 });

  await narrow.sendRequest('session.attach', { session: id, cols: 90, rows: 28 });

  const shrunk = await waitForEvent(events, { ev: 'SessionResized', cols: 90 });

  expect(shrunk).toMatchObject({ sessionID: id, cols: 90, rows: 28 });
});

test('it resizes the pty before the attach replay reaches the client', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const joiner = await daemon.openClient();

  const events: DaemonEvent[] = [];

  joiner.onEvent = (event) => {
    events.push(event);
  };

  await joiner.sendHello('atc/test');
  await joiner.sendRequest('session.attach', { session: id, cols: 100, rows: 30 });

  await waitForEvent(events, { ev: 'SessionOutput', sessionID: id });

  const resizedAt = events.findIndex(
    (daemonEvent) => daemonEvent.ev === 'SessionResized' && daemonEvent.cols === 100,
  );

  const outputAt = events.findIndex(
    (daemonEvent) => daemonEvent.ev === 'SessionOutput' && daemonEvent.sessionID === id,
  );

  expect(resizedAt).toBeGreaterThanOrEqual(0);
  expect(outputAt).toBeGreaterThan(resizedAt);
});

test('it reads the current screen of a session as plain text without attaching', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  // Input typed before the stub prints its banner echoes above it, so the
  // banner is waited for first.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');
  });

  await client.sendRequest('session.input', { session: id, data: `hello${KEYS.enter}` });

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('GOT:hello');

    return read;
  });

  expect(screen).toStrictEqual({
    text: expect.toStartWith('FAKE_CLAUDE_UP args:'),
    cols: 80,
    rows: 24,
  });

  expect(screen['text']).not.toInclude('\u001B');
});

test('it bumps the attach recency of a session it attaches', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const seed = await createStateStore(join(daemon.stateDir, 'atc.db'));

  registerTestCleanup(() => seed.stop());

  // A stored attach time far in the past, which the restore keeps.
  await seed.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-recent'),
      cwd: ctx.home,
      lastAttachedAt: 1000,
    }),
  ]);

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const start = Date.now();

  await client.sendRequest('session.attach', { session: 's-recent', cols: 80, rows: 24 });

  const listed = await client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [{ id: 's-recent', lastAttachedAt: expect.toBeWithin(start, Date.now() + 1) }],
  });
});

test.each([['codex'], ['grok']])(
  'it submits a line to a %s session as one submission',
  async (agent) => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({
        agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
      }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    const client = await daemon.openClient();

    const events: DaemonEvent[] = [];

    client.onEvent = (event) => {
      events.push(event);
    };

    await client.sendHello('atc/test');

    const ok = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(ok, 'session'), 'id');

    await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

    // A submit reads the paste mode from the daemon's screen model, which can lag the output the
    // client sees. A screen read waits for the parse, so once it shows the banner, the paste mode
    // the composer turned on just before it is in force.
    await waitFor(async () => {
      const read = await client.sendRequest('session.screen', { session: id });

      expect(read['text']).toInclude('FAKE_COMPOSER_READY');
    });

    await client.sendRequest('session.submit', { session: id, text: 'hello' });

    const submitted = await waitFor(() => {
      const output = events
        .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
        .map((daemonEvent) => daemonEvent.data)
        .join('');

      expect(output).toMatch(/SUBMIT:.*\r/u);

      return output;
    });

    expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual(['SUBMIT:"hello"']);
  },
);

test('it submits a multi-line text to a codex session as one submission', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the
  // banner, the paste mode the composer turned on just before it is in
  // force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: 'first\nsecond' });

  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual([String.raw`SUBMIT:"first\nsecond"`]);
});

test('it submits a line to a claude session as one line', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitForEvent(events, {
    ev: 'SessionOutput',
    data: expect.stringContaining('FAKE_CLAUDE_UP'),
  });

  await client.sendRequest('session.submit', { session: id, text: 'hello' });

  const got = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/GOT:.*\r/u);

    return output;
  });

  expect(got.match(/GOT:.*/gu)).toStrictEqual(['GOT:hello']);
});

test('it submits a long line to a claude session as one submission', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-composer'), '');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the
  // banner, the paste mode the composer turned on just before it is in
  // force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: 'a'.repeat(1600) });

  // A PTY can deliver the long SUBMIT line across several output events, so
  // the check reads the output joined.
  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual([`SUBMIT:"${'a'.repeat(1600)}"`]);
});

test('it types a slash command name to a claude session and pastes its long argument', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-composer'), '');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the
  // banner, the paste mode the composer turned on just before it is in
  // force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', {
    session: id,
    text: `/goal ${'a'.repeat(1994)}`,
  });

  // The composer echoes every byte it has read after each read, so its
  // last echo holds the whole input as it arrived.
  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/RECEIVED:.*/gu)?.at(-1)).toBe(
    `RECEIVED:${JSON.stringify(`/goal ${KEYS.pasteOpen}${'a'.repeat(1994)}${KEYS.pasteClose}${KEYS.enter}`)}`,
  );

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual([`SUBMIT:"/goal ${'a'.repeat(1994)}"`]);
});

test('it pastes a slash command line to a grok session whole', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the
  // banner, the paste mode the composer turned on just before it is in
  // force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', { session: id, text: '/goal finish it' });

  // The composer echoes every byte it has read after each read, so its
  // last echo holds the whole input as it arrived.
  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/RECEIVED:.*/gu)?.at(-1)).toBe(
    `RECEIVED:${JSON.stringify(`${KEYS.pasteOpen}/goal finish it${KEYS.pasteClose}${KEYS.enter}`)}`,
  );

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual(['SUBMIT:"/goal finish it"']);
});

test('it pastes a slash command name to a codex session on its own before its long argument', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the
  // banner, the paste mode the composer turned on just before it is in
  // force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.submit', {
    session: id,
    text: `/goal ${'a'.repeat(1994)}`,
  });

  // The composer echoes every byte it has read after each read, so its
  // first echo holds its first read and its last echo the whole input.
  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/RECEIVED:.*/gu)?.at(0)).toBe(
    `RECEIVED:${JSON.stringify(`${KEYS.pasteOpen}/goal ${KEYS.pasteClose}`)}`,
  );

  expect(submitted.match(/RECEIVED:.*/gu)?.at(-1)).toBe(
    `RECEIVED:${JSON.stringify(
      `${KEYS.pasteOpen}/goal ${KEYS.pasteClose}${KEYS.pasteOpen}${'a'.repeat(1994)}${KEYS.pasteClose}${KEYS.enter}`,
    )}`,
  );

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual([`SUBMIT:"/goal ${'a'.repeat(1994)}"`]);
});

test('it holds input sent while a codex slash command line pauses until the line is submitted', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // A screen read waits for the daemon's parse, so once it shows the
  // banner, the paste mode the composer turned on just before it is in
  // force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  const line = client.sendRequest('session.submit', { session: id, text: '/goal finish it' });

  await client.sendRequest('session.input', { session: id, data: 'x' });

  const lineWhenInputAnswered = Bun.peek.status(line);

  await line;

  // The composer echoes every byte it has read after each read, so its
  // last echo holds the whole input as it arrived.
  const received = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toInclude(String.raw`\rx"`);

    return output;
  });

  expect(lineWhenInputAnswered).toBe('pending');

  expect(received.match(/RECEIVED:.*/gu)?.at(-1)).toBe(
    `RECEIVED:${JSON.stringify(
      `${KEYS.pasteOpen}/goal ${KEYS.pasteClose}${KEYS.pasteOpen}finish it${KEYS.pasteClose}${KEYS.enter}x`,
    )}`,
  );
});

test('it pastes a long line to a busy claude session as it does to an idle one', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-composer-last'), '');

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    '{"hook_event_name":"UserPromptSubmit","session_id":"fake-1","prompt":"work"}\n',
  );

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  // The stub reports the prompt before its composer starts, so once the
  // screen shows the composer's banner the session is busy and the paste
  // mode the composer turned on is in force.
  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, state: 'running' }] });
  });

  await client.sendRequest('session.submit', { session: id, text: 'a'.repeat(1600) });

  // The composer echoes every byte it has read after each read, so its
  // last echo holds the whole input as it arrived.
  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/RECEIVED:.*/gu)?.at(-1)).toBe(
    `RECEIVED:${JSON.stringify(`${KEYS.pasteOpen}${'a'.repeat(1600)}${KEYS.pasteClose}${KEYS.enter}`)}`,
  );

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual([`SUBMIT:"${'a'.repeat(1600)}"`]);
});

test('it submits a claude composer draft on an empty line without adding a line to it', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-composer'), '');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_COMPOSER_READY');
  });

  await client.sendRequest('session.input', { session: id, data: 'draft' });

  await waitForEvent(events, {
    ev: 'SessionOutput',
    data: expect.stringContaining('RECEIVED:"draft"'),
  });

  await client.sendRequest('session.submit', { session: id, text: '' });

  const submitted = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/SUBMIT:.*\r/u);

    return output;
  });

  expect(submitted.match(/SUBMIT:.*/gu)).toStrictEqual(['SUBMIT:"draft"']);
});

test('it writes raw input to a codex session byte for byte', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude }, grok: { bin: ctx.grok }, codex: { bin: ctx.codex } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });

  await waitForEvent(events, {
    ev: 'SessionOutput',
    data: expect.stringContaining('FAKE_COMPOSER_READY'),
  });

  await client.sendRequest('session.input', { session: id, data: `abc${KEYS.up}x${KEYS.enter}` });

  const received = await waitFor(() => {
    const output = events
      .filter((daemonEvent) => daemonEvent.ev === 'SessionOutput')
      .map((daemonEvent) => daemonEvent.data)
      .join('');

    expect(output).toMatch(/RECEIVED:.*\\r"\r/u);

    return output;
  });

  expect(received.match(/RECEIVED:.*/gu)?.at(-1)).toBe(String.raw`RECEIVED:"abc\u001b[Ax\r"`);
});
