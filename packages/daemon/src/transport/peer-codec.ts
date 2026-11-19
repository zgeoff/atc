import { StandardRPCCodec } from '@orpc/server/standard';
import { PEER_SERIALIZER } from './peer-serializer';

export const PEER_CODEC = new StandardRPCCodec(PEER_SERIALIZER);
