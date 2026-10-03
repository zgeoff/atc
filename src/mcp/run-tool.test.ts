import { expect, test } from 'bun:test';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { runTool } from './run-tool';

test('it sends a message from a fixed sender whatever sender the call gives', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello', from: 'owner' },
    { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'dots' } },
  ]);
});

test('it sends a message from the sender the call gives over a default sender', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello', from: 'reviewer' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'reviewer' } },
  ]);
});

test('it sends a message from a default sender when the call gives none', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'mcp' } },
  ]);
});

test('it forwards a message wait to the daemon', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1', status: 'delivered' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_message_get',
    { message: 'm1', waitMs: 20_000 },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([{ m: 'message.get', p: { message: 'm1', waitMs: 20_000 } }]);
});

test('it forwards an events session filter to the daemon', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ events: [], cursor: 'c', more: false });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_events_read',
    { session: 's1', waitMs: 1000 },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([{ m: 'events.read', p: { waitMs: 1000, session: 's1' } }]);
});
