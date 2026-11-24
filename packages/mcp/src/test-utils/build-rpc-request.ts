import { CONTRACT_MAJOR } from '@atcx/contract/light';

interface RPCRequestOptions {
  readonly host?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;

  // The part after the path, such as `?token=abc`.
  readonly search?: string;
}

// A POST to a fleet procedure as an oRPC client sends it: the input in the `json` field, the
// bearer, and the major version of this build.
export function buildRPCRequest(
  procedure: string,
  input: unknown,
  bearer: string | null,
  options: RPCRequestOptions = {},
): Request {
  return new Request(`http://gateway.test/rpc/${procedure}${options.search ?? ''}`, {
    method: 'POST',
    headers: {
      host: options.host ?? 'gateway.test',
      'content-type': 'application/json',
      'x-atc-major': String(CONTRACT_MAJOR),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...options.headers,
    },
    body: JSON.stringify({ json: input }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
