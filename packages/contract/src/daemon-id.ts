import type { z } from 'zod';

export type DaemonID = string & z.$brand<'DaemonID'>;
