import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { StandardRPCCodec } from '@orpc/server/standard';

// The serializer that reads a peer request's body and writes its answer.
export const PEER_SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// The codec the daemon's handler runs every procedure through.
export const PEER_CODEC = new StandardRPCCodec(PEER_SERIALIZER);
