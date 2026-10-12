// A slash, a command name that may hold a plugin namespace, at least one
// space, then the argument. A path such as `/tmp/out` has a slash after its
// first name, so it never matches.
const SLASH_COMMAND = /^(?<name>\/[A-Za-z0-9][\w:-]* +)(?<argument>.+)$/su;

/**
 * Splits a line that opens with a slash command and an argument into the
 * command name with the spaces after it, and the argument. A line that opens
 * with anything else, or holds a bare command whose argument is spaces
 * alone, finds nothing.
 */
export function findSlashCommand(text: string): { name: string; argument: string } | null {
  const groups = SLASH_COMMAND.exec(text)?.groups;
  const name = groups?.['name'];
  const argument = groups?.['argument'];

  if (name === undefined || argument === undefined || argument.trim() === '') {
    return null;
  }

  return { name, argument };
}
