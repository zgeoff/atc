interface StubGHReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface StubGHOptions {
  readonly replies: Readonly<Record<string, StubGHReply | 'hang'>>;

  readonly argvFile?: string;
}

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
