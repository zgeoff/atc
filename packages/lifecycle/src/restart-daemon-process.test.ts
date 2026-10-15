import { expect, mock, test } from 'bun:test';
import { systemClock } from '@atc/core';
import { buildStubSkipClock, registerTestCleanup } from '@atc/test-utils';
import { restartDaemonProcess } from './restart-daemon-process';

test('it stops a daemon no unit runs with SIGTERM', async () => {
  const daemon = Bun.spawn(['sleep', '60']);

  registerTestCleanup(() => {
    daemon.kill('SIGKILL');
  });

  const runSystemctl = mock(() =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', aborted: false }),
  );

  const step = await restartDaemonProcess(
    { pid: daemon.pid, unit: null },
    { clock: systemClock, runSystemctl },
  );

  await daemon.exited;

  expect(step).toStrictEqual({ kind: 'stopped', killed: false });
  expect(daemon.signalCode).toBe('SIGTERM');
  expect(runSystemctl).not.toHaveBeenCalled();
});

test('it kills a daemon that still runs once the wait after SIGTERM ends', async () => {
  // A shell that ignores SIGTERM and says so once the trap is in place.
  const daemon = Bun.spawn(['bash', '-c', 'trap "" TERM; echo ready; while :; do sleep 1; done'], {
    stdout: 'pipe',
  });

  registerTestCleanup(() => {
    daemon.kill('SIGKILL');
  });

  await daemon.stdout.getReader().read();

  const step = await restartDaemonProcess(
    { pid: daemon.pid, unit: null },
    {
      clock: buildStubSkipClock(),
      runSystemctl: () => Promise.resolve({ code: 0, stdout: '', stderr: '', aborted: false }),
    },
  );

  await daemon.exited;

  expect(step).toStrictEqual({ kind: 'stopped', killed: true });
  expect(daemon.signalCode).toBe('SIGKILL');
});

test('it restarts the unit that runs the daemon and leaves the daemon to it', async () => {
  const daemon = Bun.spawn(['sleep', '60']);

  registerTestCleanup(() => {
    daemon.kill('SIGKILL');
  });

  const runSystemctl = mock(() =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', aborted: false }),
  );

  const step = await restartDaemonProcess(
    { pid: daemon.pid, unit: 'atc-daemon.service' },
    { clock: systemClock, runSystemctl },
  );

  expect(step).toStrictEqual({ kind: 'unit' });
  expect(runSystemctl).toHaveBeenCalledExactlyOnceWith(['restart', 'atc-daemon.service']);
  expect(() => process.kill(daemon.pid, 0)).not.toThrow();
});

test('it rejects with the service manager output when the unit fails to restart', () => {
  expect(
    restartDaemonProcess(
      { pid: 2 ** 22 + 1, unit: 'atc-daemon.service' },
      {
        clock: systemClock,
        runSystemctl: () =>
          Promise.resolve({ code: 1, stdout: '', stderr: 'unit-masked', aborted: false }),
      },
    ),
  ).rejects.toThrowWithMessage(Error, 'systemctl restart atc-daemon.service failed: unit-masked');
});
