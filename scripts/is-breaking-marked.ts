const BREAKING_HEADER = /^[a-z]+(?:\([^)]*\))?!:/u;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/mu;

// release-please raises the major version for a Conventional Commit that holds `!` before its
// colon or a `BREAKING CHANGE:` footer.
export function isBreakingMarked(messages: readonly string[]): boolean {
  return messages.some(
    (message) => BREAKING_HEADER.test(message.trimStart()) || BREAKING_FOOTER.test(message),
  );
}
