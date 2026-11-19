import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

export const PEER_SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());
