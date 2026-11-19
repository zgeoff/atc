// Replaces every copy of the token in a message, so an error never carries it.
export function scrubToken(message: string, token: string): string {
  return token === '' ? message : message.replaceAll(token, '[token]');
}
