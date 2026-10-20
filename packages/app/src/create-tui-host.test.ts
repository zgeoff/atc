import { expect, test } from 'bun:test';
import { logClientEvent } from '@atc/lifecycle';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { createTUIHost } from './create-tui-host';

test("it hands the client lifecycle's client event log, so the client writes no log file itself", () => {
  const host = createTUIHost(buildMockLifecycleHost());

  expect(host.logEvent).toBe(logClientEvent);
});

test('it hands the client the local daemon, with no daemon name', () => {
  const host = createTUIHost(buildMockLifecycleHost());

  expect(host.daemonName).toBeNull();
});
