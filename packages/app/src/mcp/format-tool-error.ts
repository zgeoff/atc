/**
 * The text a failed tool call or note read shows for an error. An error
 * that holds a lowercase protocol-style code, as every daemon error and a
 * router's refusal about a daemon do, reads as `<code>: <message>`. A
 * system error's uppercase code is already in its message, so it and any
 * other error read as the message alone.
 */
export function formatToolError(error: unknown): string {
  if (hasProtocolCode(error)) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function hasProtocolCode(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z][a-z_]*$/.test(error.code)
  );
}
