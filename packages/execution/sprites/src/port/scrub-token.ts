export function scrubToken(message: string, token: string): string {
  return token === '' ? message : message.replaceAll(token, '[token]');
}
