import { StandardRPCCodec } from '@orpc/server/standard';
import { PEER_SERIALIZER } from './peer-serializer';

// The codec the daemon's handler runs every procedure through.
export const PEER_CODEC = new StandardRPCCodec(PEER_SERIALIZER);
