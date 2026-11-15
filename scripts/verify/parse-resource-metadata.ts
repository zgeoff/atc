import { z } from 'zod';

const metadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
});

interface MetadataAnswer {
  readonly status: number;
  readonly json: unknown;
}

// The resource that the server at `origin` names in its protected-resource metadata, which an MCP
// client reads before it signs in; null unless it answered 200 with `<origin>/mcp` as the resource
// and `origin` among its authorization servers.
export function parseResourceMetadata(answer: MetadataAnswer, origin: string): string | null {
  const metadata = metadataSchema.safeParse(answer.json);

  if (
    answer.status !== 200 ||
    !metadata.success ||
    metadata.data.resource !== `${origin}/mcp` ||
    !metadata.data.authorization_servers.includes(origin)
  ) {
    return null;
  }

  return metadata.data.resource;
}
