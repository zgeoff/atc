import { closeSync, writeSync } from 'node:fs';

export const DAEMON_READY_FD_VARIABLE = 'ATC_DAEMON_READY_FD';

export function makeDaemonReadySignal(env: Record<string, string | undefined>): () => void {
  const value = env[DAEMON_READY_FD_VARIABLE];

  // Every session the daemon starts inherits its environment, and none of
  // them may write to the pipe of the client that started the daemon.
  Reflect.deleteProperty(env, DAEMON_READY_FD_VARIABLE);

  const fd = Number(value);

  if (value === undefined || !Number.isSafeInteger(fd) || fd < 3) {
    return () => {};
  }

  let signalled = false;

  return () => {
    if (signalled) {
      return;
    }

    signalled = true;

    // A client that gave up on the boot has closed its end of the pipe.
    try {
      writeSync(fd, 'ready\n');
    } catch {}

    try {
      closeSync(fd);
    } catch {}
  };
}
