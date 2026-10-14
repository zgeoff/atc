// oxlint-disable zgeoff/test-beside-module -- tests run-tool.ts; GEO-433 moves it beside its module
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { getRecord } from '@atc/test-utils/get-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { DaemonPool } from '../federation/daemon-pool';
import { GatewayStore } from '../federation/gateway-store';
import { RoutingCaller } from '../federation/routing-caller';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildPrincipalCaller } from './build-principal-caller';
import { runTool } from './run-tool';

/**
 * A real daemon, `cloud`, with a TCP listener on a loopback port that takes
 * one fixed token and a principals key that lets `gw` use the local target,
 * and `caller`, the gateway's caller in front of it, acting as `gw` the way
 * `atc-gateway` hands it to the tool handlers.
 */
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-gateway-',
    options: (paths) => {
      // The token the listener takes, which the pool presents.
      writeFileSync(join(paths.dir, 'token'), `${'c'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),

        // Lets the gateway's principal use the local target.
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'token') },
      };
    },
  });

  const hello = await daemon.client.sendHello(daemon.build);

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: Number(daemon.daemon.listenPort) },
          daemonID: String(hello['daemonID']),
          token: 'c'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  const store = GatewayStore.open(join(daemon.dir, 'gateway.db'));

  registerTestCleanup(() => {
    store.stop();
  });

  const caller = buildPrincipalCaller(new RoutingCaller({ registry, pool, store }), {
    id: 'gw',
    name: 'Harbor Desk',
  });

  return { caller, cwd: daemon.dir };
}

test('it returns the adopted session for atc_session_adopt through the gateway', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.kill', { session: id });

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  const got = await ctx.caller.sendRequest('session.get', { session: id });

  expect(adopted.structured).toStrictEqual({ adopted: true });
  expect(getRecord(got, 'session')['alive']).toBe(true);
});

test('it refuses atc_session_auth_rebind through the gateway as unauthorized, since the gateway acts as a remote client', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    resume: `a-${randomUUID()}`,
  });

  const rebound = runTool(
    ctx.caller,
    'atc_session_auth_rebind',
    { session: getRecord(spawned, 'session')['id'] },
    { callerSessionID: null },
  );

  expect(rebound).rejects.toMatchObject({ code: 'unauthorized' });
});
