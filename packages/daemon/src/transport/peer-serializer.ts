import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

// The serializer that reads a peer request's body and writes its answer.
export const PEER_SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());
