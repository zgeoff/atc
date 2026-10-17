// a TUI that reads input a line at a time takes the newline as the submit key.
export function planTypedLineInput(text: string): readonly string[] {
  return [`${text}\n`];
}
