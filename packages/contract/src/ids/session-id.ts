import type { z } from 'zod';

export type SessionID = string & z.$brand<'SessionID'>;
