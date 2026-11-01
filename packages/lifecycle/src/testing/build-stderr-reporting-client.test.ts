import { expect, mock, test } from 'bun:test';
import { buildStderrReportingClient } from './build-stderr-reporting-client';

test('it writes the daemon stderr when a request rejects with an internal error', async () => {
  const writeReport = mock<(text: string) => void>();

  const client = buildStderrReportingClient(
    {
      sendRequest: () =>
        Promise.reject(Object.assign(new Error('spawn broke'), { code: 'internal' })),
    },
    () => 'Failed to load lib\n',
    writeReport,
  );

  expect(client.sendRequest()).rejects.toThrowWithMessage(Error, 'spawn broke');

  await Promise.resolve();

  expect(writeReport).toHaveBeenCalledExactlyOnceWith(
    'the daemon answered an internal error; its stderr:\nFailed to load lib\n',
  );
});

test('it writes the daemon stderr for an internal error from a nested procedure', async () => {
  const writeReport = mock<(text: string) => void>();

  const client = buildStderrReportingClient(
    {
      procedures: {
        session: {
          spawn: () =>
            Promise.reject(Object.assign(new Error('spawn broke'), { code: 'internal' })),
        },
      },
    },
    () => 'Failed to load lib\n',
    writeReport,
  );

  expect(client.procedures.session.spawn()).rejects.toThrowWithMessage(Error, 'spawn broke');

  await Promise.resolve();

  expect(writeReport).toHaveBeenCalledOnce();
});

test('it writes nothing when a request rejects with a refusal of another code', async () => {
  const writeReport = mock<(text: string) => void>();

  const client = buildStderrReportingClient(
    {
      sendRequest: () =>
        Promise.reject(Object.assign(new Error('no such session'), { code: 'not_found' })),
    },
    () => 'Failed to load lib\n',
    writeReport,
  );

  expect(client.sendRequest()).rejects.toThrowWithMessage(Error, 'no such session');

  await Promise.resolve();

  expect(writeReport).not.toHaveBeenCalled();
});

test('it passes a request that resolves through unchanged', () => {
  const client = buildStderrReportingClient(
    { sendRequest: () => Promise.resolve({ ok: true }) },
    () => '',
    () => {},
  );

  expect(client.sendRequest()).resolves.toStrictEqual({ ok: true });
});
