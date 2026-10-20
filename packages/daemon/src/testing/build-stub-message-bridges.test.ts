import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import type { MessageBridgeHost } from '@atc/plugin-api';
import { buildStubMessageBridges } from './build-stub-message-bridges';

test('it records each start and answers with a bridge on the stub binary', async () => {
  const stub = buildStubMessageBridges();

  const request = {
    session: toSessionID('s-1'),
    cwd: '/work/app',
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
    directory: '/state/sessions/s-1/codex',
    host: {
      attachTap: mock<MessageBridgeHost['attachTap']>(),
      detachTap: mock<MessageBridgeHost['detachTap']>(),
      ackMessage: mock<MessageBridgeHost['ackMessage']>(),
      ackNotice: mock<MessageBridgeHost['ackNotice']>(),
      applyNote: mock<MessageBridgeHost['applyNote']>(),
      readUnsettledMessages: mock<MessageBridgeHost['readUnsettledMessages']>(),
      log: mock<MessageBridgeHost['log']>(),
    },
  };

  const bridge = await stub.startMessageBridge(request);

  expect(stub.requests).toStrictEqual([request]);
  expect(stub.bridges).toStrictEqual([bridge]);
  expect(bridge.plan).toStrictEqual({ bin: 'stub-bridge', args: [] });
});

test('it records what the daemon asks of a bridge', async () => {
  const stub = buildStubMessageBridges();

  await stub.startMessageBridge({
    session: toSessionID('s-1'),
    cwd: '/work/app',
    env: {},
    withheldEnv: [],
    options: { prompt: '', resume: false },
    directory: '/state/sessions/s-1/codex',
    host: {
      attachTap: mock<MessageBridgeHost['attachTap']>(),
      detachTap: mock<MessageBridgeHost['detachTap']>(),
      ackMessage: mock<MessageBridgeHost['ackMessage']>(),
      ackNotice: mock<MessageBridgeHost['ackNotice']>(),
      applyNote: mock<MessageBridgeHost['applyNote']>(),
      readUnsettledMessages: mock<MessageBridgeHost['readUnsettledMessages']>(),
      log: mock<MessageBridgeHost['log']>(),
    },
  });

  const [bridge] = stub.bridges;

  bridge?.startDelivery();
  bridge?.updateThread('thread-2');

  await bridge?.stop();

  expect(bridge?.countDeliveryStarts()).toBe(1);
  expect(bridge?.threads).toStrictEqual(['thread-2']);
  expect(bridge?.countStops()).toBe(1);
});
