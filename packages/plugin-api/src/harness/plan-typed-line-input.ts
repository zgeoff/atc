/**
 * Types a line the way a terminal user does: the text and a newline in one
 * write. A TUI that reads input a line at a time takes the newline as the
 * submit key.
 */
export function planTypedLineInput(text: string): readonly string[] {
  return [`${text}\n`];
}
