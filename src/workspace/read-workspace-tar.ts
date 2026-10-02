type TarOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'tar_failed'; readonly message: string };

interface WorkspaceTar {
  readonly stream: ReadableStream<Uint8Array>;
  readonly done: Promise<TarOutcome>;
}

/**
 * Streams an uncompressed tar of a directory, `.git` included, with entries
 * relative to the directory. The archive is read as it is produced and never
 * written to disk. A failure partway through still ends the stream, so a
 * consumer drains it and then awaits the outcome before trusting what it
 * received.
 */
export function readWorkspaceTar(dir: string): WorkspaceTar {
  const proc = Bun.spawn(['tar', '-c', '-f', '-', '-C', dir, '.'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const done = (async (): Promise<TarOutcome> => {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    return exitCode === 0
      ? { ok: true }
      : { ok: false, code: 'tar_failed', message: stderr.trim() };
  })();

  return { stream: proc.stdout, done };
}
