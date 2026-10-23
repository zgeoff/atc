import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubExecutionProvider } from '@atc/execution-local/testing';
import { buildMockAgentAdapter, buildStubClock, getRecord, waitFor } from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it writes the bridge mod again and notes it in the feed for a remote session whose tap stays gone', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    prefix: 'atc-bridge-revival-',
    options: (paths) => {
      const provider = {
        ...createStubExecutionProvider({ kind: 'imp-like', remote: true }),
        readGuest: () =>
          Promise.resolve({ directory: join(paths.directory, 'guest'), atc: '/opt/atc/bin/atc' }),
      };

      return {
        adapter: buildMockAgentAdapter({
          takesMessages: true,
          planGuestBridgeFiles: (atc) => ({
            'atc-bridge/hooks/atc-cli.ts': `export const ATC_CLI = ["${atc}"];\n`,
          }),
        }),
        targets: [{ id: 'box', kind: provider.kind, options: {}, identity: 'test:box', provider }],
        defaultTarget: 'box',
        clock,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });

  tap.stop();

  await waitFor(() => {
    expect(clock.collectPending()).toContain(30_000);
  });

  clock.advance(30_000);

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({
      ev: 'SessionNote',
      sessionID: id,
      kind: 'progress',
    });
  });

  expect(
    readFileSync(
      join(daemon.directory, 'guest', 'sessions', id, 'atc-bridge', 'hooks', 'atc-cli.ts'),
      'utf8',
    ),
  ).toBe('export const ATC_CLI = ["/opt/atc/bin/atc"];\n');
});

test('it writes the bridge mod again for a started remote session that never attached a tap, which then takes messages once one attaches', async () => {
  const clock = buildStubClock(0);

  const daemon = await startTestDaemon({
    prefix: 'atc-bridge-revival-',
    options: (paths) => {
      const provider = {
        ...createStubExecutionProvider({ kind: 'imp-like', remote: true }),
        readGuest: () =>
          Promise.resolve({ directory: join(paths.directory, 'guest'), atc: '/opt/atc/bin/atc' }),
      };

      return {
        adapter: buildMockAgentAdapter({
          takesMessages: true,
          planHookEvents: () => ({ events: [{ kind: 'started' }] }),
          planGuestBridgeFiles: (atc) => ({
            'atc-bridge/hooks/atc-cli.ts': `export const ATC_CLI = ["${atc}"];\n`,
          }),
        }),
        targets: [{ id: 'box', kind: provider.kind, options: {}, identity: 'test:box', provider }],
        defaultTarget: 'box',
        clock,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.sendHookLines({ atcId: id, event: 'SessionStart', payload: {} });

  await waitFor(() => {
    expect(clock.collectPending()).toContain(30_000);
  });

  clock.advance(30_000);

  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({
      ev: 'SessionNote',
      sessionID: id,
      kind: 'progress',
    });
  });

  const refused = await daemon.client
    .sendRequest('session.message', { session: id, text: 'before the tap' })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const tap = await daemon.openClient();

  await tap.sendRequest('session.tap', { session: id });

  const sent = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'after the tap',
  });

  expect(
    readFileSync(
      join(daemon.directory, 'guest', 'sessions', id, 'atc-bridge', 'hooks', 'atc-cli.ts'),
      'utf8',
    ),
  ).toBe('export const ATC_CLI = ["/opt/atc/bin/atc"];\n');

  expect(refused).toMatchObject({
    code: 'unsupported',
    message: `session '${id}' never attached a message tap`,
  });

  expect(sent).toStrictEqual({ message: expect.toStartWith('m-'), status: 'queued' });
});
