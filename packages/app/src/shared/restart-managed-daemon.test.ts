import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '../test-utils/create-stub-bin';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { restartManagedDaemon } from './restart-managed-daemon';

function setupTest() {
  return setupTempDir('atc-unit-restart-');
}

test('it asks the manager to restart the daemon unit', async () => {
  const ctx = setupTest();
  const calls = join(ctx.dir, 'calls');
  const bin = createStubBin(ctx.dir, 'systemctl', `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\n`);

  await restartManagedDaemon(bin);

  expect(readFileSync(calls, 'utf8')).toBe('--user\nrestart\natc-daemon.service\n');
});

test('it rejects a restart that the manager refuses', () => {
  const ctx = setupTest();
  const bin = createStubBin(ctx.dir, 'systemctl', '#!/bin/sh\necho unit-masked >&2\nexit 1\n');

  expect(restartManagedDaemon(bin)).rejects.toThrowWithMessage(
    Error,
    'systemctl --user restart atc-daemon.service failed: unit-masked',
  );
});
