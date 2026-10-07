/**
 * The script of a stand-in `atc mcp` server on stdio that answers each line
 * it reads with the next of `replies`, printed as given, whether JSON or
 * not, and reads stdin without answering once the replies run out. It
 * exits without a reply when stdin ends before a line arrives. Before
 * it reads anything, it records its pid in the file at its own path with
 * `.pid` appended, moving the file into place so it appears whole.
 */
export function buildStubMCPStdioServer(replies: readonly string[]): string {
  const answers = replies
    .map((reply) => `read -r _ || exit 0\nprintf '%s\\n' ${toShellLiteral(reply)}\n`)
    .join('');

  return `#!/usr/bin/env bash\necho $$ > "$0.pid.tmp"\nmv "$0.pid.tmp" "$0.pid"\n${answers}exec cat > /dev/null\n`;
}

// Quotes a value for the shell as one word, whatever it holds.
function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
