export function formatToolError(error: unknown): string {
  if (hasProtocolCode(error)) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function hasProtocolCode(error: unknown): error is Error & { readonly code: string } {
  // only a lowercase code is shown: a system error's uppercase code is already in its
  // message.
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z][a-z_]*$/u.test(error.code)
  );
}
