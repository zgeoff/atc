import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { readManagedDaemonUnit } from './read-managed-daemon-unit';

function setupTest() {
  return setupTempDir('atc-managed-unit-');
}

test('it treats an installed inactive user unit as managed', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'atc-daemon.service');

  writeFileSync(path, '[Service]\nExecStart=atc daemon\n');

  expect(readManagedDaemonUnit({ SYSTEMD_UNIT_PATH: ctx.dir })).toBe(path);
});

test('it leaves an unrelated unit outside daemon ownership', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'other.service'), '[Service]\nExecStart=true\n');

  expect(readManagedDaemonUnit({ SYSTEMD_UNIT_PATH: ctx.dir })).toBeNull();
});

test('it preserves ownership when a user unit is masked', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'atc-daemon.service');

  symlinkSync('/dev/null', path);

  expect(readManagedDaemonUnit({ SYSTEMD_UNIT_PATH: ctx.dir })).toBe(path);
});

test('it finds a unit in the user config directory of the home it is given', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, '.config', 'systemd', 'user', 'atc-daemon.service');

  mkdirSync(join(ctx.dir, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(path, '[Service]\nExecStart=atc daemon\n');

  expect(readManagedDaemonUnit({ HOME: ctx.dir })).toBe(path);
});
