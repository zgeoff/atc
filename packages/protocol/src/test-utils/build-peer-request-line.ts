import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { MessageType, serializeRequestMessage } from '@orpc/standard-server-peer';

const SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());

export function buildPeerRequestLine(
  id: string,
  path: string,
  input: unknown,
  headers: Readonly<Record<string, string>> = {},
): string {
  const message = serializeRequestMessage(id, MessageType.REQUEST, {
    url: new URL(`http://orpc${path}`),
    method: 'POST',
    headers: { ...headers },
    body: SERIALIZER.serialize(input),
  });

  return `${JSON.stringify(message)}\n`;
}
