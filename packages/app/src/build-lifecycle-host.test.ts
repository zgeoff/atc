import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '@atc/core/system-clock';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildLifecycleHost } from './build-lifecycle-host';

test('it builds the paths, the /proc root, and the restore boot time from the environment', () => {
  const host = buildLifecycleHost({
    HOME: '/home/u',
    XDG_RUNTIME_DIR: '/run/user/1000',
    ATC_PROC_ROOT: '/tmp/proc',
    ATC_RESTORE_BOOT_TIMEOUT_MS: '500',
  });

  expect(host.paths.daemonSocketPath).toBe('/run/user/1000/atc-daemon.sock');
  expect(host.paths.stateDir).toBe('/home/u/.local/state/atc');
  expect(host.procRoot).toBe('/tmp/proc');
  expect(host.restoreBootTimeoutMs).toBe(500);
  expect(host.clock).toBe(systemClock);
});

test('it finds the user unit in the unit directories the environment gives', () => {
  const tmp = setupTempDir('atc-lifecycle-host-');
  const path = join(tmp.dir, 'atc-daemon.service');

  writeFileSync(path, '[Service]\nExecStart=atc daemon\n');

  const host = buildLifecycleHost({ HOME: '/home/u', SYSTEMD_UNIT_PATH: tmp.dir });

  expect(host.findManagedUnit()).toBe(path);
});

test('it reads /proc and the default restore boot time when the environment sets neither', () => {
  const host = buildLifecycleHost({ HOME: '/home/u' });

  expect(host.procRoot).toBe('/proc');
  expect(host.restoreBootTimeoutMs).toBe(15_000);
});
