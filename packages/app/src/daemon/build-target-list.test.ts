import { expect, onTestFinished, test } from 'bun:test';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { buildTargetList } from './build-target-list';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * An imp provider over a stub imp port.
 */
function setupTest() {
  const port = createStubImpPort();

  const provider = new ImpProvider(port, {}, { atcBinary: null });

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { provider };
}

test('it lists an imp target as reaching the broker', () => {
  const ctx = setupTest();

  const entries = buildTargetList(
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider }],
    null,
  );

  expect(entries).toStrictEqual([
    {
      id: 'box',
      provider: 'imp',
      identity: 'imp:test',
      available: true,
      default: false,
      capabilities: {
        spawn: true,
        attach: true,
        input: true,
        resize: true,
        kill: true,
        transfer: true,
        run: true,
        headless: false,
        suspend: true,
        destroy: true,
      },
      brokerAuth: true,
    },
  ]);
});

test('it lists the local target and a target without a provider as reaching no broker', () => {
  const local = new LocalPTYProvider();

  onTestFinished(() => {
    local.dispose();
  });

  const entries = buildTargetList(
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: 'local-pty:test',
        provider: local,
      },
      { id: 'gone', kind: 'imp', options: {}, identity: 'imp:gone', provider: null },
    ],
    'local',
  );

  expect(entries).toStrictEqual([
    {
      id: 'local',
      provider: 'local-pty',
      identity: 'local-pty:test',
      available: true,
      default: true,
      capabilities: {
        spawn: true,
        attach: true,
        input: true,
        resize: true,
        kill: true,
        transfer: true,
        run: true,
        headless: true,
        suspend: false,
        destroy: false,
      },
      brokerAuth: false,
    },
    {
      id: 'gone',
      provider: 'imp',
      identity: 'imp:gone',
      available: false,
      default: false,
      capabilities: {
        spawn: false,
        attach: false,
        input: false,
        resize: false,
        kill: false,
        transfer: false,
        run: false,
        headless: false,
        suspend: false,
        destroy: false,
      },
      brokerAuth: false,
    },
  ]);
});
