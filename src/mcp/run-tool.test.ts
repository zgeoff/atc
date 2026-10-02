import { expect, test } from 'bun:test';
import { runTool } from './run-tool';

test('it sends a message from a fixed sender whatever sender the call gives', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
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
    },
    'atc_session_message',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'mcp' } },
  ]);
});
