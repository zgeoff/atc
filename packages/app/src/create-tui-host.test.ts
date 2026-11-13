import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFile } from '@atc/config';
import { logClientEvent } from '@atc/lifecycle';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { createTUIHost } from './create-tui-host';

test("it hands the client lifecycle's client event log, so the client writes no log file itself", () => {
  const host = createTUIHost(buildMockLifecycleHost());

  expect(host.logEvent).toBe(logClientEvent);
});

test('it hands the client the local daemon as its primary, with no daemon name', () => {
  const host = createTUIHost(buildMockLifecycleHost());

  expect(host.daemons.map((daemon) => daemon.name)).toStrictEqual([null]);
});

test('it follows the local daemon with each daemon of the config in config order', () => {
  mkdirSync(dirname(configFile), { recursive: true });

  writeFileSync(
    configFile,
    JSON.stringify({
      daemons: {
        lab: { address: '127.0.0.1:7421', principal: 'laptop', tokenFile: '/tmp/lab.token' },
        box: { address: '127.0.0.1:7420', principal: 'laptop', tokenFile: '/tmp/box.token' },
      },
    }),
  );

  const host = createTUIHost(buildMockLifecycleHost());

  expect(host.daemons.map((daemon) => daemon.name)).toStrictEqual([null, 'lab', 'box']);
});
