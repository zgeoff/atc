// The answer of a gateway to a call that failed with an error code: the oRPC error body, with the
// status oRPC gives a code its error map names no status for.
export function buildStubGatewayError(code: string): Response {
  return Response.json(
    { json: { defined: true, code, status: 500, message: `${code} happened` } },
    { status: 500 },
  );
}
