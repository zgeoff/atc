import { isRecord } from '../src/shared/report';

interface JSONBody {
  readonly json: () => Promise<unknown>;
}

/**
 * Reads a response body as a JSON object, for tests asserting on an HTTP
 * endpoint's payload. Throws when the body is any other JSON value, so a
 * malformed response fails the test instead of passing it vacuously.
 */
export async function readJSONRecord(response: JSONBody): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();

  if (!isRecord(body) || Array.isArray(body)) {
    throw new TypeError('response body is not a JSON object');
  }

  return body;
}
