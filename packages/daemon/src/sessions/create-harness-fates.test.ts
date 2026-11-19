import { expect, mock, test } from 'bun:test';
import type { HarnessFate } from '@atc/plugin-api';
import { toSessionID } from '@atcx/contract';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { buildStubMemoryProvider } from '../test-utils/build-stub-memory-provider';
import { createHarnessFates } from './create-harness-fates';
import type { Session } from './session';

interface SetupConfig {
  readonly fate: HarnessFate | 'fail';
}

function setupTest(config: SetupConfig) {
  const session = buildMockSession({
    id: toSessionID('s-1'),
    hostKey: toSessionID('s-1'),
    target: 'box',
    suspended: true,
    state: 'exited',
    lastMsg: 'asleep',
    pty: null,
  });

  const fate = config.fate;

  const provider = buildStubMemoryProvider({
    kind: 'box',
    remote: true,
    readHarnessFates: (_host, sessions) => {
      if (fate === 'fail') {
        return Promise.reject(new Error('unreachable'));
      }

      const fates = new Map<string, HarnessFate>(sessions.map((id) => [id, fate]));

      return Promise.resolve(fates);
    },
  });

  const sessions: Session[] = [session];

  const registry = {
    sessions,
    targets: new Map([
      ['box', buildMockExecutionTarget({ id: 'box', kind: 'box', identity: 'box:test', provider })],
    ]),
  };

  const callbacks = { log: mock<(line: string) => void>(), onEvent: mock<() => void>() };

  return { session, registry, callbacks, fates: createHarnessFates({ registry, callbacks }) };
}

test('it lists a sleeping session whose host lost its harness with the message of an ended harness', async () => {
  const ctx = setupTest({ fate: 'lost' });

  await ctx.fates.readFates();

  expect(ctx.session.lastMsg).toBe('host lost the process');
  expect(ctx.callbacks.onEvent).toHaveBeenCalledTimes(1);
});

test.each(['kept', 'unknown'] as const)(
  'it leaves a session whose fate is %s as it is',
  async (fate) => {
    const ctx = setupTest({ fate });

    await ctx.fates.readFates();

    expect(ctx.session.lastMsg).toBe('asleep');
  },
);

test('it leaves every session as it is, and logs, when the read fails', async () => {
  const ctx = setupTest({ fate: 'fail' });

  await ctx.fates.readFates();

  expect(ctx.session.lastMsg).toBe('asleep');
  expect(ctx.callbacks.log).toHaveBeenCalledTimes(1);
});

test('it leaves a session that was forgotten while the read ran', async () => {
  const ctx = setupTest({ fate: 'lost' });
  const read = ctx.fates.readFates();

  ctx.registry.sessions.length = 0;

  await read;

  expect(ctx.session.lastMsg).toBe('asleep');
});
