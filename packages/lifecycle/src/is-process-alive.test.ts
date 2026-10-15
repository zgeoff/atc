import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { registerTestCleanup, waitFor } from '@atc/test-utils';
import { isProcessAlive } from './is-process-alive';

test('it reports this process as running', () => {
  expect(isProcessAlive(process.pid)).toBeTrue();
});

test('it reports a process that exited as not running', async () => {
  const child = Bun.spawn(['true']);

  await child.exited;

  expect(isProcessAlive(child.pid)).toBeFalse();
});

// The zombie state and its thread count come from Linux's /proc, and the
// child loads glibc by its Linux name.
test.skipIf(process.platform !== 'linux')(
  'it reports a process whose main thread exited as running while another of its threads runs',
  async () => {
    // Once its worker thread runs, the main thread ends through pthread_exit,
    // which leaves the process a zombie in /proc while the worker runs on.
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { dlopen, FFIType } from 'bun:ffi';
const worker = new Worker(URL.createObjectURL(new Blob(['postMessage("up"); setInterval(() => {}, 1000);'])));
worker.onmessage = () => {
  dlopen('libc.so.6', { pthread_exit: { args: [FFIType.ptr], returns: FFIType.void } }).symbols.pthread_exit(null);
};`,
      ],
      { stdout: 'ignore', stderr: 'inherit' },
    );

    registerTestCleanup(async () => {
      child.kill('SIGKILL');

      await child.exited;
    });

    await waitFor(() => {
      const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');

      expect(stat.slice(stat.lastIndexOf(')') + 2)).toStartWith('Z ');
    });

    expect(isProcessAlive(child.pid)).toBeTrue();
  },
);

test('it reports a pid no process holds as not running', () => {
  expect(isProcessAlive(2 ** 22 + 12_345)).toBeFalse();
});
