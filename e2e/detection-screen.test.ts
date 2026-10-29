import { expect, mock, test } from 'bun:test';
import { isRecord } from '@atc/core';
import { buildMockAgentAdapter, getRecord, waitFor } from '@atc/test-utils';
import type { DaemonEvent, SessionID } from '@atcx/contract';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it flags a hook-less agent waiting at a prompt via the screen detector', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-detector-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        screenDetector: {
          detectAttention: (screen) =>
            screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working',
          untilAgentStart: false,
        },
        planSpawn: () => ({
          bin: 'bash',
          args: [
            '-c',
            String.raw`printf "READY>"; read -r line; printf "crunching %s\n" "$line"; sleep 30`,
          ],
        }),
      }),
    }),
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.directory, cols: 60, rows: 12 });

  await waitFor(() => {
    expect(
      daemon.events.find(
        (daemonEvent) =>
          daemonEvent.ev === 'SessionState' &&
          isRecord(daemonEvent.session) &&
          daemonEvent.session.state === 'needs_you',
      ),
    ).toMatchObject({ session: { lastMsg: 'waiting at a prompt' } });
  });
});

test('it flips the session back to working once the prompt is answered', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-detector-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        screenDetector: {
          detectAttention: (screen) =>
            screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working',
          untilAgentStart: false,
        },
        planSpawn: () => ({
          bin: 'bash',
          args: [
            '-c',
            String.raw`printf "READY>"; read -r line; printf "crunching %s\n" "$line"; sleep 30`,
          ],
        }),
      }),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 60,
    rows: 12,
  });

  const id = getRecord(spawned, 'session')['id'];

  await waitFor(() => {
    expect(daemon.events).toSatisfyAny(
      (daemonEvent: DaemonEvent) =>
        daemonEvent.ev === 'SessionState' &&
        isRecord(daemonEvent.session) &&
        daemonEvent.session.id === id &&
        daemonEvent.session.state === 'needs_you',
    );
  });

  await daemon.client.sendRequest('session.input', { session: id, data: 'go\n' });

  await waitFor(() => {
    expect(daemon.events).toSatisfyAny(
      (daemonEvent: DaemonEvent) =>
        daemonEvent.ev === 'SessionState' &&
        isRecord(daemonEvent.session) &&
        daemonEvent.session.id === id &&
        daemonEvent.session.state === 'running' &&
        daemonEvent.session.lastMsg === 'working',
    );
  });
});

test('it opens a permission request from a screen-detected prompt', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-detector-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        screenDetector: {
          detectAttention: (screen) =>
            screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working',
          untilAgentStart: false,
        },
        planSpawn: () => ({
          bin: 'bash',
          args: [
            '-c',
            String.raw`printf "READY>"; read -r line; printf "crunching %s\n" "$line"; sleep 30`,
          ],
        }),
      }),
    }),
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.directory, cols: 60, rows: 12 });

  await waitFor(() => {
    expect(
      daemon.events.find((daemonEvent) => daemonEvent.ev === 'PermissionRequested'),
    ).toMatchObject({
      message: 'waiting at a prompt',
      respondable: false,
    });
  });
});

test('it never flags a prompt as needing input when the adapter has no screen detector', async () => {
  const onDetectSkipped = mock<(sessionID: SessionID) => void>();

  const daemon = await startTestDaemon({
    prefix: 'atc-detector-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({
          bin: 'bash',
          args: [
            '-c',
            String.raw`printf "READY>"; read -r line; printf "crunching %s\n" "$line"; sleep 30`,
          ],
        }),
      }),
      onDetectSkipped,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 60,
    rows: 12,
  });

  const id = getRecord(spawned, 'session')['id'];

  // Output reaches an attached client only after the daemon has decided
  // whether to judge it, so the painted prompt arriving means the decision
  // for the prompt's output has been made.
  await daemon.client.sendRequest('session.attach', { session: id, cols: 60, rows: 12 });

  await waitFor(() => {
    expect(daemon.events).toSatisfyAny(
      (daemonEvent: DaemonEvent) =>
        daemonEvent.ev === 'SessionOutput' &&
        typeof daemonEvent.data === 'string' &&
        daemonEvent.data.includes('READY>'),
    );
  });

  expect(onDetectSkipped).toHaveBeenCalledWith(id);

  expect(daemon.events).not.toSatisfyAny(
    (daemonEvent: DaemonEvent) =>
      daemonEvent.ev === 'SessionState' &&
      isRecord(daemonEvent.session) &&
      daemonEvent.session.state === 'needs_you',
  );
});

test('it never flags a prompt as needing input when another agent has a screen detector but the session agent has none', async () => {
  const onDetectSkipped = mock<(sessionID: SessionID) => void>();

  const daemon = await startTestDaemon({
    prefix: 'atc-detector-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({
          bin: 'bash',
          args: [
            '-c',
            String.raw`printf "READY>"; read -r line; printf "crunching %s\n" "$line"; sleep 30`,
          ],
        }),
      }),
      adapters: [
        buildMockAgentAdapter({
          id: 'zai',
          screenDetector: { detectAttention: () => 'needs-input', untilAgentStart: false },
        }),
      ],
      onDetectSkipped,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 60,
    rows: 12,
  });

  const id = getRecord(spawned, 'session')['id'];

  // Output reaches an attached client only after the daemon has decided
  // whether to judge it, so the painted prompt arriving means the decision
  // for the prompt's output has been made.
  await daemon.client.sendRequest('session.attach', { session: id, cols: 60, rows: 12 });

  await waitFor(() => {
    expect(daemon.events).toSatisfyAny(
      (daemonEvent: DaemonEvent) =>
        daemonEvent.ev === 'SessionOutput' &&
        typeof daemonEvent.data === 'string' &&
        daemonEvent.data.includes('READY>'),
    );
  });

  expect(onDetectSkipped).toHaveBeenCalledWith(id);

  expect(daemon.events).not.toSatisfyAny(
    (daemonEvent: DaemonEvent) =>
      daemonEvent.ev === 'SessionState' &&
      isRecord(daemonEvent.session) &&
      daemonEvent.session.state === 'needs_you',
  );
});
