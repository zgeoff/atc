import { z } from 'zod';

// The one field of the daemon record that a client outside atc reads.
export const DAEMON_RECORD_SOCKET_SCHEMA = z.object({ socketPath: z.string().min(1) });
