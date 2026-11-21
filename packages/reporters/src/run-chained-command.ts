const CHAINED_TIMEOUT_MS = 1500;

// Runs the user's own status line command and gives back its output. The command runs in a
// process group of its own: a child it leaves running, such as `sleep 10 &`, keeps stdout open
// past the shell's exit, so a timeout kills the whole group and stops reading.
export async function runChainedCommand(command: string, stdin: string): Promise<string> {
  const subprocess = Bun.spawn(['bash', '-c', command], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'ignore',
    detached: true,
  });

  let output = '';
  const reader = subprocess.stdout.getReader();

  const decoder = new TextDecoder();

  const timedOut = Promise.withResolvers<null>();

  const timer = setTimeout(() => {
    removeProcessGroup(subprocess.pid);

    timedOut.resolve(null);
  }, CHAINED_TIMEOUT_MS);

  for (;;) {
    const chunk = await Promise.race([reader.read(), timedOut.promise]);

    if (chunk === null || chunk.done) {
      break;
    }

    output += decoder.decode(chunk.value, { stream: true });
  }

  clearTimeout(timer);
  void cancelReader(reader);

  return output;
}

function removeProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

interface CancellableReader {
  readonly cancel: () => Promise<void>;
}

// a child that escaped the kill can keep the pipe open, so the reporter never waits on the cancel
async function cancelReader(reader: CancellableReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {}
}
