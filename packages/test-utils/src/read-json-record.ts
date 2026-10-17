import { isRecord } from '@atc/core';

interface JSONBody {
  readonly json: () => Promise<unknown>;
}

export async function readJSONRecord(response: JSONBody): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();

  if (!isRecord(body) || Array.isArray(body)) {
    throw new TypeError('response body is not a JSON object');
  }

  return body;
}
