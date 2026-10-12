import { expect, test } from 'bun:test';
import { systemClock } from '@atc/core/system-clock';
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

test('it reads /proc and the default restore boot time when the environment sets neither', () => {
  const host = buildLifecycleHost({ HOME: '/home/u' });

  expect(host.procRoot).toBe('/proc');
  expect(host.restoreBootTimeoutMs).toBe(15_000);
});
