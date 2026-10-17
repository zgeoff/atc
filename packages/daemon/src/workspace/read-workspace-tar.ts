type TarOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'tar_failed'; readonly message: string };

interface WorkspaceTar {
  readonly stream: ReadableStream<Uint8Array>;
  readonly done: Promise<TarOutcome>;
}

// a failure partway through still ends the stream, so a consumer drains it and then awaits
// the outcome before trusting what it received
export function readWorkspaceTar(dir: string): WorkspaceTar {
  // a host's TAR_OPTIONS could follow symlinks out of the directory or leave files out
  const { TAR_OPTIONS: _ignored, ...env } = process.env;

  const proc = Bun.spawn(['tar', '-c', '-f', '-', '-C', dir, '.'], {
    env,
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
