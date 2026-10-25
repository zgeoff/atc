import { z } from 'zod';
import type { DaemonID } from './daemon-id';

const DAEMON_ID_SCHEMA = z.string().brand<'DaemonID'>();

export function toDaemonID(id: string): DaemonID {
  return DAEMON_ID_SCHEMA.parse(id);
}
