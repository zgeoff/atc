interface StubGHReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface StubGHOptions {
  // What each command prints and exits with, keyed by its first argument,
  // such as `repo` or `config`; `hang` waits until the command is killed.
  // A command without a reply prints nothing and exits 0.
  readonly replies: Readonly<Record<string, StubGHReply | 'hang'>>;

  // A file each run appends its arguments to, as one line.
  readonly argvFile?: string;
}

/**
 * The script of a stand-in `gh` that answers each command with the reply
 * the test gave for its first argument: the stdout and stderr verbatim,
 * then the exit code, 0 when unset. A `hang` reply waits until it is
 * killed, as a gh that never answers does.
 */
export function buildStubGH(options: StubGHOptions): string {
  const record =
    options.argvFile === undefined
      ? ''
      : `printf '%s\\n' "$*" >> ${toShellLiteral(options.argvFile)}\n`;

  const cases = Object.entries(options.replies)
    .map(([command, reply]) => `  ${toShellLiteral(command)}) ${renderReply(reply)} ;;\n`)
    .join('');

  return `#!/bin/sh\n${record}case "$1" in\n${cases}esac\n`;
}

function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function renderReply(reply: StubGHReply | 'hang'): string {
  if (reply === 'hang') {
    return 'exec sleep 30';
  }

  return [
    `printf '%s' ${toShellLiteral(reply.stdout ?? '')}`,
    `printf '%s' ${toShellLiteral(reply.stderr ?? '')} >&2`,
    `exit ${reply.exitCode ?? 0}`,
  ].join('; ');
}
