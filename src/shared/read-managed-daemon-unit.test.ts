import { expect, test } from 'bun:test';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { readManagedDaemonUnit } from './read-managed-daemon-unit';

function setupTest() {
  return setupTempDir('atc-managed-unit-');
}

test('it treats an installed inactive user unit as managed', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'atc-daemon.service');

  writeFileSync(path, '[Service]\nExecStart=atc daemon\n');

  expect(readManagedDaemonUnit([ctx.dir])).toBe(path);
});

test('it leaves an unrelated unit outside daemon ownership', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'other.service'), '[Service]\nExecStart=true\n');

  expect(readManagedDaemonUnit([ctx.dir])).toBeNull();
});

test('it preserves ownership when a user unit is masked', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'atc-daemon.service');

  symlinkSync('/dev/null', path);

  expect(readManagedDaemonUnit([ctx.dir])).toBe(path);
});
