import { expect, mock, test } from 'bun:test';
import type { EventMsg } from '../protocol/protocol';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import type { SessionID } from '../shared/session-id';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

test('it flags a hook-less agent waiting at a prompt via the screen detector', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-detector-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        screenDetector: {
          detectAttention: (screen) =>
            screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working',
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

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 60, rows: 12 });

  await waitFor(() => {
    expect(
      daemon.events.find(
        (e) =>
          e.ev === 'SessionState' &&
          isRecord(e['session']) &&
          e['session']['state'] === 'needs_you',
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
    cwd: daemon.dir,
    cols: 60,
    rows: 12,
  });

  const id = getRecord(spawned, 'session')['id'];

  await waitFor(() => {
    expect(daemon.events).toSatisfyAny(
      (e: EventMsg) =>
        e.ev === 'SessionState' &&
        isRecord(e['session']) &&
        e['session']['id'] === id &&
        e['session']['state'] === 'needs_you',
    );
  });

  await daemon.client.sendRequest('session.input', { session: id, d: 'go\n' });

  await waitFor(() => {
    expect(daemon.events).toSatisfyAny(
      (e: EventMsg) =>
        e.ev === 'SessionState' &&
        isRecord(e['session']) &&
        e['session']['id'] === id &&
        e['session']['state'] === 'running' &&
        e['session']['lastMsg'] === 'working',
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

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 60, rows: 12 });

  await waitFor(() => {
    expect(daemon.events.find((e) => e.ev === 'PermissionRequested')).toMatchObject({
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
    cwd: daemon.dir,
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
      (e: EventMsg) =>
        e.ev === 'SessionOutput' && typeof e['d'] === 'string' && e['d'].includes('READY>'),
    );
  });

  expect(onDetectSkipped).toHaveBeenCalledWith(id);

  expect(daemon.events).not.toSatisfyAny(
    (e: EventMsg) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
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
          screenDetector: { detectAttention: () => 'needs-input' },
        }),
      ],
      onDetectSkipped,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
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
      (e: EventMsg) =>
        e.ev === 'SessionOutput' && typeof e['d'] === 'string' && e['d'].includes('READY>'),
    );
  });

  expect(onDetectSkipped).toHaveBeenCalledWith(id);

  expect(daemon.events).not.toSatisfyAny(
    (e: EventMsg) =>
      e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );
});
