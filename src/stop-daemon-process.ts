import { isProcessAlive } from './shared/is-process-alive';

const EXIT_WAIT_MS = 10_000;

/**
 * Sends SIGTERM to the daemon and waits up to 10 s for it to exit, then
 * sends SIGKILL when it is still running. Resolves `killed` when SIGKILL was
 * needed and `exited` when SIGTERM was enough.
 */
export async function stopDaemonProcess(pid: number): Promise<'exited' | 'killed'> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'exited';
  }

  const exited = await waitForExit(pid, EXIT_WAIT_MS);

  if (exited) {
    return 'exited';
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return 'exited';
  }

  await waitForExit(pid, EXIT_WAIT_MS);

  return 'killed';
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    await Bun.sleep(50);
  }

  return !isProcessAlive(pid);
}
