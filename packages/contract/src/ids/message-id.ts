import type { z } from 'zod';

export type MessageID = string & z.$brand<'MessageID'>;
