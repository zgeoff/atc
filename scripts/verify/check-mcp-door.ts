import { WringerError } from '@wringer/core';
import type { HttpClient } from '@wringer/http';
import { resourceMetadataPath } from './constants.ts';
import { parseResourceMetadata } from './parse-resource-metadata.ts';

export async function checkMCPDoor(
  http: Pick<HttpClient, 'request'>,
  origin: string,
): Promise<{ resource: string }> {
  const answer = await http.request({ method: 'GET', path: resourceMetadataPath });

  const resource = parseResourceMetadata(answer, origin);

  if (resource === null) {
    throw new WringerError('check-failed', {
      message: `${origin} answered ${String(answer.status)} on ${resourceMetadataPath}, where atc-gateway answers 200 with the resource ${origin}/mcp`,
      hint: `Check that ${origin} is the gateway's --public-url, then run \`bun verify doctor\` again.`,
    });
  }

  return { resource };
}
