export function buildStubMCPStdioServer(replies: readonly string[]): string {
  const answers = replies
    .map((reply) => `read -r _ || exit 0\nprintf '%s\\n' ${toShellLiteral(reply)}\n`)
    .join('');

  // The rename makes the pid file appear whole.
  return `#!/usr/bin/env bash\necho $$ > "$0.pid.tmp"\nmv "$0.pid.tmp" "$0.pid"\n${answers}exec cat > /dev/null\n`;
}

// Quotes a value for the shell as one word, whatever it holds.
function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
