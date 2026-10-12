/**
 * A JSON-RPC 2.0 error response body for the request with the given id, or
 * for no request when the id is null.
 */
export function buildRPCError(
  id: unknown,
  code: number,
  message: string,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
