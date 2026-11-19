import { expect, test } from 'bun:test';
import { DaemonUnavailableError } from './daemon-unavailable-error';
import { formatDaemonFailure, sendToDaemon } from './send-to-daemon';

test('it sends a request through the client of the daemon it names', async () => {
  const asked: string[] = [];

  const links = {
    clientFor: (daemon: string | null) => ({
      sendRequest: (method: string) => {
        asked.push(`${daemon ?? 'local'}:${method}`);

        return Promise.resolve({});
      },
    }),
    stateOf: () => ({ kind: 'up' }) as const,
  };

  await sendToDaemon(links, 'box', 'session.kill');
  await sendToDaemon(links, null, 'session.kill');

  expect(asked).toStrictEqual(['box:session.kill', 'local:session.kill']);
});

test('it rejects with the daemon and its state, and sends nothing, when the link is not up', () => {
  const links = {
    clientFor: () => null,
    stateOf: () => ({ kind: 'down', detail: 'the connection dropped' }) as const,
  };

  expect(sendToDaemon(links, 'box', 'session.kill')).rejects.toThrowWithMessage(
    DaemonUnavailableError,
    'box: down — the connection dropped',
  );
});

test("#formatDaemonFailure says a link's state as it is", () => {
  expect(formatDaemonFailure('box', new DaemonUnavailableError('box: down — dropped'))).toBe(
    'box: down — dropped',
  );
});

test('#formatDaemonFailure names the remote daemon with its refusal', () => {
  expect(formatDaemonFailure('box', new Error('principal laptop may not stop this session'))).toBe(
    'box: principal laptop may not stop this session',
  );
});

test('#formatDaemonFailure says nothing of a failure on the local daemon', () => {
  expect(formatDaemonFailure(null, new Error('refused'))).toBeNull();
});
