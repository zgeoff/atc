import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './shared/report';
import { setupTempDir } from './test-utils/setup-temp-dir';

// A tap inside a remote host against a listener standing in for the
// session bridge. The listener opens the tap, hands each request line to
// the test's responder, and writes back the lines it returns.
function setupTest(
  respond: (request: Readonly<Record<string, unknown>>) => readonly Record<string, unknown>[],
) {
  const tmp = setupTempDir('atc-bridge-tap-');
  const sock = join(tmp.dir, 'bridge.sock');
  const outbox = join(tmp.dir, 'outbox');
  let pending = '';

  mkdirSync(outbox);

  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, buf) {
        const lines = `${pending}${buf.toString()}`.split('\n');

        pending = lines.pop() ?? '';

        for (const line of lines.filter((text) => text !== '')) {
          const parsed: unknown = JSON.parse(line);
          const request = isRecord(parsed) ? parsed : {};

          const answers =
            request['op'] === 'tap.open' ? [{ id: 'tap.open', ok: true }] : respond(request);

          for (const answer of answers) {
            socket.write(`${JSON.stringify(answer)}\n`);
          }
        }
      },
      open() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  return {
    dir: tmp.dir,
    outbox,
    runTap: () =>
      Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'tap', '--session', 's1'], {
        env: { ...process.env, ATC_BRIDGE: '1', ATC_SOCKET: sock, ATC_OUTBOX: outbox },
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited,
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it removes the outbox file of a report the bridge took', async () => {
  using bridge = setupTest((request) => [{ id: request['id'], ok: true }, { ev: 'InboxClosed' }]);

  writeFileSync(
    join(bridge.outbox, 'r1.json'),
    JSON.stringify({ reportID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const code = await bridge.runTap();

  expect(code).toBe(0);
  expect(existsSync(join(bridge.outbox, 'r1.json'))).toBeFalse();
});

test('it removes no file for an answer to a report id it never sent', async () => {
  using bridge = setupTest(() => [{ id: 'report:../victim', ok: true }, { ev: 'InboxClosed' }]);

  writeFileSync(join(bridge.dir, 'victim.json'), '{}');

  writeFileSync(
    join(bridge.outbox, 'r1.json'),
    JSON.stringify({ reportID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  const code = await bridge.runTap();

  expect(code).toBe(0);
  expect(existsSync(join(bridge.dir, 'victim.json'))).toBeTrue();
  expect(existsSync(join(bridge.outbox, 'r1.json'))).toBeTrue();
});
