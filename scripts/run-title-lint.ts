interface TitleLint {
  readonly title: string;

  // The commitlint binary to run.
  readonly commitlint: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// The title reaches commitlint on stdin, never through the shell, so a crafted title cannot
// inject a command; the answer is commitlint's exit code.
export function runTitleLint(lint: TitleLint): Promise<number> {
  const linting = Bun.spawn([lint.commitlint, '--verbose'], {
    stdin: new Response(`${lint.title}\n`),
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...lint.env },
  });

  return linting.exited;
}

if (import.meta.main) {
  const exitCode = await runTitleLint({
    title: process.env['TITLE'] ?? '',
    commitlint: 'node_modules/.bin/commitlint',
    env: process.env,
  });

  process.exit(exitCode);
}
