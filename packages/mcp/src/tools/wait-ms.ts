import { z } from 'zod';

export const WAIT_MS = z.number().int().min(0).max(30_000).optional();
